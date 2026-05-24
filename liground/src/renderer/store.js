import Vue from 'vue'
import Vuex from 'vuex'
import ffish from 'ffish'
import { engine, Engine } from './engine'
import allEngines from './store/engines'
import { createReviewRequest, emptyReviewState, emptyReviewSequenceState, REVIEW_MARKER_MODES, REVIEW_MODES } from '../shared/review/schema'
import { analyzeReviewRequest } from '../shared/review/reviewService'

import moveAudio from './assets/audio/Move.mp3'
import captureAudio from './assets/audio/Capture.mp3'

Vue.use(Vuex)

let ipcRenderer
try {
  ipcRenderer = (typeof window !== 'undefined' && window.require) ? window.require('electron').ipcRenderer : require('electron').ipcRenderer
} catch (err) {
  ipcRenderer = null
}

const MIN_CACHE_DEPTH = 20
let lastCacheKey = null

class TwoWayMap {
  constructor (map) {
    this.map = map
    this.reverseMap = {}
    this.keys = []
    for (const key in map) {
      const value = map[key]
      this.reverseMap[value] = key
      this.keys.concat(key)
    }
  }

  getAll () { return this.map }
  get (key) { return this.map[key] }
  revGet (key) { return this.reverseMap[key] }
}

/**
 * Calculate the value for current side to move.
 * @param {number} value CP or Mate value
 * @param {boolean} sideToMove Current side to move (true = white)
 */
function calcForSide (value, sideToMove) {
  return sideToMove ? value : -value
}

/**
 * Convert a CP value to a display string.
 * @param {number} cp CP value
 */
function cpToString (cp) {
  if (isNaN(cp)) {
    return ''
  }
  if (cp === 0) {
    return '0.00'
  }
  const normalizedEval = (cp / 100).toFixed(2)
  if (cp > 0) {
    return `+${normalizedEval}`
  } else {
    return normalizedEval
  }
}

/**
 * Normalize WDL information into fractional values.
 * Accepts either {wdlWin, wdlDraw, wdlLoss} or wdl array [w, d, l].
 * @param {any} mv Multipv line or payload
 * @returns {{win: number, draw: number, loss: number} | null}
 */
function normalizeWdl (mv) {
  if (!mv) return null
  const hasRatios = mv.wdlWin !== undefined || mv.wdlDraw !== undefined || mv.wdlLoss !== undefined
  if (hasRatios) {
    const win = Number(mv.wdlWin)
    const draw = Number(mv.wdlDraw)
    const loss = Number(mv.wdlLoss)
    if (Number.isFinite(win) && Number.isFinite(draw) && Number.isFinite(loss)) {
      return { win, draw, loss }
    }
  }
  if (Array.isArray(mv.wdl) && mv.wdl.length >= 3) {
    const win = Number(mv.wdl[0])
    const draw = Number(mv.wdl[1])
    const loss = Number(mv.wdl[2])
    const sum = win + draw + loss
    if (Number.isFinite(sum) && sum > 0) {
      return { win: win / sum, draw: draw / sum, loss: loss / sum }
    }
  }
  return null
}

/**
 * Strip halfmove/fullmove counters from a FEN string for caching.
 * @param {string} fen Full FEN string
 */
function normalizeFen (fen) {
  if (typeof fen !== 'string') {
    return ''
  }
  const parts = fen.trim().split(/\s+/)
  if (parts.length >= 6) {
    return parts.slice(0, parts.length - 2).join(' ')
  }
  return parts.join(' ')
}

function normalizedMoveLineFromHistory (moves) {
  if (!Array.isArray(moves) || moves.length === 0) return ''
  const line = []
  let node = moves[moves.length - 1]
  while (node) {
    if (node.uci) line.push(node.uci)
    node = node.prev
  }
  return line.reverse().join(' ')
}

function buildPositionCommand (gameState) {
  const safeFen = typeof gameState.fen === 'string' ? gameState.fen.trim() : ''
  const safeStartFen = typeof gameState.startFen === 'string' ? gameState.startFen.trim() : ''
  const moves = Array.isArray(gameState.moves) ? gameState.moves : []
  const variant = gameState.variant || 'chess'
  const is960 = !!gameState.is960
  const moveLine = normalizedMoveLineFromHistory(moves)
  if (!safeStartFen) {
    throw new Error('Invalid GameState: missing startFen. Refusing to fallback to startpos.')
  }
  // Reconstruct authoritative position from startFen + move history.
  let reconstructedFen = safeStartFen
  if (moveLine) {
    try {
      const board = is960 ? new ffish.Board(variant, safeStartFen, true) : new ffish.Board(variant, safeStartFen)
      for (const mv of moveLine.split(/\s+/).filter(Boolean)) {
        board.push(mv)
      }
      reconstructedFen = board.fen()
    } catch (err) {
      throw new Error(`Failed to reconstruct position from GameState: ${err.message}`)
    }
  }
  if (safeFen && normalizeFen(safeFen) !== normalizeFen(reconstructedFen)) {
    throw new Error(`[GameState] fen mismatch detected: live=${safeFen} reconstructed=${reconstructedFen}`)
  }
  return `position fen ${reconstructedFen}`
}

function reviewMoveToOverlaySquares (move) {
  if (typeof move !== 'string') return null
  if (move.includes('@')) {
    const dest = move.split('@')[1]
    return dest ? { square: dest } : null
  }
  const match = move.match(/^([a-i]\d{1,2})([a-i]\d{1,2})/)
  if (!match) return null
  return { orig: match[1], dest: match[2] }
}

function normalizeReviewLegalMoves (legalMoves) {
  if (Array.isArray(legalMoves)) return legalMoves.filter(Boolean)
  return String(legalMoves || '').split(/\s+/).filter(Boolean)
}

function resolveReviewSequenceMove (legalMoves, move) {
  if (!move) return null
  const candidates = normalizeReviewLegalMoves(legalMoves)
  if (candidates.includes(move)) return move
  if (move.includes('@')) return null
  const promotionMatches = candidates.filter(candidate => candidate && candidate.startsWith(move) && candidate.length > move.length)
  if (promotionMatches.length === 0) return null
  return promotionMatches.find(candidate => candidate.endsWith('q')) || promotionMatches[0]
}


function reviewLinePrefixLength (previousLine, nextLine) {
  if (!Array.isArray(previousLine) || !Array.isArray(nextLine)) return 0
  let idx = 0
  while (idx < previousLine.length && idx < nextLine.length && previousLine[idx] === nextLine[idx]) idx++
  return idx
}

function shouldDisplayReviewMoveForMarkerMode (ply, markerMode) {
  if (markerMode === REVIEW_MARKER_MODES.FIRST_MOVE_ONLY) return ply === 1
  if (markerMode === REVIEW_MARKER_MODES.OPPONENT_MOVES_ONLY) return ply % 2 === 0
  if (markerMode === REVIEW_MARKER_MODES.BOTH_SIDES) return true
  return ply % 2 === 1
}

function mergedReviewClassification (moves) {
  const order = ['blunder', 'mistake', 'inaccuracy', 'needs_care', 'interesting_risk', 'attacking_try', 'complexity', 'practical', 'natural', 'good', 'excellent']
  const sorted = moves.slice().sort((a, b) => {
    const left = order.includes(a.classification) ? order.indexOf(a.classification) : order.length
    const right = order.includes(b.classification) ? order.indexOf(b.classification) : order.length
    return left - right
  })
  return sorted[0] || null
}

function mergeIncrementalReviewResult ({ previous, suffix, fullLine, fullSans, markerMode, prefixLength, requestContext }) {
  const priorMoves = Array.isArray(previous.moves) ? previous.moves.slice(0, prefixLength) : []
  const suffixMoves = Array.isArray(suffix.moves)
    ? suffix.moves.map(move => {
      const ply = prefixLength + move.ply
      return {
        ...move,
        ply,
        side: ply % 2 === 1 ? 'user' : 'opponent',
        sideLabel: ply % 2 === 1 ? '내 수' : '상대 수',
        previewLine: fullLine.slice(0, ply)
      }
    })
    : []
  const moves = priorMoves.concat(suffixMoves)
  const markerMoves = moves.filter(move => shouldDisplayReviewMoveForMarkerMode(move.ply, markerMode))
  const summaryMove = mergedReviewClassification(markerMoves.length ? markerMoves : moves)
  const recentCount = suffixMoves.length
  return {
    ...suffix,
    fen: previous.fen,
    reviewedMove: fullLine[0] || suffix.reviewedMove,
    reviewedLine: fullLine,
    moveSan: Array.isArray(fullSans) ? fullSans[0] : suffix.moveSan,
    markerMode,
    markerModeLabel: suffix.markerModeLabel || previous.markerModeLabel,
    moves,
    markerMoves,
    classification: summaryMove ? summaryMove.classification : suffix.classification,
    classificationLabel: summaryMove ? summaryMove.classificationLabel : suffix.classificationLabel,
    summary: `현재 기보 ${fullLine.length}수까지의 흐름입니다. 이전 ${prefixLength}수 분석은 유지하고, 최근 ${recentCount}수를 추가 엔진 확인해 전략 해설에 연결했습니다. ${summaryMove ? `${summaryMove.ply}수 ${summaryMove.sideLabel} ${summaryMove.move}가 현재 가장 중요한 확인 지점입니다.` : ''}`,
    requestContext: {
      ...(previous.requestContext || {}),
      ...(requestContext || {}),
      incremental: true,
      prefixLength,
      source: requestContext && requestContext.source ? requestContext.source : 'realtime-played-line'
    },
    engineEvidence: {
      ...(suffix.engineEvidence || {}),
      incremental: true,
      prefixLength,
      perMoveCount: moves.length
    },
    overlays: markerMoves.slice(-6).flatMap(move => Array.isArray(move.overlays) ? move.overlays : []),
    risks: markerMoves.flatMap(move => Array.isArray(move.risks) ? move.risks : []).slice(-4),
    keyMoments: (Array.isArray(previous.keyMoments) ? previous.keyMoments : []).concat((Array.isArray(suffix.keyMoments) ? suffix.keyMoments : []).map(moment => ({ ...moment, ply: prefixLength + moment.ply }))).slice(-8),
    generatedAt: Date.now()
  }
}


function suffixOnlyReviewResultFromFull ({ result, prefixLength }) {
  if (!result || !prefixLength) return result
  const adjustMove = move => {
    const ply = move.ply - prefixLength
    return {
      ...move,
      ply,
      previewLine: Array.isArray(move.previewLine) ? move.previewLine.slice(prefixLength) : move.previewLine
    }
  }
  const adjustMoment = moment => ({ ...moment, ply: moment.ply - prefixLength })
  return {
    ...result,
    moves: Array.isArray(result.moves) ? result.moves.filter(move => move && move.ply > prefixLength).map(adjustMove) : [],
    markerMoves: Array.isArray(result.markerMoves) ? result.markerMoves.filter(move => move && move.ply > prefixLength).map(adjustMove) : [],
    keyMoments: Array.isArray(result.keyMoments) ? result.keyMoments.filter(moment => moment && moment.ply > prefixLength).map(adjustMoment) : []
  }
}


function enrichReviewMovePreviewFens (result, variant, is960, previousResult = null) {
  if (!result || !Array.isArray(result.moves) || !result.fen) return result
  const previousMoves = previousResult && Array.isArray(previousResult.moves) ? previousResult.moves : []
  const previousByPly = new Map(previousMoves.filter(Boolean).map(move => [move.ply, move]))
  const missing = result.moves.filter(move => move && move.move && !previousByPly.get(move.ply))
  if (missing.length === 0 && result.moves.every(move => move && move.previewFen)) return result
  let board
  let startIdx = 0
  try {
    // Fast path for incremental replay extension: continue from last known preview FEN
    const prevLast = previousMoves.length ? previousMoves[previousMoves.length - 1] : null
    const resultExtendsPrevious = Boolean(
      prevLast &&
      previousMoves.length < result.moves.length &&
      previousMoves.every((move, idx) => result.moves[idx] && result.moves[idx].move === move.move) &&
      prevLast.previewFen
    )
    if (resultExtendsPrevious) {
      board = is960 ? new ffish.Board(variant, prevLast.previewFen, true) : new ffish.Board(variant, prevLast.previewFen)
      startIdx = previousMoves.length
    } else {
      board = is960 ? new ffish.Board(variant, result.fen, true) : new ffish.Board(variant, result.fen)
    }
  } catch (err) {
    return result
  }
  const previewByPly = {}
  for (let idx = startIdx; idx < result.moves.length; idx++) {
    const move = result.moves[idx]
    if (!move || !move.move) continue
    if (previousByPly.has(move.ply) && previousByPly.get(move.ply).previewFen) {
      previewByPly[move.ply] = previousByPly.get(move.ply).previewFen
      continue
    }
    try {
      board.push(move.move)
      previewByPly[move.ply] = board.fen()
    } catch (err) {
      break
    }
  }
  const enrich = move => move && previewByPly[move.ply] ? { ...move, previewFen: previewByPly[move.ply] } : move
  return {
    ...result,
    moves: result.moves.map(enrich),
    markerMoves: Array.isArray(result.markerMoves) ? result.markerMoves.map(enrich) : result.markerMoves
  }
}

const MAX_REVIEW_RESULTS_CACHE = 40
let replaySessionSeq = 0
let singleMoveRecheckSeq = 0
let realtimeStaleDiscardCount = 0
let realtimeFallbackClassificationCount = 0

function replayTrace (debugEnabled, event, payload = {}) {
  if (!debugEnabled) return
  console.debug(`[replay-sm] ${event}`, payload)
}


// Realtime commentary owns only the latest played move on the live board.
// Rich review markers remain available in review panels and hover previews.
function primaryRealtimeBoardOverlays (result, overlays, arrowsEnabled, currentFen) {
  if (!result || arrowsEnabled === false) return []
  const resultContext = result.requestContext || {}
  if (resultContext.currentFen && currentFen && resultContext.currentFen !== currentFen) return []
  const reviewedLine = Array.isArray(result.reviewedLine) ? result.reviewedLine : []
  const latestPly = reviewedLine.length
  if (!latestPly) return []
  const unique = new Set()
  return (Array.isArray(overlays) ? overlays : [])
    .filter(overlay => overlay && overlay.id === `move-marker-${latestPly}` && overlay.kind === 'arrow')
    .filter((overlay) => {
      const key = `${overlay.id}|${overlay.orig || ''}|${overlay.dest || ''}|${overlay.square || ''}|${overlay.label || ''}`
      if (unique.has(key)) return false
      unique.add(key)
      return true
    })
    .slice(0, 1)
    .map(overlay => ({ ...overlay, source: 'realtime-current-move' }))
}

function previewOverlaysForMove (move) {
  if (!move) return []
  const overlays = Array.isArray(move.overlays) ? move.overlays.slice(0, 6).map(overlay => ({ ...overlay, source: 'review-preview' })) : []
  const sq = reviewMoveToOverlaySquares(move.move)
  if (sq && sq.orig && sq.dest) {
    overlays.push({
      id: `hover-preview-move-${move.ply}`,
      kind: 'arrow',
      orig: sq.orig,
      dest: sq.dest,
      brush: move.tone === 'critical' ? 'red' : (move.tone === 'practical' ? 'yellow' : 'green'),
      label: move.classificationLabel,
      modifiers: { lineWidth: move.tone === 'critical' ? 7 : 5 },
      source: 'review-preview'
    })
    overlays.push({
      id: `hover-preview-target-${move.ply}`,
      kind: 'highlight',
      square: sq.dest,
      brush: move.tone === 'critical' ? 'red' : (move.tone === 'practical' ? 'yellow' : 'green'),
      label: '착점',
      modifiers: { lineWidth: 4 },
      source: 'review-preview'
    })
  }
  const responseMove = move.punishmentMove || (typeof move.bestPv === 'string' ? move.bestPv.split(/\s+/).filter(Boolean)[0] : '')
  const response = responseMove && responseMove !== move.move ? reviewMoveToOverlaySquares(responseMove) : null
  if (response && response.orig && response.dest) {
    overlays.push({
      id: `hover-preview-response-${move.ply}`,
      kind: 'arrow',
      orig: response.orig,
      dest: response.dest,
      brush: move.tone === 'critical' || move.severity === 'blunder' || move.severity === 'mistake' ? 'red' : 'yellow',
      label: move.punishmentMove ? '응징' : '응수',
      modifiers: { lineWidth: move.tone === 'critical' ? 8 : 6 },
      source: 'review-preview'
    })
    overlays.push({
      id: `hover-preview-response-target-${move.ply}`,
      kind: 'danger',
      square: response.dest,
      brush: move.tone === 'critical' ? 'red' : 'yellow',
      label: '압박',
      modifiers: { lineWidth: 4 },
      source: 'review-preview'
    })
  }
  return overlays
}

function buildReviewSequenceOverlays (line) {
  const circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫']
  return (Array.isArray(line) ? line : []).map((move, idx) => {
    const sq = reviewMoveToOverlaySquares(move)
    if (!sq) return null
    const base = {
      id: `review-sequence-${idx}`,
      kind: sq.orig && sq.dest ? 'arrow' : 'highlight',
      brush: idx % 2 === 0 ? 'yellow' : 'blue',
      label: circled[idx] || String(idx + 1),
      modifiers: { lineWidth: Math.max(2, 6 - idx * 0.4), opacity: Math.max(0.35, 0.85 - idx * 0.04) },
      explanationId: 'sequence-path',
      priority: 20,
      source: 'review-sequence'
    }
    return sq.orig && sq.dest ? { ...base, orig: sq.orig, dest: sq.dest } : { ...base, square: sq.square }
  }).filter(Boolean)
}

/**
 * Check if an option value is valid and emit warnings if necessary.
 * @param {any[]} options Array of engine options
 * @param {string} name Name of option
 * @param {any} value Option value to check
 */
function checkOption (options, name, value) {
  const option = options.find(e => e.name === name)
  if (!option) {
    console.warn(`[Engine] Unknown option "${name}"`)
  } else {
    switch (option.type) {
      case 'check':
        if (typeof value !== 'boolean') {
          console.warn(`[Engine] Invalid value type "${value}" for check option "${name}"`)
        }
        break
      case 'spin':
        if (typeof value !== 'number') {
          console.warn(`[Engine] Invalid value "${value}" for spin option "${name}"`)
        } else if (typeof option.max === 'number' && value > option.max) {
          console.warn(`[Engine] Out of range value "${value}" for spin option "${name}" (range ${option.min} to ${option.max})`)
        } else if (typeof option.min === 'number' && value < option.min) {
          console.warn(`[Engine] Out of range value "${value}" for spin option "${name}" (range ${option.min} to ${option.max})`)
        }
        break
      case 'combo':
        if (typeof value !== 'string') {
          console.warn(`[Engine] Invalid value "${value}" for combo option "${name}"`)
        } else if (Array.isArray(option.var) && !option.var.includes(value)) {
          console.warn(`[Engine] Unknown value "${value}" for combo option "${name}" (values ${option.var.map(e => `"${e}"`).join(', ')})`)
        }
        break
      case 'button':
        if (value !== undefined && value !== null) {
          console.warn(`[Engine] Unexpected value "${value}" for button option "${name}"`)
        }
        break
      case 'string':
        if (typeof value !== 'string') {
          console.warn(`[Engine] Invalid value "${value}" for string option "${name}"`)
        }
        break
    }
  }
}

const filteredSettings = ['UCI_Variant', 'UCI_Chess960']

/**
 * Extract comments from PGN text
 * Parses PGN format comments like {this is a comment} and maps them to move indices
 * @param {string} pgnText The full PGN text
 * @returns {Object} Map of move index to comment text
 */
function extractCommentsFromPGN (pgnText) {
  const commentMap = {}
  // Skip header section and get moves section
  const headerEndIndex = pgnText.indexOf('\n\n')
  if (headerEndIndex === -1) {
    return commentMap
  }
  const movesSection = pgnText.substring(headerEndIndex + 2)
  // Split moves section into tokens
  const tokens = movesSection.split(/(\{[^}]*\}|\S+)/g).filter(t => t && t.trim())
  let moveIndex = 0
  let lastWasMove = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    // Skip move numbers and empty tokens
    if (token.match(/^\d+\.\.?$/) || !token.trim() || token === '*') {
      continue
    }
    // Check if this is a comment
    if (token.match(/^\{[^}]*\}$/)) {
      // Extract comment text without braces
      const commentText = token.replace(/^\{/, '').replace(/\}$/, '')
      // Associate comment with the current move (just played)
      if (lastWasMove) {
        commentMap[moveIndex - 1] = commentText
        lastWasMove = false
      }
    } else if (token.trim()) {
      // This is a move
      moveIndex++
      lastWasMove = true
    }
  }
  return commentMap
}
/* Helper to produce a `go` command from limiter configuration
** @param {Object} limiter Limiter configuration
*/
function limiterToGo (limiter) {
  if (!limiter || !limiter.enabled) return 'go movetime 1000'
  switch (limiter.type) {
    case 'time': return `go movetime ${parseInt(limiter.value, 10)}`
    case 'nodes': return `go nodes ${parseInt(limiter.value, 10) * 1000000}`
    case 'depth': return `go depth ${parseInt(limiter.value, 10)}`
    default: return `go movetime ${parseInt(limiter.value, 10) || 1000}`
  }
}
function sanitizeEngineMove (move) {
  return String(move || '').trim().split(/\s+/)[0] || ''
}

export const store = new Vuex.Store({
  state: {
    engineIndex: 1,
    enginesActive: [false],
    initialized: false,
    active: false,
    PvE: false,
    PvEPlayerIsWhite: true, // true when the human player controls White in PvE mode
    PvEParam: 'go movetime 1000',
    PvEValue: 'time',
    PvEInput: 1000,
    PvELimiter: null, // stores the limiter config for the PvE engine
    PvEEngineInstance: null,
    playVsEngineEnabled: false,
    playVsEngineHumanSide: 'white',
    engineTimeControlsEnabled: false,
    engineTimeControlMode: 'depth', // depth | movesInTime | increment | perMove
    engineTimeControlConfig: {
      movesInTime: { moves: 40, minutes: 5 },
      increment: { baseMinutes: 5, incrementSeconds: 3 },
      perMove: { seconds: 3 }
    },
    engineSideClockMs: null,
    resized: 0,
    resized9x9height: 0,
    resized9x9width: 0,
    resized9x10height: 0,
    resized9x10width: 0,
    dimNumber: 0,
    turn: true,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    normalizedFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
    lastFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', // to track the end of the current line
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    gameState: {
      startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      moves: [],
      sideToMove: 'white',
      variant: 'chess',
      clocks: {
        whiteTimeMs: null,
        blackTimeMs: null,
        whiteIncrementMs: 0,
        blackIncrementMs: 0
      },
      engineSettings: {}
    },
    moves: [],
    firstMoves: [],
    mainFirstMove: null,
    legalMoves: '',
    destinations: {},
    variant: 'chess',
    gameConfig: null,
    startGameModal: {
      whiteChoice: 'player',
      blackChoice: 'engine',
      selectedGameMode: 'chess',
      whiteEngineName: null,
      blackEngineName: null,
      whiteLimiterEnabled: true,
      whiteLimiterType: 'time',
      whiteLimiterValue: 1000,
      blackLimiterEnabled: true,
      blackLimiterType: 'time',
      blackLimiterValue: 1000,
      showEndGameModal: true
    },
    showGameEndModal: false,
    gameResult: null,
    // Engine-vs-Engine state
    EvE: false,
    EvEConfig: null,
    engineWhiteInstance: null,
    engineBlackInstance: null,
    variantOptions: new TwoWayMap({ // all the currently supported options are listed here, variantOptions.get returns the right side, variantOptions.revGet returns the left side of the dict
      Standard: 'chess',
      Crazyhouse: 'crazyhouse',
      'King of the Hill': 'kingofthehill',
      '️Three-Check': '3check',
      Antichess: 'antichess',
      Atomic: 'atomic',
      Horde: 'horde',
      'Racing Kings': 'racingkings',
      Makruk: 'makruk',
      Shogi: 'shogi',
      Janggi: 'janggi',
      'Janggi Modern': 'janggimodern',
      Xiangqi: 'xiangqi',
      Fischerandom: 'fischerandom'

    }),
    openedPGN: false,
    QuickTourIndex: 0,
    evalPlotDepth: 20,
    orientation: 'white',
    message: 'hello from Vuex',
    allEngines,
    activeEngine: null,
    selectedEngines: {},
    engineInfo: {
      name: '',
      author: '',
      options: []
    },
    engineSettings: {},
    nnueStatus: null,
    listOfEngineStats: [],
    engineStats: {
      depth: 0,
      isEvalCached: false,
      cachedDepth: -1,
      seldepth: 0,
      nodes: 0,
      nps: 0,
      hashfull: 0,
      tbhits: 0,
      time: 0
    },
    lastEngineStats: {
      depth: 0,
      seldepth: 0,
      nodes: 0,
      nps: 0,
      hashfull: 0,
      tbhits: 0,
      time: 0
    },
    enginetime: 0,
    lastWdlWin: null,
    lastWdlDraw: null,
    lastWdlLoss: null,
    multipv: [
      {
        cp: 0,
        pv: '',
        ucimove: ''
      }
    ],
    lastAnalysisResult: { cp: 0, mate: null, pv: '', ucimove: '', turn: true },
    numberOfEngines: [
      {
        number: 1
      }
    ],
    engineCounter: 1,
    singleMoveRequestSeq: 0,
    hoveredpv: -1,
    counter: 0,
    pieceStyle: 'cburnett',
    board: null,
    gameInfo: {},
    loadedGames: [],
    rounds: null,
    selectedGame: null,
    boardStyle: 'blue',
    curVar960Fen: '',
    viewAnalysis: true,
    analysisMode: true,
    editorMode: false,
    review: emptyReviewState(),
    analysisVisualization: {
      showMultiPvArrows: true,
      multiPvCount: 3,
      trajectoryEnabled: false,
      trajectorySideMode: 'both',
      trajectoryDepth: 12,
      trajectoryUnlimited: false,
      orderNumbers: true,
      orderThickness: true,
      orderOpacity: true,
      analysisTargetDepth: 'infinite',
      visualizationMode: 'arrow',
      analysisModeType: 'normal',
      deepCandidateCount: 3,
      deepRootTimeMs: 15000,
      deepTimePerCandidateMs: 30000,
      deepSecondaryTimeMs: 180000,
      deepDepthPerCandidate: 0,
      deepClearHashBetweenCandidates: false,
      deepInstabilitySensitivityCp: 80,
      deepScheduleMode: 'equal',
      deepMaxDurationMs: 300000,
      deepDiversityThreshold: 2,
      reviewDepthPreset: 'normal',
      reviewDepth: 10,
      reviewTacticalDepth: 8,
      reviewStrategicHorizon: 20,
      reviewPunishmentLineLength: 6,
      reviewDetailLevel: 'balanced',
      realtimeGameCommentary: false,
      realtimeCommentaryArrows: false,
      debugReviewPipeline: false
    },
    deepAnalysis: {
      running: false,
      error: null,
      report: null,
      startedAt: null,
      completedAt: null
    },
    menuAtMove: null,
    displayMenu: true,
    darkMode: false,
    muteButton: false,
    fenply: 1,
    internationalVariants: [
      '+ Add Custom', 'chess', 'crazyhouse', 'horde', 'kingofthehill', '3check', 'racingkings', 'antichess', 'atomic', 'fischerandom'
    ],
    seaVariants: [
      '+ Add Custom', 'makruk'
    ],
    xiangqiVariants: [
      '+ Add Custom', 'xiangqi'
    ],
    janggiVariants: [
      '+ Add Custom', 'janggi', 'janggimodern'
    ],
    shogiVariants: [
      '+ Add Custom', 'shogi'
    ],
    clock: null
  },
  mutations: { // sync
    increaseEngineNumber (state) {
      state.numberOfEngines.push({ number: 2 })
      state.engineCounter++
    },
    curVar960Fen (state, payload) {
      state.curVar960Fen = payload
    },
    viewAnalysis (state, payload) {
      state.viewAnalysis = payload
    },
    fen (state, payload) {
      state.fen = payload
      state.normalizedFen = normalizeFen(payload)
      if (state.review && state.review.currentResult && state.review.currentResult.fen !== payload) {
        state.review.overlays = []
      }
    },
    engineIndex (state, payload) {
      state.engineIndex = payload
    },
    enginesActive (state, payload) {
      state.enginesActive = payload
    },
    startFen (state, payload) {
      state.startFen = payload
      state.gameState.startFen = payload
    },
    lastFen (state, payload) {
      state.lastFen = payload
    },
    turn (state, payload) {
      state.turn = payload
      state.gameState.sideToMove = payload ? 'white' : 'black'
    },
    syncGameStateFromStore (state) {
      const current = state.moves.find(m => m.fen === state.fen)
      const line = []
      let node = current
      while (node) {
        line.push(node)
        node = node.prev
      }
      state.gameState.moves = line.reverse()
      state.gameState.startFen = state.startFen
      state.gameState.sideToMove = state.turn ? 'white' : 'black'
      state.gameState.variant = state.variant
      state.gameState.engineSettings = { ...(state.engineSettings || {}) }
    },
    commitEditorPositionAsStart (state) {
      const committedFen = state.board.fen()
      state.moves = []
      state.firstMoves = []
      state.mainFirstMove = null
      state.startFen = committedFen
      state.fen = committedFen
      state.lastFen = committedFen
      state.turn = state.board.turn()
      state.legalMoves = state.board.legalMoves()
      state.normalizedFen = normalizeFen(committedFen)
      state.fenply = 1
      state.gameState.startFen = committedFen
      state.gameState.moves = []
      state.gameState.sideToMove = state.turn ? 'white' : 'black'
      state.gameState.variant = state.variant
    },
    mainFirstMove (state, payload) {
      state.mainFirstMove = payload
    },
    firstMoves (state, payload) {
      state.firstMoves.push(payload)
    },
    deleteFromFirstMoves (state, payload) {
      state.firstMoves.splice(state.firstMoves.indexOf(payload), 1)
    },
    deleteFromMoves (state, payload) {
      for (const index in payload.next) {
        this.commit('deleteFromMoves', payload.next[index])
      }
      state.moves.splice(state.moves.indexOf(payload), 1)
    },
    legalMoves (state, payload) {
      state.legalMoves = payload
    },
    initialized (state, payload) {
      state.initialized = payload
    },
    orientation (state, payload) {
      state.orientation = payload
    },
    PvE (state, payload) {
      state.PvE = payload
    },
    PvEPlayerIsWhite (state, payload) {
      state.PvEPlayerIsWhite = payload
    },
    PvEEngineInstance (state, payload) {
      state.PvEEngineInstance = payload
    },
    playVsEngineEnabled (state, payload) {
      state.playVsEngineEnabled = !!payload
    },
    playVsEngineHumanSide (state, payload) {
      state.playVsEngineHumanSide = payload === 'black' ? 'black' : 'white'
    },
    engineTimeControlsEnabled (state, payload) {
      state.engineTimeControlsEnabled = !!payload
    },
    engineTimeControlMode (state, payload) {
      state.engineTimeControlMode = payload || 'depth'
    },
    engineTimeControlConfig (state, payload) {
      state.engineTimeControlConfig = {
        ...state.engineTimeControlConfig,
        ...(payload || {})
      }
    },
    engineSideClockMs (state, payload) {
      state.engineSideClockMs = Number.isFinite(Number(payload)) ? Number(payload) : null
    },
    PvEParam (state, payload) {
      state.PvEParam = payload
    },
    PvEValue (state, payload) {
      state.PvEValue = payload
    },
    PvEInput (state, payload) {
      state.PvEInput = payload
    },
    PvELimiter (state, payload) {
      state.PvELimiter = payload
    },
    // EvE mutations
    EvE (state, payload) {
      state.EvE = payload
    },
    EvEConfig (state, payload) {
      state.EvEConfig = payload
    },
    engineWhiteInstance (state, payload) {
      state.engineWhiteInstance = payload
    },
    engineBlackInstance (state, payload) {
      state.engineBlackInstance = payload
    },
    gameConfig (state, payload) {
      state.gameConfig = payload
    },
    startGameModal (state, payload) {
      state.startGameModal = Object.assign({}, state.startGameModal || {}, payload)
    },
    showGameEndModal (state, payload) {
      state.showGameEndModal = payload
    },
    gameResult (state, payload) {
      state.gameResult = payload
    },
    quicktourIndexIncr (state) {
      state.QuickTourIndex++
    },
    quicktourIndexDecr (state) {
      state.QuickTourIndex--
    },
    quicktourSetZero (state) {
      state.QuickTourIndex = 0
    },
    dimNumber (state, payload) {
      state.dimNumber = payload
    },
    resized (state, payload) {
      state.resized = payload
    },
    resized9x9width (state, payload) {
      state.resized9x9width = payload
    },
    resized9x9height (state, payload) {
      state.resized9x9height = payload
    },
    resized9x10width (state, payload) {
      state.resized9x10width = payload
    },
    resized9x10height (state, payload) {
      state.resized9x10height = payload
    },
    active (state, payload) {
      state.active = payload
    },
    destinations (state, payload) {
      state.destinations = payload
    },
    variant (state, payload) {
      if (payload === 'racingkings') {
        state.orientation = 'white'
      }
      state.variant = payload
      state.gameState.variant = payload
    },
    selectedEngines (state, payload) {
      state.selectedEngines = payload
    },
    clearIO () {
      // dummy to trigger update in console
    },
    engineInfo (state, payload) {
      state.engineInfo = payload
      state.nnueStatus = null
      const settings = {}
      for (const option of payload.options) {
        if (!filteredSettings.includes(option.name)) {
          switch (option.type) {
            case 'check':
              settings[option.name] = option.default === 'true'
              break
            case 'spin':
            case 'combo':
              settings[option.name] = option.default
              break
            case 'string':
              settings[option.name] = option.default || ''
              break
          }
        }
      }
      state.engineSettings = settings
    },
    engineStats (state, payload) {
      state.engineStats = payload
      if (payload && (payload.depth > 0 || payload.nodes > 0 || payload.time > 0)) {
        state.lastEngineStats = { ...state.lastEngineStats, ...payload }
      }
    },
    nnueStatus (state, payload) {
      state.nnueStatus = payload
    },
    resetEngineStats (state) {
      state.enginetime = 0
      state.engineStats = {
        depth: 0,
        seldepth: 0,
        nodes: 0,
        nps: 0,
        hashfull: 0,
        tbhits: 0,
        time: 0,
        isEvalCached: false,
        cachedDepth: -1
      }
    },
    resetWdlCache (state) {
      state.lastWdlWin = null
      state.lastWdlDraw = null
      state.lastWdlLoss = null
    },
    lastAnalysisResult (state, payload) {
      state.lastAnalysisResult = { ...state.lastAnalysisResult, ...(payload || {}) }
    },
    multipv (state, payload) {
      for (const pvline of payload) {
        if (pvline) {
          pvline.cpDisplay = typeof pvline.mate === 'number' ? `#${pvline.mate}` : cpToString(pvline.cp)
        }
      }
      state.multipv = payload
    },
    hoveredpv (state, payload) {
      state.hoveredpv = payload
    },
    increment (state, payload) {
      state.counter += payload
    },
    nextSingleMoveRequestSeq (state) {
      state.singleMoveRequestSeq += 1
    },
    resetMultiPV (state) {
      state.multipv = [
        {
          cp: 0,
          pv: '',
          ucimove: ''
        }
      ]
    },
    pieceStyle (state, payload) {
      state.pieceStyle = payload
    },
    boardStyle (state, payload) {
      state.boardStyle = payload
    },
    newBoard (state, payload) {
      const { fen, is960 } = payload || {}
      if (typeof fen === 'string') {
        if (is960) {
          state.board = new ffish.Board(state.variant, fen, true)
        } else {
          state.board = new ffish.Board(state.variant, fen)
        }
      } else {
        if (is960) {
          console.log(state.curVar960Fen)
          state.board = new ffish.Board(state.variant, state.curVar960Fen, true)
        } else {
          state.board = new ffish.Board(state.variant)
        }
      }
      state.moves = []
      state.mainFirstMove = null
      state.firstMoves = []
      state.gameInfo = {}
      state.fen = state.board.fen()
      state.turn = state.board.turn()
      state.legalMoves = state.board.legalMoves()
      state.lastFen = state.board.fen()
      state.startFen = state.board.fen()
      state.selectedGame = null
      state.fenply = 1
      state.lastAnalysisResult = { cp: 0, mate: null, pv: '', ucimove: '', turn: true }
      state.lastEngineStats = { depth: 0, seldepth: 0, nodes: 0, nps: 0, hashfull: 0, tbhits: 0, time: 0 }
      this.commit('resetEngineStats')
      state.normalizedFen = normalizeFen(state.fen)
      this.commit('syncGameStateFromStore')
    },
    resetBoard (state, payload) {
      if (!payload.is960) {
        state.curVar960Fen = ''
      }
      this.commit('newBoard', payload)
      state.selectedGame = null
      state.moves = []
      state.lastAnalysisResult = { cp: 0, mate: null, pv: '', ucimove: '', turn: true }
      state.lastEngineStats = { depth: 0, seldepth: 0, nodes: 0, nps: 0, hashfull: 0, tbhits: 0, time: 0 }
      this.commit('syncGameStateFromStore')
    },
    appendMoves (state, payload) {
      const mov = payload.move.split(' ')
      const prev = payload.prev
      let ply
      if (prev) {
        ply = prev.ply + 1
      } else { // then its a starting move
        if (state.turn) {
          ply = state.fenply
        } else {
          ply = state.fenply + 1
        }
      }
      let alreadyInMoves = false
      for (const num in state.moves) {
        if (state.moves[num].uci === mov[0] && state.moves[num].prev === prev) {
          alreadyInMoves = state.moves[num] // if the move is already in the history its stored here
        }
      }
      if (!alreadyInMoves) {
        state.moves = state.moves.concat(mov.map((curVal, idx, arr) => {
          const sanMove = state.board.sanMove(curVal)
          state.board.push(curVal)
          this.commit('playAudio', sanMove)
          const moveObj = { ply: ply, name: sanMove, fen: state.board.fen(), uci: curVal, whitePocket: state.board.pocket(true), blackPocket: state.board.pocket(false), main: undefined, next: [], prev: prev }
          // Add comment if provided (only for the first move in the sequence)
          if (idx === 0 && payload.comment) {
            moveObj.comment = payload.comment
          }
          return moveObj
        }))
        if (payload.prev) { // if the move is not a starting move
          prev.next.push(state.moves[state.moves.length - 1]) // the last entry in moves is the move object of the current move
          if (!prev.main) { // if there is no mainline yet, then this move is the main line now
            prev.main = state.moves[state.moves.length - 1]
          }
        } else { // then the currently added move was a starting move
          this.commit('firstMoves', state.moves[state.moves.length - 1]) // then we add it to the firstMoves array
          if (state.moves.length === 1) {
            this.commit('mainFirstMove', state.moves[0]) // then this is our mainFirstMove
          }
        }
      } else {
        state.board.push(alreadyInMoves.uci)
      }
      state.lastFen = state.board.fen()
    },
    playAudio (state, move) { // Sounds from lichess https://github.com/ornicar/lila
      if (state.openedPGN) {
        return
      }
      if (!state.muteButton) {
        let note = new Audio(moveAudio)
        if (move.toString().includes('x')) {
          note = new Audio(captureAudio)
        }
        note.play()
      }
    },
    gameInfo (state, payload) {
      state.gameInfo = payload
    },
    loadedGames (state, payload) {
      state.loadedGames = payload
      state.selectedGame = null
    },
    rounds (state, payload) {
      state.rounds = payload
    },
    selectedGame (state, payload) {
      state.selectedGame = payload
    },
    analysisMode (state, payload) {
      state.analysisMode = payload
    },
    editorMode (state, payload) {
      state.editorMode = payload
    },
    analysisVisualization (state, payload) {
      state.analysisVisualization = { ...state.analysisVisualization, ...payload }
    },
    deepAnalysisStart (state) {
      state.deepAnalysis = {
        running: true,
        error: null,
        report: null,
        startedAt: Date.now(),
        completedAt: null
      }
    },
    deepAnalysisResult (state, payload) {
      state.deepAnalysis = {
        running: false,
        error: payload && payload.error ? payload.error : null,
        report: payload && !payload.error ? payload : null,
        startedAt: state.deepAnalysis.startedAt,
        completedAt: Date.now()
      }
    },
    deepAnalysisClear (state) {
      state.deepAnalysis = {
        running: false,
        error: null,
        report: null,
        startedAt: null,
        completedAt: null
      }
    },
    reviewMarkerMode (state, payload) {
      const mode = Object.values(REVIEW_MARKER_MODES).includes(payload) ? payload : REVIEW_MARKER_MODES.MY_MOVES_ONLY
      state.review.markerMode = mode
      state.review.preview = { active: false, fen: '', move: null, overlays: [] }
      if (typeof localStorage !== 'undefined') {
        localStorage.reviewMarkerMode = mode
      }
    },
    reviewSetRequest (state, payload) {
      state.review.lastRequestId = payload
      state.review.loading = true
      state.review.error = null
      state.review.preview = { active: false, fen: '', move: null, overlays: [] }
      state.review.active = true
    },
    reviewPrepareFullRebuild (state) {
      const previousInteraction = state.review.sequence && state.review.sequence.previousInteraction
      state.review.currentResult = null
      state.review.overlays = []
      state.review.preview = { active: false, fen: '', move: null, overlays: [] }
      state.review.sequence = emptyReviewSequenceState()
      state.review.resultsById = {}
      state.review.error = null
      state.review.lastRequestId = null
      state.review.active = true
      if (previousInteraction && typeof previousInteraction.analysisMode === 'boolean') {
        state.analysisMode = previousInteraction.analysisMode
      }
      if (previousInteraction && typeof previousInteraction.editorMode === 'boolean') {
        state.editorMode = previousInteraction.editorMode
      }
    },
    reviewSetResult (state, payload) {
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
      const previous = state.review.currentResult
      const result = enrichReviewMovePreviewFens(payload, state.variant, state.board && state.board.is960 && state.board.is960(), previous)
      state.review.loading = false
      state.review.error = null
      state.review.preview = { active: false, fen: '', move: null, overlays: [] }
      state.review.currentResult = result
      state.review.overlays = Array.isArray(result.overlays) ? result.overlays : []
      state.review.active = true
      Vue.set(state.review.resultsById, result.id, result)
      const keys = Object.keys(state.review.resultsById || {})
      if (keys.length > MAX_REVIEW_RESULTS_CACHE) {
        const sorted = keys
          .map(key => ({ key, generatedAt: state.review.resultsById[key] && state.review.resultsById[key].generatedAt ? state.review.resultsById[key].generatedAt : 0 }))
          .sort((a, b) => a.generatedAt - b.generatedAt)
        const overflow = sorted.length - MAX_REVIEW_RESULTS_CACHE
        for (let i = 0; i < overflow; i++) {
          Vue.delete(state.review.resultsById, sorted[i].key)
        }
      }
      if (state.analysisVisualization && state.analysisVisualization.debugReviewPipeline) {
        const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
        console.debug('[review-commit]', {
          resultId: result && result.id,
          moveCount: Array.isArray(result && result.moves) ? result.moves.length : 0,
          markerCount: Array.isArray(result && result.markerMoves) ? result.markerMoves.length : 0,
          overlayCount: Array.isArray(state.review.overlays) ? state.review.overlays.length : 0,
          cacheSize: Object.keys(state.review.resultsById || {}).length,
          enrichAndCommitMs: Math.round((t1 - t0) * 100) / 100
        })
      }
    },
    reviewSingleMoveRecheckStart (state, ply) {
      if (!state.review.recheckByPly) Vue.set(state.review, 'recheckByPly', {})
      Vue.set(state.review.recheckByPly, String(ply), true)
    },
    reviewSingleMoveRecheckEnd (state, ply) {
      if (!state.review.recheckByPly) return
      Vue.delete(state.review.recheckByPly, String(ply))
    },
    reviewPatchSingleMove (state, payload) {
      const current = state.review.currentResult
      if (!current || !payload || !payload.move) return
      const patchMove = payload.move
      const moves = Array.isArray(current.moves) ? current.moves.slice() : []
      const idx = moves.findIndex(move => move && move.ply === patchMove.ply)
      if (idx < 0) return
      moves[idx] = { ...moves[idx], ...patchMove }
      const markerMode = current.markerMode || state.review.markerMode
      const markerMoves = moves.filter(move => shouldDisplayReviewMoveForMarkerMode(move.ply, markerMode))
      const summaryMove = mergedReviewClassification(markerMoves.length ? markerMoves : moves)
      const overlays = markerMoves.slice(-6).flatMap(move => Array.isArray(move.overlays) ? move.overlays : [])
      const risks = markerMoves.flatMap(move => Array.isArray(move.risks) ? move.risks : []).slice(-4)
      const patched = {
        ...current,
        moves,
        markerMoves,
        overlays,
        risks,
        classification: summaryMove ? summaryMove.classification : current.classification,
        classificationLabel: summaryMove ? summaryMove.classificationLabel : current.classificationLabel,
        generatedAt: Date.now()
      }
      state.review.currentResult = patched
      state.review.overlays = overlays
      if (patched.id) Vue.set(state.review.resultsById, patched.id, patched)
    },
    reviewPreviewSet (state, payload) {
      state.review.preview = {
        active: Boolean(payload && payload.previewFen),
        fen: payload && payload.previewFen ? payload.previewFen : '',
        move: payload || null,
        overlays: previewOverlaysForMove(payload)
      }
    },
    reviewPreviewClear (state) {
      state.review.preview = { active: false, fen: '', move: null, overlays: [] }
    },
    reviewSetError (state, payload) {
      state.review.loading = false
      state.review.error = payload
      state.review.active = true
    },
    reviewReleaseRequestLock (state, payload = {}) {
      const requestId = payload && payload.requestId ? payload.requestId : null
      if (!requestId || state.review.lastRequestId === requestId) {
        state.review.loading = false
      }
      if (payload && payload.clearRequestId && (!requestId || state.review.lastRequestId === requestId)) {
        state.review.lastRequestId = null
      }
    },
    reviewClear (state) {
      const previousInteraction = state.review.sequence && state.review.sequence.previousInteraction
      const markerMode = state.review.markerMode
      state.review = emptyReviewState()
      state.review.markerMode = markerMode
      if (previousInteraction && typeof previousInteraction.analysisMode === 'boolean') {
        state.analysisMode = previousInteraction.analysisMode
      }
      if (previousInteraction && typeof previousInteraction.editorMode === 'boolean') {
        state.editorMode = previousInteraction.editorMode
      }
    },
    reviewSequenceStart (state, payload) {
      state.review.sequence = {
        ...emptyReviewSequenceState(),
        active: true,
        baseFen: payload.fen,
        fen: payload.fen,
        turn: payload.turn,
        legalMoves: payload.legalMoves,
        previousInteraction: payload.previousInteraction || emptyReviewSequenceState().previousInteraction
      }
      state.review.currentResult = null
      state.review.overlays = []
      state.review.preview = { active: false, fen: '', move: null, overlays: [] }
      state.review.error = null
      state.review.active = true
    },
    reviewSequenceUpdate (state, payload) {
      state.review.sequence = {
        ...state.review.sequence,
        fen: payload.fen,
        turn: payload.turn,
        legalMoves: payload.legalMoves,
        line: payload.line,
        sans: payload.sans,
        overlays: buildReviewSequenceOverlays(payload.line),
        lastMove: payload.lastMove,
        previousInteraction: payload.previousInteraction || state.review.sequence.previousInteraction
      }
      state.review.currentResult = null
      state.review.overlays = []
      state.review.preview = { active: false, fen: '', move: null, overlays: [] }
    },
    reviewSequenceEnd (state) {
      const previousInteraction = state.review.sequence.previousInteraction
      state.review.sequence = emptyReviewSequenceState()
      state.review.preview = { active: false, fen: '', move: null, overlays: [] }
      if (previousInteraction && typeof previousInteraction.analysisMode === 'boolean') {
        state.analysisMode = previousInteraction.analysisMode
      }
      if (previousInteraction && typeof previousInteraction.editorMode === 'boolean') {
        state.editorMode = previousInteraction.editorMode
      }
    },
    reviewSequenceClear (state) {
      state.review.sequence = {
        ...state.review.sequence,
        fen: state.review.sequence.baseFen,
        line: [],
        sans: [],
        overlays: [],
        lastMove: null
      }
    },
    openedPGN (state, payload) {
      state.openedPGN = payload
    },
    menuAtMove (state, payload) {
      state.menuAtMove = payload
    },
    displayMenu (state, payload) {
      state.displayMenu = payload
    },
    switchDarkMode (state) {
      state.darkMode = !state.darkMode
    },
    switchMuteButton (state) {
      state.muteButton = !state.muteButton
    },
    evalPlotDepth (state, payload) {
      state.evalPlotDepth = payload
    },
    fenply (state, payload) {
      state.fenply = payload
    },
    movesChangeDummy (state, payload) {
      state.moves = []
      state.moves = payload
    },
    setEngineClock (state) {
      clearInterval(state.clock)
      state.clock = setInterval(function () { state.enginetime = state.enginetime + 1000 }, 1000)
    },
    resetEngineTime (state) {
      clearInterval(state.clock)
    },
    saveSettings (state) {
      localStorage.darkMode = state.darkMode
      localStorage.muteButton = state.muteButton
      localStorage.evalPlotDepth = state.evalPlotDepth
      localStorage.variant = state.variant
      localStorage.resized = state.resized
      localStorage.resized9x9width = state.resized9x9width
      localStorage.resized9x9height = state.resized9x9height
      localStorage.resized9x10width = state.resized9x10width
      localStorage.resized9x10height = state.resized9x10height
      localStorage.dimNumber = state.dimNumber
    },

    // mutation to reset settings back to defaults
    resetAllSettings (state) {
      const defaults = {
        engineIndex: 1,
        enginesActive: [false],
        PvE: false,
        PvEParam: 'go movetime 1000',
        PvEValue: 'time',
        PvEInput: 1000,
        resized: 0,
        resized9x9height: 0,
        resized9x9width: 0,
        resized9x10height: 0,
        resized9x10width: 0,
        dimNumber: 0,
        turn: true,
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        normalizedFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
        lastFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: [],
        firstMoves: [],
        mainFirstMove: null,
        legalMoves: '',
        destinations: {},
        variant: 'chess',
        viewAnalysis: true,
        analysisMode: true,
        darkMode: false,
        muteButton: false,
        pieceStyle: 'cburnett',
        boardStyle: 'blue',
        curVar960Fen: '',
        startGameModal: {
          whiteChoice: 'player',
          blackChoice: 'engine',
          selectedGameMode: 'chess',
          whiteEngineName: null,
          blackEngineName: null,
          whiteLimiterEnabled: true,
          whiteLimiterType: 'time',
          whiteLimiterValue: 1000,
          blackLimiterEnabled: true,
          blackLimiterType: 'time',
          blackLimiterValue: 1000,
          showEndGameModal: true
        },
        openedPGN: false,
        QuickTourIndex: 0,
        evalPlotDepth: 20,
        fenply: 1,
        engineInfo: {
          name: '',
          author: '',
          options: []
        },
        engineSettings: {},
        multipv: [
          {
            cp: 0,
            pv: '',
            ucimove: ''
          }
        ],
        numberOfEngines: [{ number: 1 }],
        engineCounter: 1,
        selectedEngines: {},
        loadedGames: [],
        rounds: null,
        selectedGame: null,
        allEngines: allEngines,
        activeEngine: null,
        review: emptyReviewState(),
        active: false
      }

      // assign defaults onto state
      Object.keys(defaults).forEach(key => {
        // preserve reactive properties by setting individual keys
        state[key] = defaults[key]
      })

      // board instance is replaced by the action (commit('newBoard')), avoid mutating external objects here
    }
  },
  actions: { // async
    movesChangeDummy (context, payload) {
      context.commit('movesChangeDummy', payload)
    },
    playAudio (context, payload) {
      context.commit('playAudio', payload)
    },
    curVar960Fen (context, payload) {
      context.commit('curVar960Fen', payload)
    },
    resetBoard (context, payload) {
      context.commit('resetMultiPV')
      context.commit('resetBoard', payload)
      context.dispatch('setEngineOptions', { UCI_Chess960: payload.is960 })
      context.dispatch('restartEngine')
    },
    initialize (context) {
      if (localStorage.evalPlotDepth) {
        context.state.evalPlotDepth = localStorage.evalPlotDepth
      }
      if (localStorage.darkMode) {
        if (localStorage.darkMode === 'true') {
          context.commit('switchDarkMode')
        }
      }
      if (localStorage.muteButton) {
        if (localStorage.muteButton === 'true') {
          context.commit('switchMuteButton')
        }
      }
      if (localStorage.internationalPieceStyle) {
        context.commit('pieceStyle', localStorage.internationalPieceStyle)
      }
      if (localStorage.internationalBoardStyle) {
        context.commit('boardStyle', localStorage.internationalBoardStyle)
      }
      if (localStorage.variant) {
        context.commit('variant', localStorage.variant)
      }
      if (localStorage.reviewMarkerMode && Object.values(REVIEW_MARKER_MODES).includes(localStorage.reviewMarkerMode)) {
        context.commit('reviewMarkerMode', localStorage.reviewMarkerMode)
      }
      if (localStorage.engines) {
        try {
          context.state.allEngines = JSON.parse(localStorage.engines)
        } catch (err) {
          localStorage.removeItem('engines')
        }
      }
      context.commit('newBoard')
      context.dispatch('updateBoard')
      context.dispatch('changeEngine', context.getters.availableEngines[0].name)
      context.commit('initialized', true)
    },
    updateBoard (context) {
      const { board } = context.state
      board.setFen(context.state.fen)
      context.commit('turn', board.turn())
      context.commit('legalMoves', board.legalMoves())
      context.commit('syncGameStateFromStore')
    },
    push (context, payload) {
      context.commit('appendMoves', payload)
      return context.dispatch('fen', context.state.board.fen()).then(() => {
        // Only check for game end if a game was started via the new game modal
        if (context.state.gameConfig) {
          if (context.state.board.isGameOver()) {
            const resultStr = context.state.board.result()
            let result = null
            if (resultStr === '1-0') result = 'white-win'
            else if (resultStr === '0-1') result = 'black-win'
            else if (resultStr === '1/2-1/2') result = 'draw'
            context.dispatch('endGame', { result })
          }
        }
      })
    },
    pushMainLine (context, payload) {
      let prev = payload.prev
      for (const i in payload.line) {
        context.commit('appendMoves', { move: payload.line[i], prev: prev })
        const move = context.getters.getMoveByUCIAndPrev(payload.line[i], prev)[0]
        if (!prev) {
          context.commit('mainFirstMove', move)
          prev = move
        } else {
          prev.main = move
          prev = prev.main
        }
      }
      context.dispatch('fen', context.state.board.fen())
    },
    pushAltLine (context, payload) {
      let prev = payload.prev
      for (const i in payload.line) {
        context.commit('appendMoves', { move: payload.line[i], prev: prev })
        const move = context.getters.getMoveByUCIAndPrev(payload.line[i], prev)[0]
        console.log(move)
        if (!prev) {
          if (!context.state.mainFirstMove) {
            context.commit('mainFirstMove', move)
          }
        }
        prev = move
      }
      context.dispatch('fen', context.state.board.fen())
    },
    mainFirstMove (context, payload) {
      if (context.state.mainFirstMove !== payload) {
        context.commit('mainFirstMove', payload)
      }
    },
    firstMoves (context, payload) {
      if (!context.state.firstMoves.includes(payload)) {
        context.commit('firstMoves', payload)
      }
    },
    deleteFromMoves (context, payload) {
      if (!payload.prev) {
        context.commit('deleteFromFirstMoves', payload)
      }
      context.commit('deleteFromMoves', payload)
    },
    resetEngineData (context) {
      context.commit('resetMultiPV')
      context.commit('resetEngineStats')
      context.commit('resetWdlCache')
    },
    setPvEParam (context, payload) {
      context.commit('PvEParam', payload)
    },
    setPvEValue (context, payload) {
      context.commit('PvEValue', payload)
    },
    setPvEInput (context, payload) {
      context.commit('PvEInput', payload)
    },
    updateLiveLimiter (context, payload = {}) {
      const limiter = {
        enabled: payload.enabled !== false,
        type: payload.type || 'time',
        value: Number(payload.value) || 1000
      }
      const side = payload.side || 'both'
      if (side === 'pve' || side === 'both') {
        context.commit('PvELimiter', limiter)
        if (context.state.PvE && context.state.PvEEngineInstance) {
          context.state.PvEEngineInstance.send('stop')
          context.dispatch('goEnginePvE')
        }
      }
      if ((side === 'white' || side === 'black' || side === 'both') && context.state.EvE) {
        const cfg = { ...(context.state.EvEConfig || {}) }
        if (side === 'white' || side === 'both') cfg.whiteLimiter = limiter
        if (side === 'black' || side === 'both') cfg.blackLimiter = limiter
        context.commit('EvEConfig', cfg)
        const activeEngine = context.getters.turn ? context.state.engineWhiteInstance : context.state.engineBlackInstance
        if (activeEngine) {
          activeEngine.send('stop')
          const activeLimiter = context.getters.turn ? cfg.whiteLimiter : cfg.blackLimiter
          activeEngine.send(buildPositionCommand(context.getters.gameState))
          activeEngine.send(limiterToGo(activeLimiter))
        }
      }
      this.commit('syncGameStateFromStore')
    },
    setDimNumber (context, payload) {
      context.commit('dimNumber', payload)
    },
    setResized (context, payload) {
      context.commit('resized', payload)
    },
    setResized9x9width (context, payload) {
      context.commit('resized9x9width', payload)
    },
    setResized9x9height (context, payload) {
      context.commit('resized9x9height', payload)
    },
    setResized9x10width (context, payload) {
      context.commit('resized9x10width', payload)
    },
    setResized9x10height (context, payload) {
      context.commit('resized9x10height', payload)
    },
    setPlayVsEngineEnabled (context, payload) {
      context.commit('playVsEngineEnabled', payload)
      if (payload) {
        context.dispatch('EvEfalse')
        context.dispatch('PvEfalse')
      } else {
        context.dispatch('stopEngine')
      }
    },
    setPlayVsEngineHumanSide (context, payload) {
      context.dispatch('stopEngine')
      context.commit('playVsEngineHumanSide', payload)
    },
    setEngineTimeControlsEnabled (context, payload) {
      context.commit('engineTimeControlsEnabled', payload)
      context.commit('engineSideClockMs', null)
    },
    setEngineTimeControlMode (context, payload) {
      context.commit('engineTimeControlMode', payload)
      context.commit('engineSideClockMs', null)
    },
    setEngineTimeControlConfig (context, payload) {
      context.commit('engineTimeControlConfig', payload)
    },
    computeEngineSearchLimits (context, payload = {}) {
      if (!context.state.engineTimeControlsEnabled || context.state.engineTimeControlMode === 'depth') {
        const targetDepth = context.state.analysisVisualization.analysisTargetDepth
        const goCmd = (payload.depth || (targetDepth !== 'infinite' && Number.isFinite(Number(targetDepth))))
          ? `go depth ${payload.depth || Number(targetDepth)}`
          : 'go infinite'
        return { goCmd }
      }

      const mode = context.state.engineTimeControlMode
      const cfg = context.state.engineTimeControlConfig || {}
      if (mode === 'perMove') {
        const ms = Math.max(1, parseInt((cfg.perMove && cfg.perMove.seconds) || 3, 10)) * 1000
        return { goCmd: `go movetime ${ms}` }
      }
      if (mode === 'movesInTime') {
        const movesToGo = Math.max(1, parseInt((cfg.movesInTime && cfg.movesInTime.moves) || 40, 10))
        const totalMs = Math.max(1, parseInt((cfg.movesInTime && cfg.movesInTime.minutes) || 5, 10)) * 60 * 1000
        const clockMs = Number.isFinite(context.state.engineSideClockMs) && context.state.engineSideClockMs > 0 ? context.state.engineSideClockMs : totalMs
        if (!Number.isFinite(context.state.engineSideClockMs) || context.state.engineSideClockMs === null) {
          context.commit('engineSideClockMs', clockMs)
        }
        return { goCmd: `go movestogo ${movesToGo} wtime ${clockMs} btime ${clockMs}` }
      }
      const baseMs = Math.max(1, parseInt((cfg.increment && cfg.increment.baseMinutes) || 5, 10)) * 60 * 1000
      const incMs = Math.max(0, parseInt((cfg.increment && cfg.increment.incrementSeconds) || 3, 10)) * 1000
      const clockMs = Number.isFinite(context.state.engineSideClockMs) && context.state.engineSideClockMs > 0 ? context.state.engineSideClockMs : baseMs
      if (!Number.isFinite(context.state.engineSideClockMs) || context.state.engineSideClockMs === null) {
        context.commit('engineSideClockMs', clockMs)
      }
      return { goCmd: `go wtime ${clockMs} btime ${clockMs} winc ${incMs} binc ${incMs}` }
    },
    async analyzePosition (context, payload = {}) {
      // Manual analysis action: think on the exact current board state without playing a move.
      context.dispatch('position')
      context.dispatch('stopEngine')
      context.dispatch('goEngine', payload)
    },
    async playSingleEngineMove (context, payload = {}) {
      // Manual single-action engine move:
      // position -> go -> receive bestmove once -> apply exactly one move -> stop.
      context.dispatch('stopEngine')
      context.dispatch('position')

      context.commit('nextSingleMoveRequestSeq')
      const requestSeq = context.state.singleMoveRequestSeq
      let handleBestMove
      const bestMovePromise = new Promise(resolve => {
        handleBestMove = move => resolve(move)
        engine.on('bestmove', handleBestMove)
      })

      context.dispatch('goEngine', payload)

      try {
        const bestmove = sanitizeEngineMove(await bestMovePromise)
        if (requestSeq !== context.state.singleMoveRequestSeq) return
        if (!bestmove) return
        await context.dispatch('push', { move: bestmove, prev: context.getters.currentMove[0] })
      } catch (err) {
        console.error('[playSingleEngineMove] Failed to apply single engine move:', err)
      } finally {
        if (handleBestMove) {
          engine.off('bestmove', handleBestMove)
        }
        context.dispatch('stopEngine')
      }
    },
    async goEngine (context, payload = {}) {
      const { goCmd } = await context.dispatch('computeEngineSearchLimits', payload)
      console.log('[engine-order] cmd:', goCmd)
      engine.send(goCmd)
      context.commit('setEngineClock')
      context.commit('active', true)
    },
    async playVsEngineMove (context) {
      if (!context.state.playVsEngineEnabled) return
      const engineSide = context.state.playVsEngineHumanSide === 'white' ? 'black' : 'white'
      const turnSide = context.getters.turn ? 'white' : 'black'
      if (engineSide !== turnSide) return
      await context.dispatch('playSingleEngineMove')
    },
    async onHumanMoveComplete (context) {
      await context.dispatch('playVsEngineMove')
    },
    goEnginePvE (context) {
      // Send PvE engine command using the stored PvE engine instance and limiter
      const pveEngine = context.state.PvEEngineInstance
      const pveLimiter = context.state.PvELimiter
      if (!pveEngine) {
        console.error('[goEnginePvE] No PvE engine instance available')
        return
      }
      try {
        pveEngine.send(buildPositionCommand(context.getters.gameState))
        pveEngine.send(limiterToGo(pveLimiter))
      } catch (err) {
        console.error('[goEnginePvE] Failed to send position/go to PvE engine:', err)
      }
      context.commit('setEngineClock')
      context.commit('active', true)
    },
    PvEMakeMove (context, payload) {
      // Triggered when the engine emits 'bestmove'. Apply the move only if:
      //  1. PvE mode is active 2. engine is to move now
      const state = context.state
      const playerIsWhite = context.state.PvEPlayerIsWhite
      const engineIsWhite = !playerIsWhite
      const turnIsWhite = state.turn
      const engineToMoveNow = (turnIsWhite && engineIsWhite) || (!turnIsWhite && !engineIsWhite)
      const move = sanitizeEngineMove(payload)
      if (state.active && state.PvE && engineToMoveNow && move) {
        // Dispatch push and handle failure (invalid uci for current position)
        context.dispatch('push', { move, prev: context.getters.currentMove[0] }).then(() => {
        }).catch((err) => {
          // If engine returned a move invalid for the current position, log and restart engine on the
          // current position so it recalculates for the correct state.
          console.error('[PvEMakeMove] Engine provided invalid move for current position:', move, err)
          context.dispatch('position')
          context.dispatch('goEnginePvE')
        })
      }
    },

    setActiveTrue (context) {
      context.commit('active', true)
    },
    setActiveFalse (context) {
      context.commit('active', false)
    },
    enginesActive (context, payload) {
      context.commit('enginesActive', payload)
    },

    setGameConfig (context, payload) {
      context.commit('gameConfig', payload)
    },

    endGame (context, payload) {
      context.commit('gameResult', payload.result)
      const shouldShowModal = context.state.startGameModal && context.state.startGameModal.showEndGameModal !== false
      if (shouldShowModal) {
        context.commit('showGameEndModal', true)
      }
    },

    closeGameEndModal (context) {
      context.commit('showGameEndModal', false)
    },
    async PvEtrue (context, payload = {}) {
      // Enable PvE mode and remember which side the human player controls.
      // payload.playerIsWhite = true means the human is White (legacy behavior).
      try {
        const gameMode = payload.gameMode
        const playerIsWhite = payload && typeof payload.playerIsWhite !== 'undefined' ? payload.playerIsWhite : true
        const engineName = payload.engine
        const pveLimiter = payload.pveLimiter

        // Stop old PvE engine if it exists to avoid listener conflicts
        if (context.state.PvEEngineInstance) {
          try {
            context.state.PvEEngineInstance.send('stop')
            context.state.PvEEngineInstance.removeAllListeners()
          } catch (err) {
            console.warn('[PvEtrue] Error stopping old engine:', err)
          }
        }

        const engineInfo = context.state.allEngines[engineName]
        if (!engineInfo) {
          throw new Error('Could not find engine binary for provided name')
        }

        // create engine instance
        const pveEngine = new Engine()

        // run the PvE engine
        await pveEngine.run(engineInfo.binary, engineInfo.cwd)

        // configure PvE engine with the desired game mode (variant) and 960 flag
        const variantCmd = `setoption name UCI_Variant value ${gameMode}`
        const chess960Cmd = `setoption name UCI_Chess960 value ${context.getters.is960}`

        try {
          pveEngine.send(variantCmd)
          pveEngine.send(chess960Cmd)
        } catch (err) {
          console.warn('[PvEtrue] Failed to send variant/960 to PvE engine:', err)
        }

        // commit engine instance and PvE mode state
        context.commit('PvE', true)
        context.commit('PvEPlayerIsWhite', playerIsWhite)
        context.commit('PvEEngineInstance', pveEngine)
        context.commit('PvELimiter', pveLimiter)
        context.commit('active', true)

        const engineIsWhite = !playerIsWhite

        // send position and go to the engine instance
        const sendPositionAndGo = (inst, lim) => {
          try {
            inst.send(buildPositionCommand(context.getters.gameState))
            inst.send(limiterToGo(lim))
          } catch (err) {
            console.error('[PvE] Failed to send position/go:', err)
          }
        }

        // bestmove handler
        const pveEngineHandler = async ucimove => {
          const turnIsWhite = context.getters.turn
          const engineToMoveNow = (turnIsWhite && engineIsWhite) || (!turnIsWhite && !engineIsWhite)

          if (!context.state.PvE || !engineToMoveNow) return
          try {
            const move = sanitizeEngineMove(ucimove)
            if (!move) return
            await context.dispatch('push', { move, prev: context.getters.currentMove[0] })
          } catch (err) {
            console.error('[PvEMakeMove] Engine provided invalid move:', ucimove, err)
            // try to restart the engine calculation on current position
            context.dispatch('position')
            sendPositionAndGo(pveEngine, pveLimiter)
          }
        }

        // attach listener
        pveEngine.on('bestmove', pveEngineHandler)

        // kick off the engine if it's the engine's turn now
        const turnIsWhiteNow = context.getters.turn
        const engineToMoveNow = (turnIsWhiteNow && engineIsWhite) || (!turnIsWhiteNow && !engineIsWhite)
        if (engineToMoveNow) {
          sendPositionAndGo(pveEngine, pveLimiter)
        }
      } catch (err) {
        console.error('[PvEtrue] Could not start PvE match:', err)
      }
    },
    // Start an Engine vs Engine match. Payload must include engine names and limiter configs:
    // { whiteEngine, blackEngine, whiteLimiter: { enabled, type, value }, blackLimiter: {...} }
    async EvEtrue (context, payload = {}) {
      try {
        const gameMode = payload.gameMode

        const whiteName = payload.whiteEngine
        const blackName = payload.blackEngine
        if (!whiteName || !blackName) {
          throw new Error('Both whiteEngine and blackEngine must be provided')
        }

        const whiteInfo = context.state.allEngines[whiteName]
        const blackInfo = context.state.allEngines[blackName]
        if (!whiteInfo || !blackInfo) {
          throw new Error('Could not find engine binaries for provided names')
        }

        // create engine instances
        const white = new Engine()
        const black = new Engine()

        // run both engines
        await Promise.all([
          white.run(whiteInfo.binary, whiteInfo.cwd),
          black.run(blackInfo.binary, blackInfo.cwd)
        ])

        // configure Eve engines with the desired game mode (variant) and 960 flag
        const variantCmd = `setoption name UCI_Variant value ${gameMode}`
        const chess960Cmd = `setoption name UCI_Chess960 value ${context.getters.is960}`

        try {
          white.send(variantCmd)
          white.send(chess960Cmd)
          black.send(variantCmd)
          black.send(chess960Cmd)
        } catch (err) {
          console.warn('[EvEtrue] Failed to send variant/960 to Eve engines:', err)
        }

        context.commit('engineWhiteInstance', white)
        context.commit('engineBlackInstance', black)
        context.commit('EvEConfig', payload)
        context.commit('EvE', true)
        context.commit('enginesActive', [true, true])
        context.commit('active', true)

        // send position and go to a specific engine instance
        const sendPositionAndGo = (inst, lim) => {
          try {
            inst.send(buildPositionCommand(context.getters.gameState))
            inst.send(limiterToGo(lim))
          } catch (err) {
            console.error('[EvE] Failed to send position/go:', err)
          }
        }

        // bestmove handlers
        const whiteHandler = async ucimove => {
          // only apply if it's White to move
          const turnIsWhite = context.getters.turn
          if (!context.state.EvE || !turnIsWhite) return
          try {
            const move = sanitizeEngineMove(ucimove)
            if (!move) return
            await context.dispatch('push', { move, prev: context.getters.currentMove[0] })
            // after white move, trigger black
            const cfg = context.state.EvEConfig || {}
            sendPositionAndGo(context.state.engineBlackInstance, cfg.blackLimiter)
          } catch (err) {
            console.error('[EvEMakeMove] White provided invalid move:', ucimove, err)
            // try to restart the black engine calculation on current position
            context.dispatch('position')
            sendPositionAndGo(context.state.engineBlackInstance, context.state.EvEConfig && context.state.EvEConfig.blackLimiter)
          }
        }

        const blackHandler = async ucimove => {
          const turnIsWhite = context.getters.turn
          if (!context.state.EvE || turnIsWhite) return
          try {
            const move = sanitizeEngineMove(ucimove)
            if (!move) return
            await context.dispatch('push', { move, prev: context.getters.currentMove[0] })
            // after black move, trigger white
            const cfg = context.state.EvEConfig || {}
            sendPositionAndGo(context.state.engineWhiteInstance, cfg.whiteLimiter)
          } catch (err) {
            console.error('[EvEMakeMove] Black provided invalid move:', ucimove, err)
            context.dispatch('position')
            sendPositionAndGo(context.state.engineWhiteInstance, context.state.EvEConfig && context.state.EvEConfig.whiteLimiter)
          }
        }

        // attach listeners
        white.on('bestmove', whiteHandler)
        black.on('bestmove', blackHandler)

        // kick off the side to move now
        const turnIsWhiteNow = context.getters.turn
        if (turnIsWhiteNow) {
          sendPositionAndGo(white, payload.whiteLimiter)
        } else {
          sendPositionAndGo(black, payload.blackLimiter)
        }
      } catch (err) {
        console.error('[EvEtrue] Could not start EvE match:', err)
      }
    },

    async EvEfalse (context) {
      // stop EvE match and quit engines
      context.commit('EvE', false)
      context.commit('enginesActive', [false, false])
      try {
        if (context.state.engineWhiteInstance) {
          try { context.state.engineWhiteInstance.send('quit') } catch (e) {}
          context.state.engineWhiteInstance.removeAllListeners && context.state.engineWhiteInstance.removeAllListeners()
          context.commit('engineWhiteInstance', null)
        }
        if (context.state.engineBlackInstance) {
          try { context.state.engineBlackInstance.send('quit') } catch (e) {}
          context.state.engineBlackInstance.removeAllListeners && context.state.engineBlackInstance.removeAllListeners()
          context.commit('engineBlackInstance', null)
        }
      } catch (err) {
        console.error('[EvEfalse] Error stopping EvE engines:', err)
      }
      context.commit('active', false)
    },
    stopEnginePvE (context) {
      engine.send('stop')
    },
    PvEfalse (context) {
      // Stop and clean up old PvE engine
      if (context.state.PvEEngineInstance) {
        try {
          context.state.PvEEngineInstance.send('stop')
          context.state.PvEEngineInstance.removeAllListeners()
        } catch (err) {
          console.warn('[PvEfalse] Error stopping PvE engine:', err)
        }
      }
      context.commit('PvE', false)
      context.commit('PvEEngineInstance', null)
      if (!context.getters.turn) {
        context.dispatch('stopEngine')
      } else {
        context.commit('resetEngineTime')
        context.commit('active', false)
      }
    },
    stopEngine (context) {
      engine.send('stop')
      context.commit('resetEngineTime')
      context.commit('active', false)
      if (context.state.deepAnalysis.running) {
        context.commit('deepAnalysisResult', { error: 'Deep analysis cancelled', cancelled: true })
      }
    },
    restartEngine (context) {
      context.dispatch('resetEngineData')
      if (context.getters.active && !context.getters.PvE) {
        context.dispatch('stopEngine')
        context.dispatch('position')
        context.dispatch('goEngine')
      } else if (context.getters.active && context.getters.PvE) {
        const playerIsWhite = context.getters.PvEPlayerIsWhite
        const engineIsWhite = !playerIsWhite
        const turnIsWhite = context.getters.turn
        const engineToMoveNow = (turnIsWhite && engineIsWhite) || (!turnIsWhite && !engineIsWhite)
        if (engineToMoveNow) {
          context.dispatch('position')
          context.dispatch('goEnginePvE')
        }
      }
    },
    async position (context) {
      const normalizedFen = context.getters.normalizedFen
      const engineName = context.getters.engineName

      console.log('[engine-order] cmd: position fen', context.getters.fen)
      try {
        engine.send(buildPositionCommand(context.getters.gameState))
      } catch (err) {
        console.error('[GameState] position sync mismatch. Rebuilding UI state from canonical GameState startFen.', err)
        context.commit('fen', context.state.gameState.startFen)
        context.dispatch('updateBoard')
        engine.send(buildPositionCommand(context.getters.gameState))
      }
      const eve = new CustomEvent('position', { detail: { fen: context.getters.fen } })
      document.dispatchEvent(eve)
      if (!ipcRenderer) {
        console.log('ipcrenderer not available')
        return
      }
      const evaluation = await ipcRenderer.invoke('eval-cache-get', {
        positionKey: normalizedFen,
        engineName
      })
      // expect array
      if (!Array.isArray(evaluation) || evaluation.length === 0) return

      // make sure result is not stale
      if (!evaluation) return
      if (context.getters.normalizedFen !== normalizedFen) return
      if (context.getters.engineName !== engineName) return

      // ignore pv updates when engine is expected to be inactive
      if (!context.state.active) {
        return
      }
      const primary = evaluation[0]
      // update engine stats
      const stats = { ...context.state.engineStats }
      for (const key of Object.keys(stats)) {
        if (key in primary) stats[key] = primary[key]
      }
      stats.isEvalCached = true
      stats.cachedDepth = stats.depth
      context.commit('engineStats', stats)

      // update multipv array
      const multipv = context.getters.multipv.slice(0)
      for (const row of evaluation) {
        const idx = (row.multipv || 1) - 1
        if (idx < 0) continue

        // handle mate-only rows (if you store mate)
        if (row.mate === 0) {
          multipv[idx] = { mate: row.mate }
          continue
        }

        if (!row.pv_line) continue

        const { board } = context.state
        const ucimove = row.pv_line.split(/\s/)[0]

        // verify first move is legal
        if (!board.legalMoves().includes(ucimove)) continue

        let cachedWdl = null
        if (row.wdl_eval) {
          try {
            const parsed = JSON.parse(row.wdl_eval)
            if (Array.isArray(parsed)) {
              cachedWdl = parsed
            }
          } catch (err) {
            // ignore invalid cache entry
          }
        }

        const pvline = {
          cp: row.cp_eval,
          mate: row.mate,
          pvUCI: row.pv_line,
          ucimove
        }
        if (cachedWdl) {
          pvline.wdl = cachedWdl
        }

        try {
          pvline.pv = board.variationSan(row.pv_line)
        } catch (err) {
          // reset board to avoid being stuck
          board.setFen(context.state.fen)
          console.warn('Invalid cached pv move.\nFEN:', board.fen(), '\nPV:', row.pv_line)
          continue
        }

        multipv[idx] = pvline
      }
      context.commit('multipv', multipv)
    },
    sendEngineCommand (_, payload) {
      engine.send(payload)
    },
    fen (context, payload) {
      if (context.state.fen !== payload) {
        context.commit('fen', payload)
        context.dispatch('updateBoard')
        context.dispatch('restartEngine')
      }
    },
    fenField (context, payload) {
      if (ffish.validateFen(payload, context.getters.variant) === 1) { // this doesnt work properly for horde and racing kings
        if (context.state.fen !== payload) {
          context.commit('fen', payload)
          context.dispatch('updateBoard')
          context.dispatch('restartEngine')
          context.commit('newBoard', { fen: payload })
          let index = 1
          while (payload[payload.length - index] !== ' ') {
            index = index + 1
          }
          const numAsString = payload.substring(payload.length - index, payload.length)
          const ply = parseInt(numAsString)
          context.commit('fenply', 2 * ply - 1)
        }
      } else {
        alert('Please insert a valid FEN for the current variant')
      }
    },
    lastFen (context, payload) {
      context.commit('lastFen', payload)
    },
    startFen (context, payload) {
      context.commit('startFen', payload)
    },
    destinations (context, payload) {
      context.commit('destinations', payload)
    },
    orientation (context, payload) {
      context.commit('orientation', payload)
    },
    active (context, payload) {
      context.commit('active', payload)
    },
    PvE (context, payload) {
      context.commit('PvE', payload)
    },
    engineIndex (context, payload) {
      context.commit('engineIndex', payload)
    },
    PvEParam (context, payload) {
      context.commit('PvEParam', payload)
    },
    PvEValue (context, payload) {
      context.commit('PvEValue', payload)
    },
    PvEInput (context, payload) {
      context.commit('PvEInput', payload)
    },
    dimNumber (context, payload) {
      context.commit('dimNumber', payload)
    },
    resized (context, payload) {
      context.commit('resized', payload)
    },
    resized9x9width (context, payload) {
      context.commit('resized9x9width', payload)
    },
    resized9x9height (context, payload) {
      context.commit('resized9x9height', payload)
    },
    resized9x10width (context, payload) {
      context.commit('resized9x10width', payload)
    },
    resized9x10height (context, payload) {
      context.commit('resized9x10height', payload)
    },
    variant (context, payload) {
      if (context.getters.variant !== payload) {
        // prepare engine
        if (context.getters.active) {
          context.dispatch('stopEngine')
        }
        context.dispatch('resetEngineData')
        const oldEngine = context.getters.selectedEngine

        // update variant
        context.commit('variant', payload)
        const variants = ['chess', 'crazyhouse', 'racingkings', '3check', 'antichess', 'atomic']
        if (variants.includes(payload)) {
          const varFen = context.getters.curVar960Fen
          const is960Mode = varFen !== ''
          context.commit('newBoard', { is960: is960Mode, fen: varFen })
        } else {
          context.commit('newBoard', { is960: false, fen: '' })
        }

        // switch to new engine
        const last = context.state.selectedEngines[payload]
        const newEngine = typeof last === 'string'
          ? last
          : (oldEngine && oldEngine.variants.includes(payload) ? oldEngine.name : context.getters.availableEngines[0].name)
        context.dispatch('changeEngine', newEngine).then(() => {
          context.dispatch('setEngineOptions', { UCI_Variant: payload })
        })
      }
    },
    set960 (context, payload) {
      context.commit('selectedGame', null)
      context.commit('resetMultiPV')
      context.commit('newBoard', {
        fen: payload.fen,
        is960: payload.is960
      })
      context.dispatch('setEngineOptions', { UCI_Chess960: payload.is960 })
    },
    async addEngine (context, payload) {
      // discover the variants by running the engine
      const { name, binary, cwd, logo } = payload
      const info = await engine.run(binary, cwd)
      const variantOption = info.options.find(option => option.name === 'UCI_Variant')
      const variants = variantOption ? variantOption.var : ['chess']

      // update engines
      context.state.allEngines = {
        ...context.state.allEngines,
        [name]: { binary, cwd, logo, variants }
      }
      localStorage.engines = JSON.stringify(context.state.allEngines)

      // swap back to current engine after we are done
      context.commit('clearIO')
      await engine.run(context.getters.engineBinary, context.getters.selectedEngine.cwd)
      await context.dispatch('initEngineOptions')
    },
    async editEngine (context, payload) {
      const { old, changed: { name, binary, cwd, logo } } = payload
      const engines = { ...context.state.allEngines }

      // grab new engine entry
      let updated
      if (name !== old) {
        engines[name] = { ...engines[old] }
        updated = engines[name]
        delete engines[old]
      } else {
        updated = engines[old]
      }

      // update logo
      updated.logo = logo

      // update active engine name
      context.state.activeEngine = name

      // update name in selected engines
      const selectedEngines = { ...context.state.selectedEngines }
      for (const [variant, selected] of Object.entries(selectedEngines)) {
        if (selected === old) {
          selectedEngines[variant] = name
        }
      }
      context.state.selectedEngines = selectedEngines

      // rerun if binary or cwd changed
      if (updated.binary !== binary || updated.cwd !== cwd) {
        await context.dispatch('runBinary', { binary, cwd })
        const variantOption = context.state.engineInfo.options.find(option => option.name === 'UCI_Variant')
        updated.variants = variantOption ? variantOption.var : ['chess']
      }
      updated.binary = binary
      updated.cwd = cwd

      // save engines
      context.state.allEngines = engines
      localStorage.engines = JSON.stringify(context.state.allEngines)
    },
    async deleteEngine (context, payload) {
      const engines = { ...context.state.allEngines }
      delete engines[payload]
      const missing = Object.entries(context.state.variantOptions.getAll())
        .filter(([_, variant]) => !Object.values(engines).find(engine => engine.variants.includes(variant)))
        .map(([name, _]) => name)
      if (missing.length > 0) {
        alert(`"${payload}" can not be deleted:\nOnly Engine supporting Variants ${missing.join(', ')}!`)
        return
      }
      context.state.allEngines = engines
      localStorage.engines = JSON.stringify(context.state.allEngines)
      await context.dispatch('changeEngine', context.getters.availableEngines[0].name)
    },
    async changeEngine (context, payload) {
      const id = payload

      // always update selected engines
      const selected = {
        ...context.state.selectedEngines,
        [context.getters.variant]: id
      }
      context.commit('selectedEngines', selected)

      // only change engine when its a different one
      if (context.state.activeEngine !== id) {
        context.state.activeEngine = id
        context.dispatch('resetEngineData')
        context.dispatch('runBinary', {
          binary: context.getters.engineBinary,
          cwd: context.getters.selectedEngine.cwd
        })
      }
    },
    async runBinary (context, payload) {
      const { binary, cwd } = payload
      console.log('[engine-lifecycle] runBinary:start', { binary, cwd, activeEngine: context.state.activeEngine })
      if (context.getters.active) {
        context.commit('active', false)
      }
      context.commit('clearIO')
      await context.dispatch('resetEngineData')
      context.commit('engineInfo', await engine.run(binary, cwd))
      console.log('[engine-lifecycle] runBinary:active', {
        activeEngine: context.state.activeEngine,
        optionCount: Array.isArray(context.state.engineInfo.options) ? context.state.engineInfo.options.length : 0
      })
      await context.dispatch('initEngineOptions')
    },
    initEngineOptions (context) {
      const hasVariantOption = context.state.engineInfo.options.some(option => option.name === 'UCI_Variant')
      const options = {
        // 960 is always set; UCI_Variant only if engine supports it
        ...(hasVariantOption ? { UCI_Variant: context.getters.variant } : {}),
        UCI_Chess960: context.state.board.is960(),

        // multi pv 5 is default
        MultiPV: 5
      }
      const stored = localStorage.getItem('engine' + context.state.activeEngine)
      if (stored) {
        Object.assign(options, JSON.parse(stored))
      }
      console.log('[engine-options] initEngineOptions', {
        activeEngine: context.state.activeEngine,
        variant: context.getters.variant,
        options
      })

      // this will update the settings in store & local storage
      context.dispatch('setEngineOptions', options)
    },
    setEngineOptions (context, payload) {
      console.log('[engine-options] setEngineOptions:requested', {
        activeEngine: context.state.activeEngine,
        payload
      })
      if (context.getters.active && !context.getters.PvE) {
        context.dispatch('stopEngine')
      } else if (context.getters.active && context.getters.PvE && !context.getters.turn) {
        context.dispatch('stopEngine')
      }
      context.dispatch('resetEngineData')
      for (const [name, value] of Object.entries(payload)) {
        checkOption(context.state.engineInfo.options, name, value)
        if (value !== undefined && value !== null) {
          if (!filteredSettings.includes(name)) {
            context.state.engineSettings[name] = value
          }
          if (name === 'MultiPV' || name === 'UCI_Variant' || name === 'EvalFile') {
            console.log('[engine-cmd] setoption', name, value)
          }
          engine.send(`setoption name ${name} value ${value}`)
        } else {
          engine.send(`setoption name ${name}`)
        }
      }
      console.log('[engine-options] setEngineOptions:applied-snapshot', {
        activeEngine: context.state.activeEngine,
        settings: context.state.engineSettings
      })
      localStorage.setItem('engine' + context.state.activeEngine, JSON.stringify(context.state.engineSettings))
    },
    idName (context, payload) {
      context.commit('idName', payload)
    },
    idAuthor (context, payload) {
      context.commit('idAuthor', payload)
    },
    updateMultiPV (context, payload) {
      // ignore pv updates when engine is expected to be inactive
      if (!context.state.active) {
        return
      }
      // update engine stats
      const stats = { ...context.state.engineStats }
      for (const key of Object.keys(stats)) {
        if (key in payload) {
          stats[key] = payload[key]
        }
      }
      context.commit('engineStats', stats)

      // only update multipv if depth is higher than cached depth
      if (stats.isEvalCached && stats.depth <= stats.cachedDepth) return
      const targetDepth = context.state.analysisVisualization.analysisTargetDepth
      if (!context.state.deepAnalysis.running && context.state.active && targetDepth !== 'infinite' && Number.isFinite(Number(targetDepth)) && stats.depth >= Number(targetDepth)) {
        context.dispatch('stopEngine')
        context.commit('analysisMode', false)
        return
      }

      // update pvline
      if ('pv' in payload) {
        context.commit('lastAnalysisResult', {
          cp: typeof payload.cp === 'number' ? payload.cp : context.state.lastAnalysisResult.cp,
          mate: typeof payload.mate === 'number' ? payload.mate : null,
          pv: payload.pv || '',
          ucimove: payload.pv ? payload.pv.split(/\s/)[0] : '',
          turn: context.state.turn
        })
        const multipv = context.getters.multipv.slice(0)

        // handle checkmate
        if (payload.mate === 0) {
          multipv[0] = { mate: payload.mate }
        } else {
          const ucimove = payload.pv.split(/\s/)[0]
          const { board } = context.state

          // assert first move is valid
          if (board.legalMoves().includes(ucimove)) {
            const pvline = {
              cp: payload.cp,
              mate: payload.mate,
              pvUCI: payload.pv,
              ucimove
            }
            if (Array.isArray(payload.wdl)) {
              pvline.wdl = payload.wdl
            }
            // attach engine-provided WDL info when available (fractions 0..1)
            if ('wdlWin' in payload || 'wdlDraw' in payload || 'wdlLoss' in payload) {
              pvline.wdlWin = typeof payload.wdlWin === 'number' ? payload.wdlWin : parseFloat(payload.wdlWin)
              pvline.wdlDraw = typeof payload.wdlDraw === 'number' ? payload.wdlDraw : parseFloat(payload.wdlDraw)
              pvline.wdlLoss = typeof payload.wdlLoss === 'number' ? payload.wdlLoss : parseFloat(payload.wdlLoss)
            }
            try {
              pvline.pv = board.variationSan(payload.pv)
            } catch (err) {
              // currently invalid moves cause ffish to error mid calculation and fail to reset the fen
              // so to avoid getting stuck with a future fen, we reset the board fen on error
              board.setFen(context.state.fen)
              console.warn('Invalid engine pv move.\nFEN:', board.fen(), '\nPV:', payload.pv)
            }
            multipv[payload.multipv - 1] = pvline
            if (typeof payload.multipv === 'number' && payload.multipv <= 5) {
              console.log('[multipv] idx', payload.multipv, 'depth', payload.depth, 'uci', pvline.ucimove, 'pv', payload.pv)
            }
          }
        }
        context.commit('multipv', multipv)
        stats.isEvalCached = false
      }
      if (!('pv' in payload)) return
      const depth = payload.depth
      const mate = payload.mate

      if (typeof depth !== 'number') return
      if (depth < MIN_CACHE_DEPTH && typeof mate !== 'number') return
      const positionKey = context.getters.normalizedFen
      const engineName = context.getters.engineName
      const cacheKey = `${positionKey}|${engineName}|${depth}|${payload.multipv}`
      if (cacheKey === lastCacheKey) return
      lastCacheKey = cacheKey
      console.log(JSON.stringify(payload.multipv))
      if (ipcRenderer && ipcRenderer.send) {
        ipcRenderer.send('eval-cache-put', {
          positionKey,
          engineName,
          depth,
          cp: payload.cp,
          wdl: payload.wdl,
          mate,
          pv: payload.pv,
          multipv: payload.multipv,
          updatedAt: Date.now()
        })
      }
    },
    loadedGames (context, payload) {
      context.commit('loadedGames', payload)
    },
    rounds (context, payload) {
      context.commit('rounds', payload)
    },
    async loadGame (context, payload) {
      context.commit('openedPGN', true)
      let variant = payload.game.headers('Variant').toLowerCase()
      if (variant === '') { // if no variant is given we assume it to be standard chess
        variant = 'chess'
      }

      if (!context.getters.variantOptions.revGet(variant)) {
        alert('This variant is currently not supported.')
        return
      }

      const gameInfo = {}
      for (const curVal of payload.game.headerKeys().split(' ')) {
        gameInfo[curVal] = payload.game.headers(curVal)
      }

      let fen = payload.game.headers('FEN')

      let is960 = false
      if (variant === 'fischerandom' || variant === 'chess960') {
        variant = 'chess'
        is960 = true
        context.state.curVar960Fen = fen
      }

      await context.dispatch('variant', variant)

      if (fen === '') { // if no FEN is given we use the standard starting FEN for this variant
        context.commit('newBoard')
        fen = context.state.startFen
      } else {
        context.commit('newBoard', { fen: fen, is960: is960 })
      }
      await context.dispatch('fen', fen)
      context.commit('selectedGame', payload.game)
      context.commit('gameInfo', gameInfo)
      const moves = payload.game.mainlineMoves().split(' ')
      // Parse comments from the original PGN if available
      let commentMap = {}
      if (payload.game.originalPGN) {
        commentMap = extractCommentsFromPGN(payload.game.originalPGN)
      }
      for (const num in moves) {
        if (num === 0) {
          context.commit('appendMoves', { move: moves[num], prev: undefined, comment: commentMap[0] })
        } else {
          context.commit('appendMoves', { move: moves[num], prev: context.state.moves[num - 1], comment: commentMap[num] }) // TODO differentiate between alternative lines
        }
      }
      context.dispatch('updateBoard')
      context.dispatch('setEngineOptions', { UCI_Chess960: is960 })
      context.commit('openedPGN', false)
    },
    increment (context, payload) {
      context.commit('increment', payload)
    },
    pieceStyle (context, payload) {
      context.commit('pieceStyle', payload)
    },
    viewAnalysis (context, payload) {
      context.commit('viewAnalysis', payload)
    },
    boardStyle (context, payload) {
      context.commit('boardStyle', payload)
    },
    analysisMode (context, payload) {
      context.commit('analysisMode', payload)
    },
    async toggleAnalysisMode (context) {
      if (context.state.active) {
        context.dispatch('stopEngine')
        context.commit('analysisMode', false)
      } else if (context.state.analysisVisualization.analysisModeType === 'deep') {
        await context.dispatch('startDeepAnalysis')
        context.commit('analysisMode', false)
      } else {
        // Ensure engine options are sent before position/go so MultiPV activates reliably.
        const topN = context.state.analysisVisualization.multiPvCount
        const multiPvValue = typeof topN === 'number' && topN > 0 ? topN : 1
        await context.dispatch('setEngineOptions', {
          MultiPV: multiPvValue,
          UCI_Variant: context.getters.variant
        })
        await context.dispatch('position')
        context.dispatch('goEngine')
        context.commit('analysisMode', true)
      }
    },
    toggleEditorMode (context) {
      const enteringEditor = !context.state.editorMode
      if (enteringEditor && context.state.active) {
        context.dispatch('stopEngine')
      }
      context.commit('editorMode', enteringEditor)
      if (enteringEditor) {
        context.commit('analysisMode', false)
      } else {
        context.commit('commitEditorPositionAsStart')
        context.commit('reviewPrepareFullRebuild')
        context.dispatch('resetEngineData')
        context.dispatch('position')
        if (context.state.analysisMode) {
          context.dispatch('goEngine')
        }
      }
    },
    analysisVisualization (context, payload) {
      context.commit('analysisVisualization', payload)
    },
    async startDeepAnalysis (context) {
      if (context.state.deepAnalysis.running) return
      if (context.getters.active) {
        context.dispatch('stopEngine')
      }
      context.dispatch('resetEngineData')
      context.commit('deepAnalysisStart')
      context.commit('active', true)
      context.commit('analysisMode', true)
      const cfg = context.state.analysisVisualization
      const settings = {
        candidateCount: cfg.deepCandidateCount,
        rootTimeMs: cfg.deepRootTimeMs,
        timePerCandidateMs: cfg.deepTimePerCandidateMs,
        secondaryTimeMs: cfg.deepSecondaryTimeMs,
        depthPerCandidate: cfg.deepDepthPerCandidate,
        clearHashBetweenCandidates: cfg.deepClearHashBetweenCandidates,
        instabilitySensitivityCp: cfg.deepInstabilitySensitivityCp,
        scheduleMode: cfg.deepScheduleMode,
        maxDurationMs: cfg.deepMaxDurationMs,
        diversityThreshold: cfg.deepDiversityThreshold
      }
      console.log('[deep-analysis] start', { fen: context.getters.fen, variant: context.getters.variant, settings })
      const result = await engine.deepAnalysis({
        fen: context.getters.fen,
        variant: context.getters.variant,
        settings
      })
      console.log('[deep-analysis] result', result)
      context.commit('deepAnalysisResult', result)
      context.commit('resetEngineTime')
      context.commit('active', false)
      context.commit('analysisMode', false)
    },
    clearDeepAnalysis (context) {
      context.commit('deepAnalysisClear')
    },
    setReviewMarkerMode (context, payload) {
      context.commit('reviewMarkerMode', payload)
    },
    previewReviewMove (context, payload) {
      context.commit('reviewPreviewSet', payload)
    },
    clearReviewPreview (context) {
      context.commit('reviewPreviewClear')
    },
    startReviewSequence (context) {
      const previousInteraction = {
        analysisMode: context.state.analysisMode,
        editorMode: context.state.editorMode
      }
      if (context.state.editorMode) {
        context.commit('editorMode', false)
      }
      const board = context.getters.is960
        ? new ffish.Board(context.getters.variant, context.getters.fen, true)
        : new ffish.Board(context.getters.variant, context.getters.fen)
      context.commit('reviewSequenceStart', {
        fen: context.getters.fen,
        turn: board.turn(),
        legalMoves: board.legalMoves(),
        previousInteraction
      })
      if (context.getters.active) {
        context.dispatch('stopEngine')
      }
    },
    addReviewSequenceMove (context, move) {
      if (!context.state.review.sequence.active || !move) return
      const sequence = context.state.review.sequence
      const board = context.getters.is960
        ? new ffish.Board(context.getters.variant, sequence.fen, true)
        : new ffish.Board(context.getters.variant, sequence.fen)
      const legalMoves = board.legalMoves()
      const resolvedMove = resolveReviewSequenceMove(legalMoves, move)
      if (!resolvedMove) {
        context.commit('reviewSetError', `임시 검토 수순에서 둘 수 없는 수입니다: ${move}`)
        return false
      }
      let san = resolvedMove
      try { san = board.sanMove(resolvedMove) } catch (err) {}
      board.push(resolvedMove)
      const line = sequence.line.concat(resolvedMove)
      const sans = sequence.sans.concat(san)
      context.commit('reviewSequenceUpdate', {
        fen: board.fen(),
        turn: board.turn(),
        legalMoves: board.legalMoves(),
        line,
        sans,
        lastMove: resolvedMove
      })
      return true
    },
    clearReviewSequence (context) {
      if (!context.state.review.sequence.active) return
      const board = context.getters.is960
        ? new ffish.Board(context.getters.variant, context.state.review.sequence.baseFen, true)
        : new ffish.Board(context.getters.variant, context.state.review.sequence.baseFen)
      context.commit('reviewSequenceClear')
      context.commit('reviewSequenceUpdate', {
        fen: board.fen(),
        turn: board.turn(),
        legalMoves: board.legalMoves(),
        line: [],
        sans: [],
        lastMove: null
      })
    },
    cancelReviewSequence (context) {
      context.commit('reviewSequenceEnd')
    },
    reviewCurrentSequence (context) {
      const sequence = context.state.review.sequence
      if (!sequence.active || sequence.line.length === 0) {
        context.commit('reviewSetError', '검토할 임시 수순을 먼저 보드에서 직접 진행해 주세요.')
        return Promise.resolve(null)
      }
      return context.dispatch('requestReview', {
        mode: REVIEW_MODES.LINE,
        fen: sequence.baseFen,
        move: sequence.line[0],
        moveSan: sequence.sans[0],
        line: sequence.line,
        markerMode: context.state.review.markerMode,
        context: {
          markerMode: context.state.review.markerMode,
          sequenceSans: sequence.sans,
          finalFen: sequence.fen,
          temporary: true
        }
      })
    },
    async requestReview (context, payload) {
      const reviewCfg = context.state.analysisVisualization
      const startedAt = Date.now()
      const debug = Boolean(reviewCfg && reviewCfg.debugReviewPipeline)
      const request = createReviewRequest({
        ...payload,
        id: payload.id || `review-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        variant: payload.variant || context.getters.variant,
        engineName: payload.engineName || context.getters.engineName,
        multipv: payload.multipv || context.getters.multipv,
        markerMode: payload.markerMode || context.state.review.markerMode,
        context: {
          ...(payload.context || {}),
          reviewDepth: reviewCfg.reviewDepth,
          tacticalDepth: reviewCfg.reviewTacticalDepth,
          strategicHorizon: reviewCfg.reviewStrategicHorizon,
          punishmentLineLength: reviewCfg.reviewPunishmentLineLength,
          detailLevel: reviewCfg.reviewDetailLevel,
          depthPreset: reviewCfg.reviewDepthPreset
        }
      })
      const realtimeSource = request.context && request.context.source === 'realtime-played-line'
      replayTrace(debug, 'request:create', {
        replaySessionId: payload && payload.replaySessionId ? payload.replaySessionId : null,
        replayMoveIndex: payload && Number.isFinite(payload.replayMoveIndex) ? payload.replayMoveIndex : null,
        requestId: request.id,
        lineLength: Array.isArray(request.line) ? request.line.length : 0,
        source: request.context && request.context.source
      })
      context.commit('reviewSetRequest', request.id)

      try {
        try {
          replayTrace(debug, 'request:engine-dispatch', { requestId: request.id })
          request.engineAnalysis = await engine.reviewAnalysis({
            fen: request.fen,
            move: request.move,
            line: request.line,
            depth: request.context && request.context.reviewDepth ? request.context.reviewDepth : context.state.analysisVisualization.reviewDepth,
            multiPv: 3,
            perMoveDepth: request.context && request.context.tacticalDepth ? request.context.tacticalDepth : context.state.analysisVisualization.reviewTacticalDepth,
            maxReviewMoves: context.state.analysisVisualization.reviewStrategicHorizon,
            plyBase: request.context && Number.isFinite(request.context.plyBase) ? request.context.plyBase : 0,
            punishmentLineLength: context.state.analysisVisualization.reviewPunishmentLineLength,
            detailLevel: context.state.analysisVisualization.reviewDetailLevel,
            variant: request.variant
          })
          replayTrace(debug, 'request:engine-finish', {
            requestId: request.id,
            engineMoveCount: request.engineAnalysis && Array.isArray(request.engineAnalysis.moves) ? request.engineAnalysis.moves.length : 0,
            engineError: request.engineAnalysis && request.engineAnalysis.error ? request.engineAnalysis.error : null
          })
        } catch (err) {
          request.engineAnalysis = { error: err.message }
          replayTrace(debug, 'request:engine-error', { requestId: request.id, error: err.message })
        }

        let result
        if (ipcRenderer && ipcRenderer.invoke) {
          result = await ipcRenderer.invoke('review-analyze', request)
        } else {
          result = analyzeReviewRequest(request)
        }
        if (context.state.review.lastRequestId !== request.id) {
          if (realtimeSource) realtimeStaleDiscardCount += 1
          replayTrace(debug, 'request:discard-stale', {
            requestId: request.id,
            lastRequestId: context.state.review.lastRequestId,
            realtimeSessionId: payload && payload.realtimeSessionId ? payload.realtimeSessionId : null,
            staleDiscardCount: realtimeStaleDiscardCount
          })
          return null
        }
        if (!result || result.error) {
          context.commit('reviewSetError', result && result.error ? result.error : 'Review failed')
          return null
        }
        if (reviewCfg.debugReviewPipeline) {
          const moveCount = Array.isArray(result.moves) ? result.moves.length : 0
          const overlayCount = Array.isArray(result.overlays) ? result.overlays.length : 0
          const queueSize = context.state.review.loading ? 1 : 0
          const requestContext = request.context || {}
          const fallbackCount = Array.isArray(result.moves)
            ? result.moves.filter(move => move && move.classification === 'good_move').length
            : 0
          if (realtimeSource) realtimeFallbackClassificationCount += fallbackCount
          console.debug('[review-pipeline]', {
            id: request.id,
            source: request.context && request.context.source,
            realtimeSessionId: payload && payload.realtimeSessionId ? payload.realtimeSessionId : null,
            moveIndex: Array.isArray(request.line) ? request.line.length : 0,
            rollingWindowRange: Array.isArray(request.line) ? `${Math.max(1, request.line.length - 5)}-${request.line.length}` : null,
            totalLineLength: request.line ? request.line.length : 0,
            analyzedMoveCount: moveCount,
            overlayCount,
            activeRequestCount: context.state.review.loading ? 1 : 0,
            staleDiscardCount: realtimeStaleDiscardCount,
            queueSize,
            fallbackClassificationCount: realtimeFallbackClassificationCount,
            markerMode: requestContext.markerMode || null,
            elapsedMs: Date.now() - startedAt,
            loading: context.state.review.loading
          })
        }
        if (request.context && request.context.deferCommit) {
          replayTrace(debug, 'request:return-defer-commit', { requestId: request.id })
          return result
        }
        context.commit('reviewSetResult', result)
        replayTrace(debug, 'request:commit', {
          requestId: request.id,
          moveCount: Array.isArray(result.moves) ? result.moves.length : 0
        })
        return result
      } catch (err) {
        if (context.state.review.lastRequestId === request.id) {
          context.commit('reviewSetError', err && err.message ? err.message : 'Review failed')
        }
        return null
      } finally {
        context.commit('reviewReleaseRequestLock', { requestId: request.id })
      }
    },


    async replayPlayedLineReview (context, payload = {}) {
      const line = Array.isArray(payload.line) ? payload.line.filter(Boolean) : []
      if (line.length === 0) {
        context.commit('reviewSetError', '분석할 기보 수순이 없습니다. 먼저 수를 입력하거나 기보를 불러와 주세요.')
        return Promise.resolve(null)
      }
      context.commit('reviewPrepareFullRebuild')
      let result = null
      const debug = Boolean(context.state.analysisVisualization && context.state.analysisVisualization.debugReviewPipeline)
      const replaySessionId = ++replaySessionSeq
      replayTrace(debug, 'session:start', {
        replaySessionId,
        totalMoves: line.length,
        reviewActive: context.state.review.active,
        reviewLoading: context.state.review.loading
      })
      for (let idx = 0; idx < line.length; idx++) {
        replayTrace(debug, 'step:enqueue', { replaySessionId, idx, ply: idx + 1, queueSize: 1 })
        result = await context.dispatch('reviewPlayedLine', {
          ...payload,
          line: line.slice(0, idx + 1),
          sans: Array.isArray(payload.sans) ? payload.sans.slice(0, idx + 1) : [],
          incremental: true,
          fullRebuild: false,
          replayFromStart: true,
          replaySessionId,
          replayMoveIndex: idx
        })
        if (!result) {
          replayTrace(debug, 'session:abort-null-result', {
            replaySessionId,
            idx,
            lastRequestId: context.state.review.lastRequestId,
            reviewLoading: context.state.review.loading
          })
          return null
        }
        replayTrace(debug, 'step:applied', {
          replaySessionId,
          idx,
          ply: idx + 1,
          reviewedLineLength: Array.isArray(result.reviewedLine) ? result.reviewedLine.length : 0,
          markerCount: Array.isArray(result.markerMoves) ? result.markerMoves.length : 0,
          overlayCount: Array.isArray(context.state.review.overlays) ? context.state.review.overlays.length : 0,
          reviewLoading: context.state.review.loading
        })
      }
      replayTrace(debug, 'session:complete', {
        replaySessionId,
        totalMoves: line.length,
        finalOverlayCount: Array.isArray(context.state.review.overlays) ? context.state.review.overlays.length : 0
      })
      return result
    },

    async reviewPlayedLine (context, payload = {}) {
      const line = Array.isArray(payload.line) ? payload.line.filter(Boolean) : []
      if (line.length === 0) {
        context.commit('reviewSetError', '분석할 기보 수순이 없습니다. 먼저 수를 입력하거나 기보를 불러와 주세요.')
        return Promise.resolve(null)
      }
      if (payload.fullRebuild === true) {
        return context.dispatch('replayPlayedLineReview', payload)
      }
      const markerMode = payload.markerMode || context.state.review.markerMode
      const baseFen = payload.fen || context.getters.startFen
      const fullSans = Array.isArray(payload.sans) ? payload.sans : []
      const incrementalRequested = payload.incremental === true
      const fullRebuild = payload.fullRebuild === true || !incrementalRequested
      const requestContext = {
        markerMode,
        currentFen: context.getters.fen,
        manualGame: Boolean(payload.manualGame),
        source: payload.source || 'played-line',
        sequenceSans: fullSans,
        incrementalMode: incrementalRequested,
        fullRebuild,
        replayFromStart: payload.replayFromStart === true,
        deferCommit: false
      }
      if (fullRebuild) context.commit('reviewPrepareFullRebuild')
      const previous = context.state.review.currentResult
      const previousContext = previous && previous.requestContext ? previous.requestContext : {}
      const previousLine = previous && Array.isArray(previous.reviewedLine) ? previous.reviewedLine : []
      const prefixLength = reviewLinePrefixLength(previousLine, line)
      const canExtend = incrementalRequested &&
        previous &&
        previous.fen === baseFen &&
        previousContext.manualGame &&
        prefixLength >= 2 &&
        prefixLength === previousLine.length &&
        prefixLength < line.length &&
        Array.isArray(previous.moves) &&
        previous.moves[prefixLength - 1] &&
        previous.moves[prefixLength - 1].previewFen
      if (canExtend) {
        const suffixLine = line.slice(prefixLength)
        const suffixSans = fullSans.slice(prefixLength)
        const suffixResult = await context.dispatch('requestReview', {
          mode: REVIEW_MODES.LINE,
          fen: previous.moves[prefixLength - 1].previewFen,
          move: suffixLine[0],
          moveSan: suffixSans[0] || suffixLine[0],
          line: suffixLine,
          markerMode,
          context: {
            ...requestContext,
            deferCommit: true,
            incremental: true,
            prefixLength,
            baseFen,
            plyBase: prefixLength
          }
        })
        if (suffixResult) {
          const merged = mergeIncrementalReviewResult({
            previous,
            suffix: suffixResult,
            fullLine: line,
            fullSans,
            markerMode,
            prefixLength,
            requestContext
          })
          context.commit('reviewSetResult', merged)
          return merged
        }
      }
      if (incrementalRequested &&
        previous &&
        previous.fen === baseFen &&
        previousContext.manualGame &&
        prefixLength > 0 &&
        prefixLength < line.length
      ) {
        const fullResult = await context.dispatch('requestReview', {
          mode: REVIEW_MODES.LINE,
          fen: baseFen,
          move: line[0],
          moveSan: fullSans[0] || line[0],
          line,
          markerMode,
          context: {
            ...requestContext,
            deferCommit: true,
            incremental: true,
            preservePrefixLength: prefixLength
          }
        })
        if (!fullResult) return null
        const suffixResult = suffixOnlyReviewResultFromFull({ result: fullResult, prefixLength })
        if (suffixResult && Array.isArray(suffixResult.moves) && suffixResult.moves.length) {
          const merged = mergeIncrementalReviewResult({
            previous,
            suffix: suffixResult,
            fullLine: line,
            fullSans,
            markerMode,
            prefixLength,
            requestContext
          })
          context.commit('reviewSetResult', merged)
          return merged
        }
        context.commit('reviewSetResult', previous)
        return previous
      }
      return context.dispatch('requestReview', {
        mode: REVIEW_MODES.LINE,
        fen: baseFen,
        move: line[0],
        moveSan: fullSans[0] || line[0],
        line,
        markerMode,
        context: requestContext
      })
    },
    reviewCurrentMove (context) {
      const move = context.getters.currentMove[0]
      if (!move) {
        context.commit('reviewSetError', '검토할 기보의 수를 먼저 선택해 주세요.')
        return Promise.resolve(null)
      }
      return context.dispatch('requestReview', {
        mode: REVIEW_MODES.MOVE,
        fen: move.prev ? move.prev.fen : context.getters.startFen,
        move: move.uci,
        moveSan: move.name,
        line: [move.uci],
        multipv: [],
        markerMode: context.state.review.markerMode,
        context: {
          markerMode: context.state.review.markerMode,
          currentFen: context.getters.fen,
          ply: move.ply
        }
      })
    },
    async recheckReviewedMove (context, payload = {}) {
      const targetPly = Number(payload.ply)
      const current = context.state.review.currentResult
      if (!current || !Number.isFinite(targetPly)) return null
      const existingMoves = Array.isArray(current.moves) ? current.moves : []
      const targetMove = existingMoves.find(move => move && move.ply === targetPly)
      if (!targetMove || !targetMove.move) return null
      const loadingMap = context.state.review.recheckByPly || {}
      if (loadingMap[String(targetPly)]) return null

      const line = Array.isArray(current.reviewedLine) ? current.reviewedLine.slice(0, targetPly) : []
      if (!line.length) return null
      const seq = ++singleMoveRecheckSeq
      context.commit('reviewSingleMoveRecheckStart', targetPly)
      try {
        const reviewDepth = Math.max(4, (context.state.analysisVisualization.reviewDepth || 10) + 2)
        const tacticalDepth = Math.max(4, (context.state.analysisVisualization.reviewTacticalDepth || 8) + 2)
        const result = await context.dispatch('requestReview', {
          mode: REVIEW_MODES.LINE,
          fen: current.fen,
          move: line[0],
          moveSan: current.moveSan || line[0],
          line,
          markerMode: current.markerMode || context.state.review.markerMode,
          context: {
            ...(current.requestContext || {}),
            source: 'single-move-recheck',
            reviewDepth,
            tacticalDepth,
            deferCommit: true
          }
        })
        if (!result || seq !== singleMoveRecheckSeq) return null
        const rechecked = Array.isArray(result.moves) ? result.moves.find(move => move && move.ply === targetPly) : null
        if (!rechecked) return null
        context.commit('reviewPatchSingleMove', { move: rechecked })
        return rechecked
      } finally {
        context.commit('reviewSingleMoveRecheckEnd', targetPly)
      }
    },
    reviewCustomMove (context, move) {
      if (!move) {
        context.commit('reviewSetError', '검토할 수를 먼저 입력해 주세요.')
        return Promise.resolve(null)
      }
      return context.dispatch('requestReview', {
        mode: REVIEW_MODES.CUSTOM_MOVE,
        fen: context.getters.fen,
        move,
        line: [move],
        markerMode: context.state.review.markerMode,
        context: { markerMode: context.state.review.markerMode, currentFen: context.getters.fen }
      })
    },
    reviewLine (context, line) {
      const cleanLine = Array.isArray(line) ? line.filter(Boolean) : []
      if (cleanLine.length === 0) {
        context.commit('reviewSetError', '검토할 수순을 한 수 이상 입력해 주세요.')
        return Promise.resolve(null)
      }
      return context.dispatch('requestReview', {
        mode: REVIEW_MODES.LINE,
        fen: context.getters.fen,
        move: cleanLine[0],
        line: cleanLine,
        markerMode: context.state.review.markerMode,
        context: { markerMode: context.state.review.markerMode, currentFen: context.getters.fen }
      })
    },
    clearReview (context) {
      context.commit('reviewClear')
    },
    openedPGN (context, payload) {
      context.commit('openedPGN', payload)
    },
    menuAtMove (context, payload) {
      context.commit('menuAtMove', payload)
    },
    displayMenu (context, payload) {
      context.commit('displayMenu', payload)
    },
    switchDarkMode (context) {
      context.commit('switchDarkMode')
    },
    quicktourIndexIncr (context) {
      context.commit('quicktourIndexIncr')
    },
    quicktourIndexDecr (context) {
      context.commit('quicktourIndexDecr')
    },
    quicktourSetZero (context) {
      context.commit('quicktourSetZero')
    },
    switchMuteButton (context) {
      context.commit('switchMuteButton')
    },
    evalPlotDepth (context, payload) {
      context.commit('evalPlotDepth', payload)
    },
    saveSettings (context) {
      context.commit('saveSettings')
    },

    // action wrapper to reset
    async resetAllSettings ({ commit, dispatch }) {
      // stop any running engine and timers
      try {
        await dispatch('stopEngine') // clears engine timer and active flag
      } catch (e) {}

      // reset engine runtime data (multipv + engineStats)
      try {
        await dispatch('resetEngineData')
        commit('resetEngineTime') // clears interval
      } catch (e) {}

      // clear persisted engine lists / per-engine settings for full reset
      try {
        localStorage.removeItem('engines')
        // remove any keys that start with 'engine'
        for (const key in localStorage) {
          if (typeof key === 'string' && key.startsWith('engine')) {
            localStorage.removeItem(key)
          }
        }
      } catch (e) {}

      // clear piece/board style choices saved per-variant
      try {
        const styleKeys = [
          'internationalPieceStyle', 'internationalBoardStyle',
          'shogiPieceStyle', 'shogiBoardStyle',
          'seaPieceStyle', 'seaBoardStyle',
          'xiangqiPieceStyle', 'xiangqiBoardStyle',
          'janggiPieceStyle', 'janggiBoardStyle'
        ]
        for (const k of styleKeys) {
          localStorage.removeItem(k)
        }
      } catch (e) {}

      // commit the state-level defaults
      commit('resetAllSettings')

      // ensure engine runtime counters are zeroed
      commit('resetEngineStats')

      // replace the board with a fresh one (safer than board.load)
      try {
        commit('newBoard')
      } catch (e) {}

      // persist basic UI settings
      try {
        dispatch('saveSettings')
      } catch (e) {}

      // re-run initialize to pick default engine / options like at app start
      try {
        await dispatch('initialize')
      } catch (e) {}
    },

    // Hard runtime reset: clear session/runtime state while preserving user preferences.
    async fullResetSession ({ state, getters, commit, dispatch }) {
      const keepVariant = state.variant
      const selectedEngineBinary = getters.engineBinary
      const selectedEngineCwd = getters.selectedEngine && getters.selectedEngine.cwd

      // Stop all engine activity and invalidate pending single-move async responses.
      commit('nextSingleMoveRequestSeq')
      try { await dispatch('EvEfalse') } catch (e) {}
      try { await dispatch('PvEfalse') } catch (e) {}
      try { await dispatch('stopEngine') } catch (e) {}
      try { commit('resetEngineTime') } catch (e) {}

      // Clear transient runtime/session state.
      try { dispatch('resetEngineData') } catch (e) {}
      try { commit('clearIO') } catch (e) {}
      try { commit('reviewClear') } catch (e) {}
      try { commit('reviewSequenceEnd') } catch (e) {}
      try { commit('showGameEndModal', false) } catch (e) {}
      commit('PvE', false)
      commit('EvE', false)
      commit('PvEEngineInstance', null)
      commit('engineWhiteInstance', null)
      commit('engineBlackInstance', null)
      commit('enginesActive', [false, false])
      commit('active', false)
      commit('playVsEngineEnabled', false)

      // Rebuild board/session domain akin to fresh launch (preserve user settings/theme).
      commit('variant', keepVariant)
      commit('newBoard', { is960: false, fen: '' })
      dispatch('updateBoard')
      dispatch('position')

      // Recreate engine runtime process instance for long-session stability.
      if (selectedEngineBinary && selectedEngineCwd) {
        try {
          await dispatch('runBinary', { binary: selectedEngineBinary, cwd: selectedEngineCwd })
        } catch (e) {
          console.warn('[fullResetSession] Failed to recreate engine runtime:', e)
        }
      }
    }
  },
  getters: {
    engineNumber (state) {
      return state.numberOfEngines
    },
    engineIndex (state) {
      return state.engineIndex
    },
    enginesActive (state) {
      return state.enginesActive
    },
    currentMove (state) {
      return state.moves.filter(moves => moves.fen === state.fen)
    },
    gameState (state) {
      return {
        ...state.gameState,
        fen: state.fen,
        is960: state.board && state.board.is960 && state.board.is960()
      }
    },
    getMoveByUCIAndPrev (state, uci, prev) {
      return (uci, prev) => state.moves.filter(moves => moves.uci === uci && moves.prev === prev)
      /* const moves = state.moves
      for (const i in moves) {
        if (moves[i].uci === uci && moves[i].prev === prev) {
          return moves[i]
        }
      }
      return null */
    },
    curVar960Fen (state) {
      return state.curVar960Fen
    },
    board (state) {
      return state.board
    },
    initialized (state) {
      return state.initialized
    },
    active (state) {
      return state.active
    },
    PvE (state) {
      return state.PvE
    },
    playVsEngineEnabled (state) {
      return state.playVsEngineEnabled
    },
    playVsEngineHumanSide (state) {
      return state.playVsEngineHumanSide
    },
    engineTimeControlsEnabled (state) {
      return state.engineTimeControlsEnabled
    },
    engineTimeControlMode (state) {
      return state.engineTimeControlMode
    },
    engineTimeControlConfig (state) {
      return state.engineTimeControlConfig
    },
    engineSideClockMs (state) {
      return state.engineSideClockMs
    },
    EvE (state) {
      return state.EvE
    },
    PvEPlayerIsWhite (state) {
      return state.PvEPlayerIsWhite
    },
    PvEParam (state) {
      return state.PvEParam
    },
    PvEValue (state) {
      return state.PvEValue
    },
    PvEInput (state) {
      return state.PvEInput
    },
    dimNumber (state) {
      return state.dimNumber
    },
    resized (state) {
      return state.resized
    },
    resized9x9width (state) {
      return state.resized9x9width
    },
    resized9x9height (state) {
      return state.resized9x9height
    },
    resized9x10width (state) {
      return state.resized9x10width
    },
    resized9x10height (state) {
      return state.resized9x10height
    },
    started (state) {
      return state.started
    },
    redraw (state) {
      return state.redraw
    },
    fen (state) {
      return state.fen
    },
    normalizedFen (state) {
      return state.normalizedFen
    },
    lastFen (state) {
      return state.lastFen
    },
    startFen (state) {
      return state.startFen
    },
    isPast (state, getters) {
      return state.fen !== getters.lastFen
    },
    destinations (state) {
      return state.destinations
    },
    orientation (state) {
      return state.orientation
    },
    variant (state) {
      return state.variant
    },
    variantOptions (state) {
      return state.variantOptions
    },
    availableEngines (state, getters) {
      return Object.entries(state.allEngines)
        .map(([name, info]) => ({ name, ...info }))
        .filter(engine => engine.variants && engine.variants.includes(getters.variant))
    },
    selectedEngine (state) {
      return { name: state.activeEngine, ...state.allEngines[state.activeEngine] }
    },
    engineBinary (state, getters) {
      return getters.selectedEngine.binary
    },
    engineName (state) {
      return state.engineInfo.name
    },
    engineAuthor (state) {
      return state.engineInfo.author
    },
    engineOptions (state) {
      return state.engineInfo.options.filter(({ name }) => !filteredSettings.includes(name))
    },
    engineSettings (state) {
      return state.engineSettings
    },
    nnueStatus (state) {
      return state.nnueStatus
    },
    multipv (state) {
      return state.multipv
    },
    hoveredpv (state) {
      return state.hoveredpv
    },
    cp (state) {
      if (typeof state.multipv[0].cp === 'number' && (state.multipv[0].pv || typeof state.multipv[0].mate === 'number')) return state.multipv[0].cp
      return state.lastAnalysisResult.cp
    },
    wdl (state) {
      return state.multipv[0].wdl
    },
    depth (state) {
      return state.engineStats.depth || state.lastEngineStats.depth
    },
    nps (state) {
      return state.engineStats.nps || state.lastEngineStats.nps
    },
    seldepth (state) {
      return state.engineStats.seldepth || state.lastEngineStats.seldepth
    },
    nodes (state) {
      return state.engineStats.nodes || state.lastEngineStats.nodes
    },
    hashfull (state) {
      return state.engineStats.hashfull || state.lastEngineStats.hashfull
    },
    tbhits (state) {
      return state.engineStats.tbhits || state.lastEngineStats.tbhits
    },
    isEvalCached (state) {
      return state.engineStats.isEvalCached
    },
    cachedDepth (state) {
      return state.engineStats.cachedDepth
    },
    time (state) {
      return state.engineStats.time || state.lastEngineStats.time
    },
    enginetime (state) {
      return state.enginetime
    },
    pv (state) {
      return state.multipv[0].pv || state.lastAnalysisResult.pv
    },
    cpForWhite (state) {
      const hasLiveCp = typeof state.multipv[0].cp === 'number' && (state.multipv[0].pv || typeof state.multipv[0].mate === 'number')
      return hasLiveCp ? state.multipv[0].cp : state.lastAnalysisResult.cp
    },
    cpForWhiteStr (state, getters) {
      const currentMove = getters.currentMove[0]
      const mate = typeof state.multipv[0].mate === 'number' ? state.multipv[0].mate : state.lastAnalysisResult.mate

      // TODO: Update this block when ffish.board.is_terminal() or ffish.board.check_result() is available
      // Temporary fix, as lang as we don't have an `is_terminal()` or `check_result` function
      // if the SAN in the pgn is the same than the SAN in states.moves
      // and we are at the last move, return pgn result
      if (state.selectedGame) {
        const pgnBoard = new ffish.Board(state.variant, state.startFen)

        const pgnMoves = state.selectedGame.mainlineMoves()
        const san = pgnBoard.variationSan(pgnMoves, ffish.Notation.SAN, false)
        let str = ''
        state.moves.forEach(move => { str += move.name })
        const lastMove = state.moves[state.moves.length - 1]
        if (san.replace(/ /g, '') === str.replace(/ /g, '')) {
          if (lastMove === currentMove && lastMove.ply === currentMove.ply) {
            return state.selectedGame.headers('Result')
          }
        }
      }

      if (typeof mate === 'number') {
        return `#${mate}`
      } else if (state.board != null && state.board.isGameOver()) {
        return state.board.result()
      } else {
        return cpToString(getters.cpForWhite)
      }
    },
    cpForWhitePerc (state, getters) {
      const currentMove = getters.currentMove[0]
      const mate = typeof state.multipv[0].mate === 'number' ? state.multipv[0].mate : state.lastAnalysisResult.mate
      if (typeof mate === 'number') {
        return (Math.sign(mate) + 1) / 2
      } else if (currentMove && currentMove.name.includes('#')) {
        return state.turn ? 0 : 1
      } else {
        return 1 / (1 + Math.exp(-0.003 * getters.cpForWhite))
      }
    },
    cpForBarPerc (state, getters) {
      const currentMove = getters.currentMove[0]
      const liveHasPv = Boolean(state.multipv[0] && (state.multipv[0].pv || typeof state.multipv[0].mate === 'number'))
      const effectiveTurn = liveHasPv ? state.turn : (typeof state.lastAnalysisResult.turn === 'boolean' ? state.lastAnalysisResult.turn : state.turn)
      const mate = typeof state.multipv[0].mate === 'number' ? state.multipv[0].mate : state.lastAnalysisResult.mate
      if (typeof mate === 'number') {
        // Bar visualization uses fixed board-side perspective (Cho positive),
        // normalized from transient side-to-move engine outputs.
        return (calcForSide(Math.sign(mate), effectiveTurn) + 1) / 2
      } else if (currentMove && currentMove.name.includes('#')) {
        return state.turn ? 0 : 1
      }
      const liveCpRaw = typeof state.multipv[0].cp === 'number' ? state.multipv[0].cp : null
      const lastCpRaw = typeof state.lastAnalysisResult.cp === 'number' ? state.lastAnalysisResult.cp : null
      const liveCpStable = liveCpRaw === null ? null : calcForSide(liveCpRaw, state.turn)
      const lastCpStable = lastCpRaw === null ? null : calcForSide(lastCpRaw, typeof state.lastAnalysisResult.turn === 'boolean' ? state.lastAnalysisResult.turn : state.turn)

      let stableCp = calcForSide(getters.cpForWhite, effectiveTurn)
      // Live search can temporarily emit opposite-perspective scores.
      // Keep bar perspective stable by anchoring sign to last completed analysis when signs conflict.
      if (liveHasPv && liveCpStable !== null) {
        stableCp = liveCpStable
        if (lastCpStable !== null && Math.sign(liveCpStable) !== 0 && Math.sign(lastCpStable) !== 0 && Math.sign(liveCpStable) !== Math.sign(lastCpStable)) {
          stableCp = Math.sign(lastCpStable) * Math.abs(liveCpStable)
        }
      }
      return 1 / (1 + Math.exp(-0.003 * stableCp))
    },
    wdlForWhiteWin (state) {
      const wdl = normalizeWdl(state.multipv[0])
      if (wdl) {
        const win = state.turn ? wdl.win : wdl.loss
        state.lastWdlWin = win
        return win
      }
      return state.lastWdlWin
    },
    wdlForWhiteDraw (state) {
      const wdl = normalizeWdl(state.multipv[0])
      if (wdl) {
        state.lastWdlDraw = wdl.draw
        return wdl.draw
      }
      return state.lastWdlDraw
    },
    wdlForWhiteLoss (state) {
      const wdl = normalizeWdl(state.multipv[0])
      if (wdl) {
        const loss = state.turn ? wdl.loss : wdl.win
        state.lastWdlLoss = loss
        return loss
      }
      return state.lastWdlLoss
    },
    wdlForWhiteWinPct (state, getters) {
      const v = getters.wdlForWhiteWin
      return v === null ? null : v * 100
    },
    wdlForWhiteDrawPct (state, getters) {
      const v = getters.wdlForWhiteDraw
      return v === null ? null : v * 100
    },
    wdlForWhiteLossPct (state, getters) {
      const v = getters.wdlForWhiteLoss
      return v === null ? null : v * 100
    },
    message (state) {
      return state.message.toUpperCase()
    },
    counter (state) {
      return state.counter
    },
    pieceStyle (state) {
      return state.pieceStyle
    },
    boardStyle (state) {
      return state.boardStyle
    },
    turn (state) {
      return state.turn
    },
    moves (state) {
      return state.moves
    },
    firstMoves (state) {
      return state.firstMoves
    },
    mainFirstMove (state) {
      return state.mainFirstMove
    },
    legalMoves (state) {
      return state.legalMoves
    },
    pocket (state) {
      return (turn) => state.board.pocket(turn)
    },
    gameInfo (state) {
      return state.gameInfo
    },
    loadedGames (state) {
      return state.loadedGames
    },
    rounds (state) {
      return state.rounds
    },
    selectedGame (state) {
      return state.selectedGame
    },
    gameConfig (state) {
      return state.gameConfig
    },
    showGameEndModal (state) {
      return state.showGameEndModal
    },
    gameResult (state) {
      return state.gameResult
    },
    isInternational (state) {
      return state.internationalVariants.includes(state.variant)
    },
    isSEA (state) {
      return state.seaVariants.includes(state.variant)
    },
    isXiangqi (state) {
      return state.xiangqiVariants.includes(state.variant)
    },
    isJanggi (state) {
      return state.janggiVariants.includes(state.variant)
    },
    isShogi (state) {
      return state.shogiVariants.includes(state.variant)
    },

    // TODO: integrate getters into store state?
    moveStack (state) {
      return state.board.moveStack()
    },
    isGameOver (state) {
      return state.board.isGameOver()
    },
    sanMove (state) {
      return (uciMove) => state.board.sanMove(uciMove)
    },
    is960 (state) {
      return state.board.is960()
    },
    dimensionNumber (state) {
      if (state.internationalVariants.includes(state.variant)) {
        return 0
      } else {
        const var2Dim = {
          shogi: 1, xiangqi: 3, janggi: 3, janggimodern: 3, makruk: 0
        }
        return var2Dim[state.variant]
      }
    },
    viewAnalysis (state) {
      return state.viewAnalysis
    },
    evalPlotDepth (state) {
      return state.evalPlotDepth
    },
    openedPGN (state) {
      return state.openedPGN
    },
    analysisMode (state) {
      return state.analysisMode
    },
    editorMode (state) {
      return state.editorMode
    },
    analysisVisualization (state) {
      return state.analysisVisualization
    },
    lastAnalysisResult (state) {
      return state.lastAnalysisResult
    },
    deepAnalysis (state) {
      return state.deepAnalysis
    },
    review (state) {
      return state.review
    },
    reviewMarkerMode (state) {
      return state.review.markerMode
    },
    reviewResult (state) {
      return state.review.currentResult
    },
    reviewSequence (state) {
      return state.review.sequence
    },
    reviewSequenceActive (state) {
      return state.review.sequence.active
    },
    reviewPreview (state) {
      return state.review.preview
    },
    reviewPreviewActive (state) {
      return Boolean(state.review.preview && state.review.preview.active)
    },
    reviewOverlays (state) {
      if (state.review.preview && state.review.preview.active) {
        return Array.isArray(state.review.preview.overlays) ? state.review.preview.overlays : []
      }
      const resultContext = state.review.currentResult && state.review.currentResult.requestContext ? state.review.currentResult.requestContext : {}
      const realtimeStrategic = resultContext.source === 'realtime-played-line'
      const resultOverlays = Array.isArray(state.review.overlays) ? state.review.overlays : []
      const visibleResultOverlays = realtimeStrategic
        ? primaryRealtimeBoardOverlays(
          state.review.currentResult,
          resultOverlays,
          state.analysisVisualization.realtimeCommentaryArrows,
          state.fen
        )
        : resultOverlays
      const sequenceOverlays = Array.isArray(state.review.sequence.overlays) ? state.review.sequence.overlays : []
      if (!state.review.sequence.active) return visibleResultOverlays
      return visibleResultOverlays.length > 0 ? visibleResultOverlays : sequenceOverlays
    },
    menuAtMove (state) {
      return state.menuAtMove
    },
    displayMenu (state) {
      return state.displayMenu
    },
    darkMode (state) {
      return state.darkMode
    },
    QuickTourIndex (state) {
      return state.QuickTourIndex
    },
    muteButton (state) {
      return state.muteButton
    }
  }
})

ffish.onRuntimeInitialized = () => {
  store.dispatch('initialize')
}

(async () => {
  // setup debug and error output
  engine.on('debug', (...msgs) => console.log('%c[Main Engine] Debug:', 'color: #82aaff; font-weight: 700;', ...msgs))
  engine.on('error', (...msgs) => console.error('%c[Main Engine]', 'color: #82aaff; font-weight: 700;', ...msgs))
  engine.on('io', line => {
    if (typeof line === 'string' && line.startsWith('info ') && line.includes(' pv ')) {
      console.log('[engine-raw-info]', line)
    }
  })
  engine.on('eval-debug', (...msgs) => console.log('%c[Eval Engine] Debug:', 'color: #9580ff; font-weight: 700;', ...msgs))
  engine.on('eval-error', (...msgs) => console.error('%c[Eval Engine]', 'color: #9580ff; font-weight: 700;', ...msgs))
  engine.on('nnue', status => {
    store.commit('nnueStatus', status)
    const prefix = '[NNUE]'
    if (status.status === 'applied') {
      console.info(prefix, `EvalFile applied: ${status.requested}`, status)
    } else if (status.status === 'found') {
      console.info(prefix, `EvalFile found: ${status.requested}`, status)
    } else if (status.status === 'missing') {
      console.warn(prefix, `EvalFile missing: ${status.requested}. Engine default network remains active.`, status)
    } else if (status.status === 'rejected') {
      console.error(prefix, `Engine rejected EvalFile: ${status.requested}`, status)
    }
  })
  engine.on('eval-nnue', status => {
    const prefix = '[Eval NNUE]'
    if (status.status === 'applied') {
      console.info(prefix, `EvalFile applied: ${status.requested}`, status)
    } else if (status.status === 'found') {
      console.info(prefix, `EvalFile found: ${status.requested}`, status)
    } else if (status.status === 'missing') {
      console.warn(prefix, `EvalFile missing: ${status.requested}. Review engine default network remains active.`, status)
    } else if (status.status === 'rejected') {
      console.error(prefix, `Review engine rejected EvalFile: ${status.requested}`, status)
    }
  })
  engine.on('nnue-runtime', status => {
    console.info('[NNUE runtime][main]', status)
  })
  engine.on('eval-nnue-runtime', status => {
    console.info('[NNUE runtime][eval]', status)
  })
  engine.on('option-applied', option => console.log('[engine-option-applied]', option))
  engine.on('eval-option-applied', option => console.log('[eval-engine-option-applied]', option))

  // capture engine info
  engine.on('info', info => store.dispatch('updateMultiPV', info))
  engine.on('bestmove', move => store.dispatch('PvEMakeMove', move))
})()
