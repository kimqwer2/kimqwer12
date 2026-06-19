import Vue from 'vue'
import Vuex from 'vuex'
import ffish from 'ffish'
import { engine, Engine } from './engine'
import allEngines from './store/engines'
import { createReviewRequest, emptyReviewState, emptyReviewSequenceState, REVIEW_MARKER_MODES, REVIEW_MODES } from '../shared/review/schema'
import { analyzeReviewRequest } from '../shared/review/reviewService'
import { buildMainlineFromMove } from '../shared/gameSequence'
import { addSequenceToOpeningGraph, applyOpeningExplorationBias, chooseWeightedCandidate, createOpeningGraph, mergeOpeningGraphs, normalizeOpeningGraph, openingCandidatesForFen, refreshTransitionMeta } from '../shared/openingGraph'
import { fenToEpd } from '../shared/openingLookup'

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


function emptyDisplayAnalysisResult () {
  return {
    cp: 0,
    mate: null,
    pv: '',
    ucimove: '',
    turn: true,
    displaySource: 'root_multipv_1',
    displayDepth: 0,
    displayEval: 0,
    probeEval: null,
    trapEval: null,
    marginCandidateEval: null,
    selectedPersonalityEval: null,
    wdl: null,
    wdlWin: null,
    wdlDraw: null,
    wdlLoss: null
  }
}

const HUMAN_TRAP_DEFAULTS = {
  enabled: false,
  multiPv: 3,
  preferredCpLoss: 25,
  maxCpLoss: 40,
  minCandidateCp: -50,
  minPunishmentCp: 120,
  minTrapScore: 55,
  probeDepth: 6,
  maxCandidates: 2,
  maxRepliesPerCandidate: 1,
  choiceProbeDepth: 4,
  choiceMaxReplies: 3,
  choiceMinLegalReplies: 6,
  choiceMaxCorrectRatio: 0.35,
  choiceNearBestCp: 60,
  choiceMinPenaltyCp: 90,
  overreactionProbeDepth: 4,
  overreactionMaxReplies: 2,
  overreactionMinPenaltyCp: 70,
  pressureProbeDepth: 4,
  pressureMaxReplies: 2,
  pressureMinScore: 45,
  maxProbeBudget: 6,
  earlyTrapScore: 85
}


const MISTAKE_PREVENTION_LEVELS = [
  { name: '입문', thresholdCp: 500 },
  { name: '초급', thresholdCp: 400 },
  { name: '중급', thresholdCp: 300 },
  { name: '고급', thresholdCp: 250 },
  { name: '준고수', thresholdCp: 200 },
  { name: '고수', thresholdCp: 175 },
  { name: '9단', thresholdCp: 150 },
  { name: '국수', thresholdCp: 125 },
  { name: '명인', thresholdCp: 100 },
  { name: '천하제일', thresholdCp: 75 },
  { name: 'Neural', thresholdCp: 50 },
  { name: 'NNUE', thresholdCp: 25 },
  { name: 'Oracle', thresholdCp: 10 }
]


function sampleHumanLikeLoss (maxLoss) {
  const r = Math.random()
  const shaped = Math.pow(r, 2.15)
  return Math.round(shaped * Math.max(0, maxLoss))
}

function scoreTrainingCandidate (candidate, targetLoss, chaos = false) {
  const lossDistance = Math.abs(candidate.cpLoss - targetLoss)
  const smallMistakeBonus = !chaos && candidate.cpLoss <= 30 ? 30 : (candidate.cpLoss <= 100 ? 18 : 0)
  const rareLargePenalty = !chaos && candidate.cpLoss > targetLoss * 1.35 ? 45 : (candidate.cpLoss > targetLoss * 1.35 ? 25 : 0)
  return lossDistance - smallMistakeBonus + rareLargePenalty + Math.random() * (chaos ? 18 : 8)
}

function fenPlyNumber (fen) {
  const parts = String(fen || '').trim().split(/\s+/)
  const whiteToMove = parts[1] !== 'b'
  const fullmove = Math.max(1, Number(parts[5]) || 1)
  return Math.max(1, (fullmove - 1) * 2 + (whiteToMove ? 1 : 2))
}

function phaseAdjustedMaxLoss (maxLoss, fen, chaos = false) {
  if (chaos) return maxLoss
  const ply = fenPlyNumber(fen)
  if (ply <= 20) return Math.min(maxLoss, Math.max(15, Math.round(maxLoss * 0.30)))
  if (ply <= 36) return Math.min(maxLoss, Math.max(25, Math.round(maxLoss * 0.55)))
  return maxLoss
}

function humanLikeTargetLoss (maxLoss, chaos = false) {
  if (chaos) return sampleHumanLikeLoss(maxLoss)
  const r = Math.random()
  const shaped = Math.pow(r, 3.4)
  return Math.round(shaped * Math.max(0, maxLoss))
}

function practicalCpLoss ({ rawCpLoss, beforeCp, userCp }) {
  if (beforeCp === null || userCp === null) return rawCpLoss
  if (userCp >= beforeCp) return 0
  if (userCp >= 300) return Math.max(0, rawCpLoss - 250)
  if (beforeCp > 0 && userCp >= 100) return Math.max(0, rawCpLoss - 150)
  if (beforeCp >= 0 && userCp >= 0) return Math.max(0, rawCpLoss - 75)
  return rawCpLoss
}

async function selectTrainingOpponentMove ({ engineInstance, fen, variant, is960, level, chaos = false }) {
  const configuredMaxLoss = Math.max(0, Number(level && level.thresholdCp) || 300)
  const maxLoss = phaseAdjustedMaxLoss(configuredMaxLoss, fen, chaos)
  let board
  try { board = boardFromFen(variant, fen, is960) } catch (err) { return null }
  const legal = board.legalMoves()
  const moves = (Array.isArray(legal) ? legal : String(legal || '').split(/\s+/)).filter(Boolean)
  if (!moves.length) return null
  const bestRaw = await engineInstance.evaluate(fen, 6)
  const bestCp = parseEngineScoreToCp(bestRaw)
  if (bestCp === null) return null
  const sampleSize = Math.min(moves.length, Math.max(8, Math.ceil(Math.sqrt(moves.length) * 3)))
  const shuffled = moves.slice().sort(() => Math.random() - 0.5)
  const candidates = []
  for (const move of shuffled.slice(0, sampleSize)) {
    try {
      const b = boardFromFen(variant, fen, is960)
      b.push(move)
      const afterRaw = await engineInstance.evaluate(b.fen(), 3)
      const afterCp = parseEngineScoreToCp(afterRaw)
      if (afterCp === null) continue
      const estimatedForMover = -afterCp
      const cpLoss = Math.max(0, bestCp - estimatedForMover)
      if (cpLoss <= maxLoss) candidates.push({ move, cpLoss, estimatedForMover, afterCp })
    } catch (err) {}
  }
  if (!candidates.length) return null
  const targetLoss = humanLikeTargetLoss(maxLoss, chaos)
  candidates.sort((a, b) => scoreTrainingCandidate(a, targetLoss, chaos) - scoreTrainingCandidate(b, targetLoss, chaos))
  return { ...candidates[0], targetLoss, maxLoss, configuredMaxLoss, openingProtected: maxLoss < configuredMaxLoss, sampled: candidates.length }
}

function pointLossString (cp) {
  return (Math.max(0, Number(cp) || 0) / 100).toFixed(1)
}

function moveQualityColor (cpLoss) {
  if (cpLoss <= 25) return 'green'
  if (cpLoss <= 75) return 'blue'
  if (cpLoss <= 150) return 'yellow'
  if (cpLoss <= 300) return 'orange'
  return 'red'
}

function mistakePieceFromFen (fen, move) {
  const parsed = parseUciFromTo(move)
  if (!parsed) return 'drop'
  const piece = parseFenPieceMap(fen)[parsed.from]
  return piece ? piece.replace('+', '').toUpperCase() : 'unknown'
}

function mistakeStatsFromNotebook (notebook) {
  const list = Array.isArray(notebook) ? notebook : []
  const total = list.length
  const byPiece = {}
  const byPattern = {}
  let cpTotal = 0
  let largest = 0
  for (const item of list) {
    const cp = Math.max(0, Number(item.cpLoss) || 0)
    cpTotal += cp
    largest = Math.max(largest, cp)
    const piece = item.pieceType || 'unknown'
    byPiece[piece] = (byPiece[piece] || 0) + 1
    const pattern = item.pattern || 'evaluation drop'
    byPattern[pattern] = (byPattern[pattern] || 0) + 1
  }
  const first = list[0] && list[0].timestamp
  const last = list[list.length - 1] && list[list.length - 1].timestamp
  return {
    totalMistakes: total,
    averageCpLoss: total ? Math.round(cpTotal / total) : 0,
    largestMistake: largest,
    mistakesByPieceType: byPiece,
    repeatedPatterns: byPattern,
    mistakeFrequency: first && last && first !== last ? total / Math.max(1, (new Date(last) - new Date(first)) / 86400000) : total,
    improvementOverTime: total >= 4 ? Math.round(list.slice(-Math.ceil(total / 2)).reduce((a, b) => a + (Number(b.cpLoss) || 0), 0) / Math.ceil(total / 2) - list.slice(0, Math.floor(total / 2)).reduce((a, b) => a + (Number(b.cpLoss) || 0), 0) / Math.floor(total / 2)) : 0
  }
}

function classifyMistakePattern ({ fen, move, bestMove, cpLoss }) {
  const info = moveCaptureInfo(fen, move)
  const bestInfo = moveCaptureInfo(fen, bestMove)
  if (bestInfo.isCapture && (!info.isCapture || bestInfo.capturedValue > info.capturedValue)) return 'missed capture'
  if (info.isCapture && cpLoss >= 250) return 'poisoned capture'
  if (cpLoss >= 300) return 'tactical oversight'
  if (cpLoss >= 150) return 'material loss'
  return 'evaluation drop'
}

const CONTROLLED_MARGIN_DEFAULTS = {
  enabled: false,
  minWinningCp: 70,
  maxWinningCp: 130,
  maxCpLoss: 1200,
  minSafetyCp: 60,
  maxCandidates: 6,
  hardFloorCp: 50,
  avoidSimplification: true,
  maxPvSimplification: 2,
  refusalMinBestCp: 160,
  refusalCapturePenalty: 260,
  refusalQuietBonus: 130,
  combinedRefusalMultiplier: 1.8,
  combinedTensionBonus: 90,
  combinedTrapPriorityBoost: 1.45
}


const HUMAN_TRAP_PIECE_VALUES = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
  a: 300,
  c: 300,
  e: 300,
  f: 300,
  g: 300,
  h: 300,
  m: 300,
  s: 300,
  w: 300
}

function clampNumber (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function scoreToCpForStore (info) {
  if (!info) return null
  if (typeof info.cp === 'number') return info.cp
  if (typeof info.mate === 'number') return info.mate > 0 ? 100000 - info.mate : -100000 - info.mate
  return null
}

function parseEngineScoreToCp (score) {
  if (typeof score === 'number' && Number.isFinite(score)) return score
  if (typeof score !== 'string') return null
  const trimmed = score.trim()
  if (!trimmed) return null
  if (trimmed[0] === '#') {
    const mate = Number(trimmed.slice(1))
    if (!Number.isFinite(mate)) return null
    return mate > 0 ? 100000 - Math.min(9999, mate) : -100000 - Math.max(-9999, mate)
  }
  const cp = Number(trimmed)
  return Number.isFinite(cp) ? cp : null
}

function normalizeTrapSettings (settings = {}) {
  const merged = { ...HUMAN_TRAP_DEFAULTS, ...(settings || {}) }
  return {
    ...merged,
    enabled: !!merged.enabled,
    multiPv: Math.max(1, Math.min(5, Number(merged.multiPv) || HUMAN_TRAP_DEFAULTS.multiPv)),
    preferredCpLoss: Math.max(0, Number(merged.preferredCpLoss) || HUMAN_TRAP_DEFAULTS.preferredCpLoss),
    maxCpLoss: Math.max(1, Number(merged.maxCpLoss) || HUMAN_TRAP_DEFAULTS.maxCpLoss),
    minCandidateCp: Number.isFinite(Number(merged.minCandidateCp)) ? Number(merged.minCandidateCp) : HUMAN_TRAP_DEFAULTS.minCandidateCp,
    minPunishmentCp: Math.max(1, Number(merged.minPunishmentCp) || HUMAN_TRAP_DEFAULTS.minPunishmentCp),
    minTrapScore: Math.max(1, Number(merged.minTrapScore) || HUMAN_TRAP_DEFAULTS.minTrapScore),
    probeDepth: Math.max(4, Math.min(12, Number(merged.probeDepth) || HUMAN_TRAP_DEFAULTS.probeDepth)),
    maxCandidates: Math.max(1, Math.min(3, Number(merged.maxCandidates) || HUMAN_TRAP_DEFAULTS.maxCandidates)),
    maxRepliesPerCandidate: Math.max(1, Math.min(2, Number(merged.maxRepliesPerCandidate) || HUMAN_TRAP_DEFAULTS.maxRepliesPerCandidate)),
    choiceProbeDepth: Math.max(3, Math.min(8, Number(merged.choiceProbeDepth) || HUMAN_TRAP_DEFAULTS.choiceProbeDepth)),
    choiceMaxReplies: Math.max(1, Math.min(5, Number(merged.choiceMaxReplies) || HUMAN_TRAP_DEFAULTS.choiceMaxReplies)),
    choiceMinLegalReplies: Math.max(2, Number(merged.choiceMinLegalReplies) || HUMAN_TRAP_DEFAULTS.choiceMinLegalReplies),
    choiceMaxCorrectRatio: clampNumber(Number(merged.choiceMaxCorrectRatio) || HUMAN_TRAP_DEFAULTS.choiceMaxCorrectRatio, 0.1, 0.8),
    choiceNearBestCp: Math.max(20, Number(merged.choiceNearBestCp) || HUMAN_TRAP_DEFAULTS.choiceNearBestCp),
    choiceMinPenaltyCp: Math.max(30, Number(merged.choiceMinPenaltyCp) || HUMAN_TRAP_DEFAULTS.choiceMinPenaltyCp),
    overreactionProbeDepth: Math.max(3, Math.min(8, Number(merged.overreactionProbeDepth) || HUMAN_TRAP_DEFAULTS.overreactionProbeDepth)),
    overreactionMaxReplies: Math.max(1, Math.min(4, Number(merged.overreactionMaxReplies) || HUMAN_TRAP_DEFAULTS.overreactionMaxReplies)),
    overreactionMinPenaltyCp: Math.max(30, Number(merged.overreactionMinPenaltyCp) || HUMAN_TRAP_DEFAULTS.overreactionMinPenaltyCp),
    pressureProbeDepth: Math.max(3, Math.min(8, Number(merged.pressureProbeDepth) || HUMAN_TRAP_DEFAULTS.pressureProbeDepth)),
    pressureMaxReplies: Math.max(1, Math.min(4, Number(merged.pressureMaxReplies) || HUMAN_TRAP_DEFAULTS.pressureMaxReplies)),
    pressureMinScore: Math.max(20, Number(merged.pressureMinScore) || HUMAN_TRAP_DEFAULTS.pressureMinScore),
    maxProbeBudget: Math.max(1, Math.min(12, Number(merged.maxProbeBudget) || HUMAN_TRAP_DEFAULTS.maxProbeBudget)),
    earlyTrapScore: Math.max(40, Number(merged.earlyTrapScore) || HUMAN_TRAP_DEFAULTS.earlyTrapScore)
  }
}

function normalizeCloseWinSettings (settings = {}) {
  const merged = { ...CONTROLLED_MARGIN_DEFAULTS, ...(settings || {}) }
  const minWinningCp = Math.max(50, Number(merged.minWinningCp) || CONTROLLED_MARGIN_DEFAULTS.minWinningCp)
  const maxWinningCp = Math.max(minWinningCp + 20, Number(merged.maxWinningCp) || CONTROLLED_MARGIN_DEFAULTS.maxWinningCp)
  return {
    ...merged,
    enabled: !!merged.enabled,
    minWinningCp,
    maxWinningCp,
    maxCpLoss: Math.max(100, Number(merged.maxCpLoss) || CONTROLLED_MARGIN_DEFAULTS.maxCpLoss),
    minSafetyCp: Math.max(0, Number(merged.minSafetyCp) || CONTROLLED_MARGIN_DEFAULTS.minSafetyCp),
    maxCandidates: Math.max(2, Math.min(8, Number(merged.maxCandidates) || CONTROLLED_MARGIN_DEFAULTS.maxCandidates)),
    hardFloorCp: Math.max(0, Number(merged.hardFloorCp) || CONTROLLED_MARGIN_DEFAULTS.hardFloorCp),
    avoidSimplification: merged.avoidSimplification !== false,
    maxPvSimplification: Math.max(0, Math.min(6, Number(merged.maxPvSimplification) || CONTROLLED_MARGIN_DEFAULTS.maxPvSimplification)),
    refusalMinBestCp: Math.max(100, Number(merged.refusalMinBestCp) || CONTROLLED_MARGIN_DEFAULTS.refusalMinBestCp),
    refusalCapturePenalty: Math.max(0, Number(merged.refusalCapturePenalty) || CONTROLLED_MARGIN_DEFAULTS.refusalCapturePenalty),
    refusalQuietBonus: Math.max(0, Number(merged.refusalQuietBonus) || CONTROLLED_MARGIN_DEFAULTS.refusalQuietBonus),
    combinedRefusalMultiplier: clampNumber(Number(merged.combinedRefusalMultiplier) || CONTROLLED_MARGIN_DEFAULTS.combinedRefusalMultiplier, 1, 3),
    combinedTensionBonus: Math.max(0, Number(merged.combinedTensionBonus) || CONTROLLED_MARGIN_DEFAULTS.combinedTensionBonus),
    combinedTrapPriorityBoost: clampNumber(Number(merged.combinedTrapPriorityBoost) || CONTROLLED_MARGIN_DEFAULTS.combinedTrapPriorityBoost, 1, 3)
  }
}

function squareFileIndexToName (fileIndex) {
  return String.fromCharCode('a'.charCodeAt(0) + fileIndex)
}

function parseFenPieceMap (fen) {
  const placement = typeof fen === 'string' ? fen.trim().split(/\s+/)[0] : ''
  const rows = placement ? placement.split('/') : []
  const pieces = {}
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const rank = rows.length - rowIndex
    let fileIndex = 0
    const row = rows[rowIndex]
    for (let i = 0; i < row.length; i++) {
      const ch = row[i]
      if (/\d/.test(ch)) {
        let digits = ch
        while (i + 1 < row.length && /\d/.test(row[i + 1])) digits += row[++i]
        fileIndex += Number(digits) || 0
        continue
      }
      if (ch === '+') {
        const promoted = row[i + 1]
        if (promoted) {
          pieces[`${squareFileIndexToName(fileIndex)}${rank}`] = `+${promoted}`
          i++
          fileIndex++
        }
        continue
      }
      pieces[`${squareFileIndexToName(fileIndex)}${rank}`] = ch
      fileIndex++
    }
  }
  return pieces
}

function parseUciFromTo (uci) {
  if (typeof uci !== 'string' || uci.includes('@')) return null
  const match = uci.match(/^([a-z]\d{1,2})([a-z]\d{1,2})/i)
  if (!match) return null
  return { from: match[1], to: match[2] }
}

function trapPieceValue (piece) {
  if (!piece) return 0
  const normalized = String(piece).replace('+', '').slice(-1).toLowerCase()
  return HUMAN_TRAP_PIECE_VALUES[normalized] || 300
}

function boardFromFen (variant, fen, is960) {
  return is960 ? new ffish.Board(variant, fen, true) : new ffish.Board(variant, fen)
}

function detectPoisonedCaptureReplies ({ variant, is960, fen, candidateUci, settings }) {
  const candidateMove = parseUciFromTo(candidateUci)
  if (!candidateMove) return []
  const board = boardFromFen(variant, fen, is960)
  board.push(candidateUci)
  const afterCandidateFen = board.fen()
  const pieceMap = parseFenPieceMap(afterCandidateFen)
  const legalMoves = board.legalMoves()
  const replies = []
  for (const reply of Array.isArray(legalMoves) ? legalMoves : String(legalMoves || '').split(/\s+/).filter(Boolean)) {
    const parsed = parseUciFromTo(reply)
    if (!parsed) continue
    const captured = pieceMap[parsed.to]
    if (!captured) continue
    const capturedValue = trapPieceValue(captured)
    const capturesMovedPiece = parsed.to === candidateMove.to
    const movedPiece = pieceMap[candidateMove.to]
    const movedValue = capturesMovedPiece ? trapPieceValue(movedPiece) : 0
    const greedGain = capturedValue + (capturesMovedPiece ? Math.max(0, movedValue - 100) * 0.25 : 0)
    if (capturedValue < 100) continue
    if (!capturesMovedPiece && capturedValue < 300) continue
    const trapType = capturesMovedPiece ? 'Poisoned Capture' : 'Greed Trap'
    const humanTemptation = clampNumber((capturedValue / 600) + (capturesMovedPiece ? 0.45 : 0.25) + (reply.endsWith('q') ? 0.2 : 0), 0.25, 1.8)
    const attractiveness = clampNumber((capturedValue / 900) + (capturesMovedPiece ? 0.25 : 0.12), 0.15, 1) * humanTemptation
    const replyBoard = boardFromFen(variant, afterCandidateFen, is960)
    try {
      replyBoard.push(reply)
      replies.push({
        reply,
        captured,
        capturedValue,
        capturesMovedPiece,
        greedGain,
        trapType,
        attractiveness,
        humanTemptation,
        looksFree: capturesMovedPiece || capturedValue >= 300,
        temptationValidation: {
          attackable: true,
          enemyAttackCoverage: 1,
          attackableTargets: [{ square: parsed.to, reply, piece: captured, value: capturedValue, movedPieceTarget: capturesMovedPiece }],
          validationReason: 'opponent has a legal tempting capture'
        },
        fenAfterReply: replyBoard.fen()
      })
    } catch (err) {
      // Ignore invalid speculative reply moves from variants with unusual capture rules.
    }
  }
  return replies
    .sort((a, b) => (b.greedGain - a.greedGain) || (b.capturedValue - a.capturedValue) || (b.capturesMovedPiece - a.capturesMovedPiece) || a.reply.localeCompare(b.reply))
    .slice(0, settings.maxRepliesPerCandidate)
}

function normalizeTrapRootCandidates (lines, fallbackBestmove, sideToMove = true) {
  const byMove = new Map()
  const ordered = (Array.isArray(lines) ? lines : [])
    .filter(line => line && line.ucimove && typeof line.cp === 'number' && Number.isFinite(line.cp) && typeof line.mate !== 'number')
    .sort((a, b) => (a.multipv || 999) - (b.multipv || 999))
  for (const line of ordered) {
    if (!byMove.has(line.ucimove)) {
      byMove.set(line.ucimove, {
        ...line,
        rawCp: line.cp,
        cp: calcForSide(line.cp, sideToMove)
      })
    }
  }
  if (fallbackBestmove && !byMove.has(fallbackBestmove)) {
    byMove.set(fallbackBestmove, { ucimove: fallbackBestmove, cp: null, rawCp: null, multipv: 999 })
  }
  return [...byMove.values()].filter(line => typeof line.cp === 'number')
}

function adaptiveTrapTolerance (bestCp, settings, combinedMode = false) {
  const baseMax = Math.max(1, settings.maxCpLoss)
  const basePreferred = Math.max(0, settings.preferredCpLoss)
  const winningCp = Math.max(0, Number(bestCp) || 0)
  const winningBonus = winningCp <= 120 ? 0 : Math.min(combinedMode ? 520 : 300, Math.round((winningCp - 120) * (combinedMode ? 0.34 : 0.22)))
  return {
    maxCpLoss: baseMax + winningBonus,
    preferredCpLoss: basePreferred + Math.round(winningBonus * 0.45),
    adaptiveBonus: winningBonus,
    bestCp
  }
}

function controlledBandPosition (cp, settings) {
  if (typeof cp !== 'number') return 'unknown'
  if (cp < settings.minWinningCp) return 'below-band'
  if (cp > settings.maxWinningCp) return 'above-band'
  return 'inside-band'
}

function quietReplyScore (fen, move) {
  const parsed = parseUciFromTo(move)
  if (!parsed) return 0
  const pieceMap = parseFenPieceMap(fen)
  const moving = pieceMap[parsed.from] || ''
  const captured = pieceMap[parsed.to]
  if (captured) return -200
  const kingBonus = String(moving).toLowerCase() === 'k' ? 90 : 0
  const retreatBonus = /[18]$/.test(parsed.to) ? 20 : 0
  const castleLike = parsed.from[0] === 'e' && ['c', 'g'].includes(parsed.to[0]) ? 35 : 0
  return kingBonus + retreatBonus + castleLike + 10
}


function moveCaptureInfo (fen, move) {
  const parsed = parseUciFromTo(move)
  if (!parsed) return { isCapture: false, capturedValue: 0, captured: null }
  const pieceMap = parseFenPieceMap(fen)
  const captured = pieceMap[parsed.to] || null
  return {
    isCapture: !!captured,
    capturedValue: trapPieceValue(captured),
    captured
  }
}

function analyzePvSimplification ({ fen, variant, is960, pvUCI, maxPlies = 6 }) {
  const tokens = typeof pvUCI === 'string' ? pvUCI.split(/\s+/).filter(Boolean).slice(0, maxPlies) : []
  if (!tokens.length || !fen) return { captures: 0, captureValue: 0, forcingPlies: 0, simplificationPenalty: 0, reason: 'no pv simplification evidence' }
  let board
  try {
    board = boardFromFen(variant, fen, is960)
  } catch (err) {
    return { captures: 0, captureValue: 0, forcingPlies: 0, simplificationPenalty: 0, reason: 'pv simplification unavailable' }
  }
  let captures = 0
  let captureValue = 0
  let forcingPlies = 0
  for (const token of tokens) {
    const currentFen = board.fen()
    const info = moveCaptureInfo(currentFen, token)
    if (info.isCapture) {
      captures++
      captureValue += info.capturedValue
      if (info.capturedValue >= 300) forcingPlies++
    }
    if (/[qrbn]$/i.test(token) && token.length > 4) forcingPlies++
    try {
      board.push(token)
    } catch (err) {
      break
    }
  }
  const simplificationPenalty = captures * 18 + Math.round(captureValue / 80) + forcingPlies * 10
  const reason = captures
    ? `avoids ${captures} early capture${captures === 1 ? '' : 's'} (${captureValue} material)`
    : 'keeps material tension'
  return { captures, captureValue, forcingPlies, simplificationPenalty, reason }
}

function detectAttackableTrapTargets ({ variant, is960, fen, candidateUci = '', limit = 4 }) {
  let board
  try {
    board = boardFromFen(variant, fen, is960)
  } catch (err) {
    return { attackable: false, enemyAttackCoverage: 0, attackableTargets: [], validationReason: 'attack map unavailable' }
  }
  const pieceMap = parseFenPieceMap(fen)
  const candidateMove = parseUciFromTo(candidateUci)
  const legal = board.legalMoves()
  const moves = Array.isArray(legal) ? legal : String(legal || '').split(/\s+/).filter(Boolean)
  const targets = []
  for (const reply of moves) {
    const parsed = parseUciFromTo(reply)
    if (!parsed) continue
    const targetPiece = pieceMap[parsed.to]
    if (!targetPiece) continue
    const targetValue = trapPieceValue(targetPiece)
    if (targetValue < 100) continue
    const movedPieceTarget = !!(candidateMove && parsed.to === candidateMove.to)
    targets.push({
      square: parsed.to,
      reply,
      piece: targetPiece,
      value: targetValue,
      movedPieceTarget
    })
  }
  targets.sort((a, b) => (b.movedPieceTarget - a.movedPieceTarget) || (b.value - a.value) || a.reply.localeCompare(b.reply))
  const selected = targets.slice(0, limit)
  return {
    attackable: selected.length > 0,
    enemyAttackCoverage: targets.length,
    attackableTargets: selected,
    validationReason: selected.length ? 'opponent has legal capture/attack coverage on a real target' : 'no practical attackable target found'
  }
}


function legalReplyCountAfterMove ({ fen, variant, is960, move }) {
  if (!fen || !move) return null
  try {
    const board = boardFromFen(variant, fen, is960)
    board.push(move)
    const legal = board.legalMoves()
    const moves = Array.isArray(legal) ? legal : String(legal || '').split(/\s+/).filter(Boolean)
    return moves.length
  } catch (err) {
    return null
  }
}

function controlledMarginForcingInfo ({ fen, variant, is960, move }) {
  const legalReplies = legalReplyCountAfterMove({ fen, variant, is960, move })
  if (legalReplies === null) return { legalReplies: null, forcingPenalty: 0, reason: 'forcing check unavailable' }
  const forcingPenalty = legalReplies <= 2 ? 70 : (legalReplies <= 5 ? 42 : (legalReplies <= 8 ? 20 : 0))
  return {
    legalReplies,
    forcingPenalty,
    reason: forcingPenalty > 0 ? `avoids forcing line with only ${legalReplies} replies` : 'allows flexible reply choice'
  }
}


function controlledMarginRefusalInfo ({ item, best, settings, fen, combinedMode = false }) {
  const moveInfo = moveCaptureInfo(fen, item.ucimove)
  const alreadyComfortable = best && typeof best.cp === 'number' && best.cp >= settings.refusalMinBestCp
  const multiplier = combinedMode ? settings.combinedRefusalMultiplier : 1
  const refusalPenalty = alreadyComfortable && moveInfo.isCapture
    ? Math.round((settings.refusalCapturePenalty + Math.round(moveInfo.capturedValue / 5)) * multiplier)
    : 0
  const refusalBonus = alreadyComfortable && !moveInfo.isCapture
    ? settings.refusalQuietBonus + (combinedMode ? settings.combinedTensionBonus : 0)
    : 0
  return {
    moveInfo,
    alreadyComfortable,
    refusalPenalty,
    refusalBonus,
    delayedConversion: alreadyComfortable && !moveInfo.isCapture,
    reason: moveInfo.isCapture && alreadyComfortable
      ? `${combinedMode ? 'combined refusal: ' : ''}refuses immediate ${moveInfo.capturedValue} material conversion`
      : (alreadyComfortable ? `${combinedMode ? 'combined mode ' : ''}delays conversion and keeps tension` : 'normal margin control')
  }
}

function controlledMarginCandidateScore ({ item, best, settings, fen, variant, is960, combinedMode = false }) {
  const bandCenter = Math.round((settings.minWinningCp + settings.maxWinningCp) / 2)
  const inBand = item.cp >= settings.minWinningCp && item.cp <= settings.maxWinningCp
  const belowBand = item.cp < settings.minWinningCp
  const bandDistance = inBand ? Math.abs(item.cp - bandCenter) : Math.min(Math.abs(item.cp - settings.minWinningCp), Math.abs(item.cp - settings.maxWinningCp))
  const refusalInfo = controlledMarginRefusalInfo({ item, best, settings, fen, combinedMode })
  const moveInfo = refusalInfo.moveInfo
  const pvSimplification = analyzePvSimplification({ fen, variant, is960, pvUCI: item.pvUCI, maxPlies: Math.max(2, settings.maxPvSimplification) })
  const forcingInfo = controlledMarginForcingInfo({ fen, variant, is960, move: item.ucimove })
  const quietTensionBonus = moveInfo.isCapture ? 0 : 62 + (combinedMode ? settings.combinedTensionBonus : 0)
  const safeCounterplayBonus = item.cp >= settings.minWinningCp && item.cp <= settings.maxWinningCp ? 64 + (combinedMode ? 35 : 0) : (item.cp >= settings.hardFloorCp && item.cp < settings.minWinningCp ? 24 + (combinedMode ? 18 : 0) : 0)
  const conversionPenalty = (moveInfo.isCapture ? 110 + Math.round(moveInfo.capturedValue / 12) : 0) + refusalInfo.refusalPenalty + (settings.avoidSimplification ? pvSimplification.simplificationPenalty * (combinedMode ? 2.5 : 1.8) : 0) + forcingInfo.forcingPenalty * (combinedMode ? 1.45 : 1)
  const excessiveMarginPenalty = Math.max(0, item.cp - settings.maxWinningCp) * 1.1
  const dangerPenalty = belowBand ? (settings.minWinningCp - item.cp) * 1.6 : 0
  const targetScore = 235 - bandDistance - excessiveMarginPenalty - dangerPenalty
  const score = Math.round(targetScore + quietTensionBonus + safeCounterplayBonus + refusalInfo.refusalBonus - conversionPenalty)
  const simplificationAvoidanceReason = conversionPenalty > 0
    ? `${moveInfo.isCapture ? 'root capture/conversion; ' : ''}${pvSimplification.reason}; ${forcingInfo.reason}; ${refusalInfo.reason}`.trim()
    : `quiet/tension-preserving candidate; ${forcingInfo.reason}; ${refusalInfo.reason}`
  return {
    ...item,
    inBand,
    bandDistance,
    marginReduction: Math.max(0, best.cp - item.cp),
    quietTensionBonus,
    safeCounterplayBonus,
    conversionPenalty,
    simplificationPenalty: pvSimplification.simplificationPenalty,
    pvSimplification,
    forcingInfo,
    refusalInfo,
    controlledRefusal: refusalInfo.delayedConversion,
    simplificationAvoidanceReason,
    controlledMarginScore: score
  }
}


function chooseNaturalReplies (fen, variant, is960, limit) {
  let board
  try {
    board = boardFromFen(variant, fen, is960)
  } catch (err) {
    return { replies: [], legalCount: 0 }
  }
  const legal = board.legalMoves()
  const moves = Array.isArray(legal) ? legal : String(legal || '').split(/\s+/).filter(Boolean)
  const pieceMap = parseFenPieceMap(fen)
  const scored = moves.map(move => {
    const parsed = parseUciFromTo(move)
    const captured = parsed ? pieceMap[parsed.to] : null
    const captureValue = trapPieceValue(captured)
    const promotionBonus = /[qrbn]$/i.test(move) && move.length > 4 ? 180 : 0
    const centerBonus = parsed && ['d4', 'd5', 'e4', 'e5'].includes(parsed.to) ? 35 : 0
    return { move, naturalScore: captureValue + promotionBonus + centerBonus }
  })
  scored.sort((a, b) => (b.naturalScore - a.naturalScore) || a.move.localeCompare(b.move))
  return { replies: scored.slice(0, Math.max(1, limit)), legalCount: moves.length }
}

async function evaluateReplySpace ({ engineInstance, fen, variant, is960, candidateCp, settings, sideToMove = true }) {
  const { replies, legalCount } = chooseNaturalReplies(fen, variant, is960, settings.choiceMaxReplies)
  if (legalCount < settings.choiceMinLegalReplies || replies.length < 2) return null
  const evaluated = []
  for (const item of replies) {
    let replyFen = ''
    try {
      const board = boardFromFen(variant, fen, is960)
      board.push(item.move)
      replyFen = board.fen()
    } catch (err) {
      continue
    }
    const score = parseEngineScoreToCp(await engineInstance.evaluate(replyFen, settings.choiceProbeDepth))
    if (score === null) continue
    evaluated.push({ ...item, cp: calcForSide(score, sideToMove), rawCp: score })
  }
  if (evaluated.length < 2) return null
  const bestReplyCp = Math.min(...evaluated.map(item => item.cp))
  const correct = evaluated.filter(item => item.cp <= bestReplyCp + settings.choiceNearBestCp)
  const penalties = evaluated.map(item => Math.max(0, item.cp - bestReplyCp))
  const avgPenalty = penalties.reduce((sum, value) => sum + value, 0) / penalties.length
  const naturalMiss = evaluated.find(item => item.cp - bestReplyCp >= settings.choiceMinPenaltyCp) || null
  const correctRatio = correct.length / evaluated.length
  if (!naturalMiss || correctRatio > settings.choiceMaxCorrectRatio) return null
  const overload = clampNumber(1 - correctRatio, 0, 1)
  const penaltyFactor = clampNumber(avgPenalty / 180, 0, 1.5)
  const legalFactor = clampNumber(legalCount / 24, 0.25, 1.25)
  const score = Math.round(100 * overload * penaltyFactor * legalFactor)
  if (score < settings.minTrapScore) return null
  const humanTemptation = clampNumber((naturalMiss.naturalScore / 500) + overload + penaltyFactor * 0.35, 0.2, 1.7)
  return {
    move: null,
    type: 'Choice Overload',
    temptingReply: naturalMiss.move,
    cpLoss: 0,
    expectedPunishment: Math.round(naturalMiss.cp - bestReplyCp),
    trapScore: score,
    humanTemptation,
    looksFree: naturalMiss.naturalScore >= 300,
    choicePressure: score,
    legalReplies: legalCount,
    sampledReplies: evaluated.length,
    correctReplies: correct.length,
    candidateCp
  }
}

async function annotatePersonalityCandidates ({ engineInstance, fen, variant, is960, rootLines, settings, sideToMove = true }) {
  const safeSettings = normalizeTrapSettings(settings)
  if (!safeSettings.enabled || !engineInstance || !fen) return []
  const candidates = normalizeTrapRootCandidates(rootLines, rootLines && rootLines[0] && rootLines[0].ucimove, sideToMove).slice(0, safeSettings.maxCandidates)
  const annotations = []
  for (const candidate of candidates) {
    let afterCandidateFen = ''
    try {
      const board = boardFromFen(variant, fen, is960)
      board.push(candidate.ucimove)
      afterCandidateFen = board.fen()
    } catch (err) {
      continue
    }
    const overload = await evaluateReplySpace({ engineInstance, fen: afterCandidateFen, variant, is960, candidateCp: candidate.cp, settings: safeSettings, sideToMove })
    if (overload) annotations.push({ ...overload, move: candidate.ucimove, candidateCp: candidate.cp })
  }
  return annotations
}


async function evaluateOverreactionTrap ({ engineInstance, fen, variant, is960, candidateCp, settings, sideToMove = true }) {
  const { replies, legalCount } = chooseNaturalReplies(fen, variant, is960, Math.max(settings.overreactionMaxReplies, settings.choiceMaxReplies))
  if (replies.length < 2 || legalCount < 4) return null
  const evaluated = []
  for (const item of replies.slice(0, Math.max(settings.overreactionMaxReplies, settings.choiceMaxReplies))) {
    try {
      const board = boardFromFen(variant, fen, is960)
      board.push(item.move)
      const score = parseEngineScoreToCp(await engineInstance.evaluate(board.fen(), settings.overreactionProbeDepth))
      if (score !== null) evaluated.push({ ...item, defensiveScore: quietReplyScore(fen, item.move), cp: calcForSide(score, sideToMove), rawCp: score })
    } catch (err) {}
  }
  if (evaluated.length < 2) return null
  const bestReplyCp = Math.min(...evaluated.map(item => item.cp))
  const overDefended = evaluated
    .filter(item => item.defensiveScore > 0)
    .map(item => ({ ...item, penalty: item.cp - bestReplyCp }))
    .filter(item => item.penalty >= settings.overreactionMinPenaltyCp)
    .sort((a, b) => (b.penalty - a.penalty) || (b.defensiveScore - a.defensiveScore) || a.move.localeCompare(b.move))
  if (!overDefended.length) return null
  const top = overDefended[0]
  const apparentPressure = clampNumber((top.defensiveScore + Math.max(0, legalCount - 4) * 3) / 130, 0.25, 1.25)
  const penaltyFactor = clampNumber(top.penalty / 160, 0, 1.4)
  const humanTemptation = clampNumber(apparentPressure + penaltyFactor * 0.35 + (top.defensiveScore > 80 ? 0.25 : 0), 0.25, 1.6)
  const score = Math.round(100 * apparentPressure * penaltyFactor)
  if (score < settings.minTrapScore) return null
  return {
    move: null,
    type: 'Overreaction Trap',
    temptingReply: top.move,
    cpLoss: 0,
    expectedPunishment: Math.round(top.penalty),
    trapScore: score,
    humanTemptation,
    looksFree: false,
    overreactionPressure: score,
    legalReplies: legalCount,
    sampledReplies: evaluated.length,
    candidateCp,
    depth: settings.overreactionProbeDepth
  }
}


async function evaluatePracticalPressure ({ engineInstance, fen, variant, is960, candidateCp, settings, sideToMove = true }) {
  const { replies, legalCount } = chooseNaturalReplies(fen, variant, is960, settings.pressureMaxReplies)
  if (replies.length < 2) return null
  const evaluated = []
  for (const item of replies) {
    try {
      const board = boardFromFen(variant, fen, is960)
      board.push(item.move)
      const score = parseEngineScoreToCp(await engineInstance.evaluate(board.fen(), settings.pressureProbeDepth))
      if (score !== null) evaluated.push({ ...item, cp: calcForSide(score, sideToMove), rawCp: score })
    } catch (err) {}
  }
  if (evaluated.length < 2) return null
  const bestReplyCp = Math.min(...evaluated.map(item => item.cp))
  const penalties = evaluated.map(item => Math.max(0, item.cp - bestReplyCp))
  const avgPenalty = penalties.reduce((sum, value) => sum + value, 0) / penalties.length
  const worstPenalty = Math.max(...penalties)
  const correctReplies = evaluated.filter(item => item.cp <= bestReplyCp + settings.choiceNearBestCp).length
  const asymmetry = clampNumber(1 - (correctReplies / evaluated.length), 0, 1)
  const forcing = clampNumber((settings.pressureMaxReplies + 2 - Math.min(legalCount, settings.pressureMaxReplies + 2)) / settings.pressureMaxReplies, 0, 1)
  const instability = clampNumber((avgPenalty + worstPenalty * 0.45) / 220, 0, 1.5)
  const score = Math.round(100 * (0.35 + forcing * 0.3 + asymmetry * 0.35) * instability)
  if (score < settings.pressureMinScore) return null
  const humanTemptation = clampNumber(asymmetry + instability * 0.35 + forcing * 0.2, 0.2, 1.5)
  const miss = evaluated
    .map((item, idx) => ({ ...item, penalty: penalties[idx] }))
    .sort((a, b) => (b.penalty - a.penalty) || a.move.localeCompare(b.move))[0]
  return {
    move: null,
    type: 'Practical Pressure',
    temptingReply: miss ? miss.move : '',
    cpLoss: 0,
    expectedPunishment: Math.round(worstPenalty),
    trapScore: score,
    humanTemptation,
    looksFree: miss && miss.naturalScore >= 300,
    practicalPressure: score,
    replyInstability: Math.round(avgPenalty),
    legalReplies: legalCount,
    sampledReplies: evaluated.length,
    correctReplies,
    candidateCp,
    depth: settings.pressureProbeDepth
  }
}

function selectCloseWinMove ({ rootLines, settings, sideToMove = true, fen = '', variant = 'chess', is960 = false, combinedMode = false }) {
  const safeSettings = normalizeCloseWinSettings(settings)
  if (!safeSettings.enabled) return null
  const candidates = normalizeTrapRootCandidates(rootLines, rootLines && rootLines[0] && rootLines[0].ucimove, sideToMove).slice(0, safeSettings.maxCandidates)
  if (candidates.length < 2) return null
  const best = candidates[0]
  if (typeof best.cp !== 'number') return null
  const bandPosition = controlledBandPosition(best.cp, safeSettings)
  if (bandPosition === 'below-band') return null
  const scored = candidates
    .filter(item => typeof item.cp === 'number' && item.cp >= safeSettings.hardFloorCp && best.cp - item.cp <= safeSettings.maxCpLoss)
    .filter(item => bandPosition !== 'above-band' || item.cp < best.cp)
    .map(item => controlledMarginCandidateScore({ item, best, settings: safeSettings, fen, variant, is960, combinedMode }))
    .sort((a, b) =>
      (b.controlledMarginScore - a.controlledMarginScore) ||
      (b.marginReduction - a.marginReduction) ||
      (a.bandDistance - b.bandDistance) ||
      ((a.multipv || 999) - (b.multipv || 999))
    )
  if (!scored.length || scored[0].ucimove === best.ucimove) return null
  const selected = scored[0]
  const averageCandidateCp = Math.round(scored.reduce((sum, item) => sum + item.cp, 0) / scored.length)
  return {
    move: selected.ucimove,
    type: 'Controlled Margin',
    reason: combinedMode
      ? (bandPosition === 'above-band' ? 'combined controlled temptation: delay conversion and preserve bait' : 'combined controlled edge with tension and ambiguity')
      : (bandPosition === 'above-band' ? 'margin reduction with tension preservation' : 'controlled edge inside target band'),
    combinedPressure: combinedMode,
    targetBand: `${safeSettings.minWinningCp}-${safeSettings.maxWinningCp}cp`,
    currentEval: best.cp,
    displayEval: best.cp,
    rootBestEval: best.cp,
    marginCandidateEval: selected.cp,
    averageCandidateCp,
    bandPosition,
    marginReduction: selected.marginReduction,
    bestCp: best.cp,
    selectedCp: selected.cp,
    cpLoss: best.cp - selected.cp,
    simplificationAvoidanceReason: selected.simplificationAvoidanceReason,
    simplificationPenalty: selected.simplificationPenalty,
    conversionPenalty: selected.conversionPenalty,
    tensionScore: selected.quietTensionBonus + selected.safeCounterplayBonus,
    controlledMarginScore: selected.controlledMarginScore,
    pvSimplification: selected.pvSimplification,
    controlledRefusal: selected.controlledRefusal,
    refusalInfo: selected.refusalInfo,
    materialConversionDelayed: selected.controlledRefusal ? 1 : 0,
    trapScore: Math.max(1, Math.min(100, selected.controlledMarginScore))
  }
}


async function selectHumanTrapMove ({ engineInstance, fen, variant, is960, bestmove, rootLines, settings, sideToMove = true, controlledSettings = null }) {
  let safeSettings = normalizeTrapSettings(settings)
  if (!safeSettings.enabled || !engineInstance || !fen || !bestmove) return null
  const combinedMode = !!(controlledSettings && controlledSettings.enabled)
  if (combinedMode) {
    safeSettings = {
      ...safeSettings,
      maxCandidates: Math.min(4, Math.max(safeSettings.maxCandidates + 1, 3)),
      maxRepliesPerCandidate: Math.min(2, Math.max(safeSettings.maxRepliesPerCandidate, 2)),
      maxProbeBudget: Math.min(10, Math.max(safeSettings.maxProbeBudget + 2, 8)),
      minTrapScore: Math.max(35, safeSettings.minTrapScore - 20),
      earlyTrapScore: Math.max(60, safeSettings.earlyTrapScore - 15)
    }
  }
  const candidates = normalizeTrapRootCandidates(rootLines, bestmove, sideToMove).slice(0, safeSettings.maxCandidates)
  if (!candidates.length) return null
  const bestLine = candidates.find(item => item.ucimove === bestmove) || candidates[0]
  if (!bestLine || typeof bestLine.cp !== 'number') return null
  const bestCp = bestLine.cp
  const tolerance = adaptiveTrapTolerance(bestCp, safeSettings, combinedMode)
  const activeMaxCpLoss = tolerance.maxCpLoss
  const activePreferredCpLoss = tolerance.preferredCpLoss
  const activeMinCandidateCp = combinedMode ? Math.max(safeSettings.minCandidateCp, controlledSettings.hardFloorCp) : safeSettings.minCandidateCp
  const combinedMaxTrapCp = combinedMode && controlledSettings ? controlledSettings.maxWinningCp + 220 : Infinity
  const probeStats = { probes: 0, rejectedCandidates: 0, earlyExits: 0, attackabilityChecks: 0, skippedQuietCandidates: 0 }
  const probeEngine = {
    ...engineInstance,
    evaluate: async (probeFen, depth) => {
      probeStats.probes++
      return engineInstance.evaluate(probeFen, depth)
    }
  }
  const trapCandidates = []
  for (const candidate of candidates) {
    const candidateCp = candidate.cp
    const cpLoss = bestCp - candidateCp
    if (cpLoss < 0 || cpLoss > activeMaxCpLoss || candidateCp < activeMinCandidateCp) {
      probeStats.rejectedCandidates++
      continue
    }
    if (combinedMode && controlledSettings && candidateCp > combinedMaxTrapCp) {
      probeStats.rejectedCandidates++
      continue
    }
    const safety = clampNumber(1 - (cpLoss / activeMaxCpLoss), 0, 1)
    const preferredWindow = Math.max(1, activeMaxCpLoss - activePreferredCpLoss)
    const preferredSafety = cpLoss <= activePreferredCpLoss
      ? 1
      : clampNumber(1 - ((cpLoss - activePreferredCpLoss) / preferredWindow) * 0.35, 0.65, 1)
    let afterCandidateFen = ''
    try {
      const board = boardFromFen(variant, fen, is960)
      board.push(candidate.ucimove)
      afterCandidateFen = board.fen()
    } catch (err) {}
    probeStats.attackabilityChecks++
    const temptationValidation = afterCandidateFen
      ? detectAttackableTrapTargets({ variant, is960, fen: afterCandidateFen, candidateUci: candidate.ucimove })
      : { attackable: false, enemyAttackCoverage: 0, attackableTargets: [], validationReason: 'candidate position unavailable' }
    const replies = detectPoisonedCaptureReplies({ variant, is960, fen, candidateUci: candidate.ucimove, settings: safeSettings })
    if (!temptationValidation.attackable && replies.length === 0) {
      probeStats.skippedQuietCandidates++
      continue
    }
    for (const reply of replies) {
      if (probeStats.probes >= safeSettings.maxProbeBudget) break
      const evaluated = await probeEngine.evaluate(reply.fenAfterReply, safeSettings.probeDepth)
      const postCaptureRawCp = parseEngineScoreToCp(evaluated)
      if (postCaptureRawCp === null) continue
      const postCaptureCp = calcForSide(postCaptureRawCp, sideToMove)
      const punishmentCp = postCaptureCp - candidateCp
      if (punishmentCp < safeSettings.minPunishmentCp) continue
      const punishment = clampNumber(punishmentCp / 180, 0, 1.5)
      const trapScore = Math.round(100 * reply.attractiveness * punishment * safety * preferredSafety)
      if (trapScore < safeSettings.minTrapScore) continue
      trapCandidates.push({
        move: candidate.ucimove,
        type: reply.trapType || 'Poisoned Capture',
        temptingReply: reply.reply,
        cpLoss,
        expectedPunishment: Math.round(punishmentCp),
        trapScore: combinedMode ? Math.round(trapScore * controlledSettings.combinedTrapPriorityBoost * (1 + (reply.humanTemptation || 0) * 0.12)) : trapScore,
        combinedTemptation: combinedMode,
        candidateCp,
        bestCp,
        captured: reply.captured,
        capturedValue: reply.capturedValue,
        humanTemptation: reply.humanTemptation,
        looksFree: reply.looksFree,
        attackableTrapTarget: true,
        enemyAttackCoverage: reply.temptationValidation ? reply.temptationValidation.enemyAttackCoverage : 1,
        temptationValidation: reply.temptationValidation || temptationValidation,
        depth: safeSettings.probeDepth,
        adaptiveTolerance: tolerance
      })
    }
    if (afterCandidateFen && probeStats.probes < safeSettings.maxProbeBudget) {
      const overload = temptationValidation.attackable
        ? await evaluateReplySpace({ engineInstance: probeEngine, fen: afterCandidateFen, variant, is960, candidateCp, settings: safeSettings, sideToMove })
        : null
      if (overload) {
        trapCandidates.push({
          ...overload,
          move: candidate.ucimove,
          cpLoss,
          bestCp,
          candidateCp,
          trapScore: Math.round(overload.trapScore * safety * preferredSafety * (combinedMode ? controlledSettings.combinedTrapPriorityBoost * (1 + (overload.humanTemptation || 0) * 0.12) : 1)),
          combinedTemptation: combinedMode,
          attackableTrapTarget: temptationValidation.attackable,
          enemyAttackCoverage: temptationValidation.enemyAttackCoverage,
          temptationValidation,
          adaptiveTolerance: tolerance
        })
      }
      const overreaction = (temptationValidation.attackable && probeStats.probes < safeSettings.maxProbeBudget)
        ? await evaluateOverreactionTrap({ engineInstance: probeEngine, fen: afterCandidateFen, variant, is960, candidateCp, settings: safeSettings, sideToMove })
        : null
      if (overreaction) {
        trapCandidates.push({
          ...overreaction,
          move: candidate.ucimove,
          cpLoss,
          bestCp,
          candidateCp,
          trapScore: Math.round(overreaction.trapScore * safety * preferredSafety * (combinedMode ? controlledSettings.combinedTrapPriorityBoost * (1 + (overreaction.humanTemptation || 0) * 0.12) : 1)),
          combinedTemptation: combinedMode,
          attackableTrapTarget: true,
          enemyAttackCoverage: temptationValidation.enemyAttackCoverage,
          temptationValidation,
          adaptiveTolerance: tolerance
        })
      }
      const pressure = (temptationValidation.attackable && probeStats.probes < safeSettings.maxProbeBudget)
        ? await evaluatePracticalPressure({ engineInstance: probeEngine, fen: afterCandidateFen, variant, is960, candidateCp, settings: safeSettings, sideToMove })
        : null
      if (pressure) {
        trapCandidates.push({
          ...pressure,
          move: candidate.ucimove,
          cpLoss,
          bestCp,
          candidateCp,
          trapScore: Math.round(pressure.trapScore * safety * preferredSafety * (combinedMode ? controlledSettings.combinedTrapPriorityBoost * (1 + (pressure.humanTemptation || 0) * 0.12) : 1)),
          combinedTemptation: combinedMode,
          attackableTrapTarget: temptationValidation.attackable,
          enemyAttackCoverage: temptationValidation.enemyAttackCoverage,
          temptationValidation,
          adaptiveTolerance: tolerance
        })
      }
    }
    if (trapCandidates.some(item => item.trapScore >= safeSettings.earlyTrapScore) || probeStats.probes >= safeSettings.maxProbeBudget) {
      probeStats.earlyExits++
      break
    }
  }
  if (!trapCandidates.length) return null
  trapCandidates.sort((a, b) =>
    ((b.humanTemptation || 0) - (a.humanTemptation || 0)) ||
    (b.trapScore - a.trapScore) ||
    (a.cpLoss - b.cpLoss) ||
    (b.expectedPunishment - a.expectedPunishment) ||
    a.move.localeCompare(b.move)
  )
  return {
    ...trapCandidates[0],
    probeStats,
    probeEval: trapCandidates[0].candidateCp,
    trapEval: trapCandidates[0].expectedPunishment,
    displayEval: bestCp,
    rootBestEval: bestCp
  }
}



function personalityNoReplacementDiagnostic ({ trapSettings, marginSettings, combinedMode, rootCount, bestmove, reason }) {
  return {
    mode: combinedMode ? 'Combined Personality' : (marginSettings.enabled ? 'Controlled Margin Mode' : 'Human Trap Mode'),
    type: 'No Personality Replacement',
    selectorEntered: true,
    humanTrapEnabled: trapSettings.enabled,
    controlledMarginEnabled: marginSettings.enabled,
    selected: false,
    replacement: false,
    bestmove,
    rootCandidates: rootCount,
    reason,
    displayEval: null,
    probeEval: null,
    trapEval: null,
    marginCandidateEval: null
  }
}

async function selectPersonalityMove ({ engineInstance, fen, variant, is960, bestmove, rootLines, humanTrapSettings, closeWinSettings, sideToMove = true }) {
  const trapSettings = normalizeTrapSettings(humanTrapSettings)
  const marginSettings = normalizeCloseWinSettings(closeWinSettings)
  const combinedMode = trapSettings.enabled && marginSettings.enabled
  const rootCount = Array.isArray(rootLines) ? rootLines.filter(Boolean).length : 0
  console.info('[Personality]', {
    humanTrap: trapSettings.enabled,
    controlledMargin: marginSettings.enabled,
    selectorEntered: true,
    combined: combinedMode,
    rootCandidates: rootCount,
    bestmove
  })
  const logHumanTrap = trap => console.info('[HumanTrap]', {
    entered: trapSettings.enabled,
    candidates: rootCount,
    filtered: trap && trap.probeStats ? trap.probeStats.rejectedCandidates + trap.probeStats.skippedQuietCandidates : null,
    probed: trap && trap.probeStats ? trap.probeStats.probes : 0,
    selected: !!(trap && trap.move),
    replacement: !!(trap && trap.move && trap.move !== bestmove),
    reason: trap && trap.move ? trap.type : (rootCount ? 'no_attackable_target_or_budget_exhausted' : 'no_root_candidates')
  })
  const logControlledMargin = margin => console.info('[ControlledMargin]', {
    entered: marginSettings.enabled,
    bestEval: margin && typeof margin.bestCp === 'number' ? margin.bestCp : null,
    selectedEval: margin && typeof margin.selectedCp === 'number' ? margin.selectedCp : null,
    replacement: !!(margin && margin.move),
    marginReduction: margin && typeof margin.marginReduction === 'number' ? margin.marginReduction : 0,
    used_for_display: false,
    reason: margin && margin.move ? margin.reason : (rootCount > 1 ? 'no_safe_margin_replacement' : 'insufficient_root_candidates')
  })
  if (combinedMode) {
    const closeWin = selectCloseWinMove({ rootLines, settings: marginSettings, sideToMove, fen, variant, is960, combinedMode: true })
    const trap = await selectHumanTrapMove({ engineInstance, fen, variant, is960, bestmove, rootLines, settings: trapSettings, sideToMove, controlledSettings: marginSettings })
    logHumanTrap(trap)
    logControlledMargin(closeWin)
    if (trap && trap.move) {
      return {
        ...trap,
        mode: 'Combined Personality',
        governingConstraint: 'Controlled Margin',
        combinedTemptation: true,
        companionControlledMarginMove: closeWin && closeWin.move ? closeWin.move : null,
        companionMarginReduction: closeWin && typeof closeWin.marginReduction === 'number' ? closeWin.marginReduction : null
      }
    }
    if (closeWin && closeWin.move) return { ...closeWin, mode: 'Combined Personality', governingConstraint: 'Controlled Margin', combinedTemptation: true }
    return personalityNoReplacementDiagnostic({ trapSettings, marginSettings, combinedMode, rootCount, bestmove, reason: rootCount ? 'no_combined_replacement' : 'no_root_candidates' })
  }
  const closeWin = selectCloseWinMove({ rootLines, settings: marginSettings, sideToMove, fen, variant, is960 })
  logControlledMargin(closeWin)
  if (closeWin && closeWin.move) return { ...closeWin, mode: 'Controlled Margin Mode' }
  const trap = await selectHumanTrapMove({ engineInstance, fen, variant, is960, bestmove, rootLines, settings: trapSettings, sideToMove })
  logHumanTrap(trap)
  if (trap && trap.move) return { ...trap, mode: 'Human Trap Mode' }
  return personalityNoReplacementDiagnostic({ trapSettings, marginSettings, combinedMode, rootCount, bestmove, reason: rootCount ? 'no_personality_replacement' : 'no_root_candidates' })
}


function personalityFlagsFromState (state) {
  const modal = state.startGameModal || {}
  const debug = state.enginePersonalityDebug || {}
  const humanTrapSettings = normalizeTrapSettings({
    ...(debug.humanTrapSettings || {}),
    enabled: !!modal.humanTrapMode
  })
  const closeWinSettings = normalizeCloseWinSettings({
    ...(debug.closeWinSettings || {}),
    enabled: !!modal.closeWinMode
  })
  return {
    humanTrapSettings,
    closeWinSettings,
    enabled: humanTrapSettings.enabled || closeWinSettings.enabled
  }
}

function collectRootInfoLine (rootLines, info) {
  if (!info || !('pv' in info)) return
  const rank = Number(info.multipv) || 1
  const ucimove = typeof info.pv === 'string' ? info.pv.split(/\s+/)[0] : ''
  if (!ucimove) return
  rootLines[rank - 1] = {
    multipv: rank,
    cp: info.cp,
    mate: info.mate,
    depth: info.depth,
    pvUCI: info.pv,
    ucimove
  }
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


const JANGGI_STANDARD_16_BACK_RANKS = [
  'NBA1ABN',
  'NBA1ANB',
  'BNA1ABN',
  'BNA1ANB'
]

function janggiStandard16OpeningPositions (variant = 'janggi') {
  // Fairy-Stockfish/Liground Janggi uses N/n for horses and B/b for elephants
  // (see piece CSS horse/elephant mappings and the built-in Janggi FEN style).
  // Each side independently chooses one of four valid horse-elephant back-rank
  // arrangements, producing 4 x 4 = 16 deterministic start positions.
  const safeVariant = variant || 'janggi'
  const rows = []
  JANGGI_STANDARD_16_BACK_RANKS.forEach((blackBackRank, blackIndex) => {
    JANGGI_STANDARD_16_BACK_RANKS.forEach((redBackRank, redIndex) => {
      rows.push({
        name: `Standard 16 ${blackIndex + 1}-${redIndex + 1}`,
        variant: safeVariant,
        fen: `r${blackBackRank.toLowerCase()}r/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/R${redBackRank}R w - - 0 1`
      })
    })
  })
  return rows
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
    humanTrapDiagnostics: null,
    mistakePrevention: { enabled: false, levelName: '중급', thresholdCp: 300, opponentTraining: false, opponentLevelName: '중급', evaluationMode: 'practical', verificationDepth: 14, chaosTraining: false },
    mistakeNotebook: [],
    mistakePreventionPending: false,
    enginePersonalityDebug: {
      trapSelections: 0,
      closeWinSelections: 0,
      trapAttempts: 0,
      categorySelections: {},
      replacementSelections: 0,
      combinedSelections: 0,
      controlledMarginReductions: 0,
      controlledMarginReductionCp: 0,
      controlledRefusals: 0,
      controlledMarginBestCpTotal: 0,
      controlledMarginSelectedCpTotal: 0,
      controlledMarginAverageBestCp: 0,
      controlledMarginAverageSelectedCp: 0,
      humanTrapSettings: {},
      closeWinSettings: {}
    },
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
      showEndGameModal: true,
      humanTrapMode: false,
      closeWinMode: false
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
    lastAnalysisResult: emptyDisplayAnalysisResult(),
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
    openingGraph: createOpeningGraph(),
    openingBook: {
      enabled: true,
      showSuggestions: true,
      autoResponse: false,
      autoResponseTopK: 3,
      recommendationCount: 3,
      useStandard16OpeningSet: false,
      standard16SelectionMode: 'cycle',
      autoResponseTemperature: 0.9,
      autoGenerateEnabled: false,
      autoGenerateIterations: 8,
      autoGenerateMaxPlies: 16,
      autoGenerateTopK: 3,
      autoGenerateEarlyPlies: 10,
      autoGenerateTemperature: 1.0
      ,
      autoGenerateDepth: 12,
      autoGenerateCpThreshold: 50,
      autoGenerateMinTrustedCount: 2,
      useStartPool: true,
      autoGenerateUnlimited: false,
      autoGenerateMinCountForRecommendation: 3,
      earlyRandomEnabled: true,
      moveSelectionPolicy: 'practical',
      cleanupUseQualityFilter: false,
      cleanupCpDelta: 120
    },
    openingGeneration: {
      running: false,
      stopRequested: false,
      analysisActive: false,
      sessionId: 0,
      optionSyncKey: '',
      completedGames: 0,
      completedMoves: 0,
      currentDepth: 0,
      currentMove: '',
      currentStart: '',
      savedBranches: 0,
      lastStopReason: '',
      lastStopDetail: ''
    },
    openingBookPersist: {
      queued: false,
      pendingCommits: 0,
      lastFlushedAt: 0,
      lastSnapshotAt: 0
    },
    openingStartPool: [],
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
    humanTrapDiagnostics (state, payload) {
      state.humanTrapDiagnostics = payload || null
    },
    mistakePreventionSettings (state, payload = {}) {
      const current = state.mistakePrevention || {}
      const next = { ...current, ...payload }
      const level = MISTAKE_PREVENTION_LEVELS.find(l => l.name === next.levelName) || MISTAKE_PREVENTION_LEVELS.find(l => l.thresholdCp === Number(next.thresholdCp)) || MISTAKE_PREVENTION_LEVELS[2]
      next.levelName = level.name
      next.thresholdCp = level.thresholdCp
      next.evaluationMode = next.evaluationMode === 'perfect' ? 'perfect' : 'practical'
      next.verificationDepth = Math.max(10, Math.min(20, Number(next.verificationDepth) || 14))
      next.chaosTraining = !!next.chaosTraining
      if (!next.opponentLevelName) next.opponentLevelName = next.levelName
      state.mistakePrevention = next
      try { localStorage.setItem('mistakePreventionSettings', JSON.stringify(next)) } catch (err) {}
    },
    mistakePreventionPending (state, payload) {
      state.mistakePreventionPending = !!payload
    },
    addMistakeNotebookEntry (state, payload) {
      state.mistakeNotebook = [payload].concat(state.mistakeNotebook || []).slice(0, 500)
      try { localStorage.setItem('mistakeNotebook', JSON.stringify(state.mistakeNotebook)) } catch (err) {}
    },
    clearMistakeNotebook (state) {
      state.mistakeNotebook = []
      try { localStorage.removeItem('mistakeNotebook') } catch (err) {}
    },
    personalityDiagnostics (state, payload) {
      const diag = payload || null
      state.humanTrapDiagnostics = diag
      if (diag) {
        const debug = { ...(state.enginePersonalityDebug || {}) }
        debug.selectorPasses = (debug.selectorPasses || 0) + 1
        if (!diag.move && diag.type === 'No Personality Replacement') {
          console.info('[engine-personality]', {
            mode: diag.mode,
            type: diag.type,
            selectorEntered: diag.selectorEntered,
            humanTrapEnabled: diag.humanTrapEnabled,
            controlledMarginEnabled: diag.controlledMarginEnabled,
            replacement: false,
            reason: diag.reason,
            rootCandidates: diag.rootCandidates
          })
          state.enginePersonalityDebug = debug
          return
        }
        if (diag.type === 'Controlled Margin') {
          debug.closeWinSelections = (debug.closeWinSelections || 0) + 1
          if (typeof diag.marginReduction === 'number' && diag.marginReduction > 0) {
            debug.controlledMarginReductions = (debug.controlledMarginReductions || 0) + 1
            debug.controlledMarginReductionCp = (debug.controlledMarginReductionCp || 0) + diag.marginReduction
          }
          if (diag.controlledRefusal) {
            debug.controlledRefusals = (debug.controlledRefusals || 0) + 1
          }
          if (typeof diag.bestCp === 'number' && typeof diag.selectedCp === 'number') {
            debug.controlledMarginBestCpTotal = (debug.controlledMarginBestCpTotal || 0) + diag.bestCp
            debug.controlledMarginSelectedCpTotal = (debug.controlledMarginSelectedCpTotal || 0) + diag.selectedCp
            const count = Math.max(1, debug.closeWinSelections || 1)
            debug.controlledMarginAverageBestCp = Math.round(debug.controlledMarginBestCpTotal / count)
            debug.controlledMarginAverageSelectedCp = Math.round(debug.controlledMarginSelectedCpTotal / count)
          }
        } else debug.trapSelections = (debug.trapSelections || 0) + 1
        debug.replacementSelections = (debug.replacementSelections || 0) + 1
        if (diag.mode === 'Combined Personality') debug.combinedSelections = (debug.combinedSelections || 0) + 1
        const categorySelections = { ...(debug.categorySelections || {}) }
        const key = diag.type || 'Unknown'
        categorySelections[key] = (categorySelections[key] || 0) + 1
        debug.categorySelections = categorySelections
        if (diag.type === 'Controlled Margin') {
          console.info('[ControlledMargin]', {
            selectedEval: diag.selectedCp,
            used_for_display: false,
            replacement: !!diag.move,
            marginReduction: diag.marginReduction
          })
        } else {
          console.info('[HumanTrap]', {
            trapEval: diag.trapEval,
            used_for_display: false,
            replacement: !!diag.move,
            type: diag.type
          })
        }
        console.info('[engine-personality]', {
          mode: diag.mode,
          type: diag.type,
          displayEval: diag.displayEval,
          rootBestEval: diag.rootBestEval,
          probeEval: diag.probeEval,
          trapEval: diag.trapEval,
          marginCandidateEval: diag.marginCandidateEval,
          bestCp: diag.bestCp,
          selectedCp: diag.selectedCp,
          marginReduction: diag.marginReduction,
          probeStats: diag.probeStats,
          attackableTrapTarget: diag.attackableTrapTarget,
          enemyAttackCoverage: diag.enemyAttackCoverage,
          temptationValidation: diag.temptationValidation,
          simplificationAvoidanceReason: diag.simplificationAvoidanceReason
        })
        state.enginePersonalityDebug = debug
      }
    },
    enginePersonalityDebug (state, payload) {
      state.enginePersonalityDebug = { ...(state.enginePersonalityDebug || {}), ...(payload || {}) }
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
      const before = state.startGameModal || {}
      state.startGameModal = Object.assign({}, before, payload)
      if (payload && ('humanTrapMode' in payload || 'closeWinMode' in payload)) {
        console.info('[Personality]', {
          selectorEntered: false,
          settingsChanged: true,
          humanTrap: !!state.startGameModal.humanTrapMode,
          controlledMargin: !!state.startGameModal.closeWinMode
        })
        if ('humanTrapMode' in payload) console.info('[HumanTrap]', { entered: !!state.startGameModal.humanTrapMode, selected: 'n/a', reason: 'setting_changed' })
        if ('closeWinMode' in payload) console.info('[ControlledMargin]', { entered: !!state.startGameModal.closeWinMode, selected: 'n/a', reason: 'setting_changed' })
      }
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
      const nextPayload = Array.isArray(payload) ? payload.slice() : []
      for (const pvline of nextPayload) {
        if (pvline) {
          pvline.cpDisplay = typeof pvline.mate === 'number' ? `#${pvline.mate}` : cpToString(pvline.cp)
        }
      }
      state.multipv = nextPayload
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
      state.lastAnalysisResult = emptyDisplayAnalysisResult()
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
      state.lastAnalysisResult = emptyDisplayAnalysisResult()
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
    openingGraph (state, payload) {
      state.openingGraph = payload || createOpeningGraph()
    },
    openingBook (state, payload) {
      const next = { ...state.openingBook, ...(payload || {}) }
      next.recommendationCount = Math.max(1, Math.min(8, Number(next.recommendationCount) || 3))
      next.standard16SelectionMode = next.standard16SelectionMode === 'random' ? 'random' : 'cycle'
      state.openingBook = next
    },
    openingGeneration (state, payload) {
      state.openingGeneration = { ...state.openingGeneration, ...(payload || {}) }
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
    scheduleOpeningBookPersist (context, payload = {}) {
      const immediate = payload.immediate === true
      const state = context.state.openingBookPersist || { queued: false, pendingCommits: 0, lastFlushedAt: 0 }
      state.pendingCommits = (state.pendingCommits || 0) + 1
      context.state.openingBookPersist = state
      if (immediate) {
        return context.dispatch('persistOpeningBookFlush')
      }
      if (state.queued) return
      state.queued = true
      const now = Date.now()
      const elapsedSinceFlush = state.lastFlushedAt ? (now - state.lastFlushedAt) : null
      const graph = normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph())
      console.log('[opening-book] persist queued', {
        queuedCommitCount: state.pendingCommits,
        graphSizeEstimate: Object.keys(graph.transitions || {}).length,
        elapsedSinceLastFlushMs: elapsedSinceFlush
      })
      const delayMs = (context.state.openingGeneration && context.state.openingGeneration.running) ? 1500 : 400
      setTimeout(() => context.dispatch('persistOpeningBookFlush'), delayMs)
    },
    persistOpeningBookFlush (context) {
      const state = context.state.openingBookPersist || { queued: false, pendingCommits: 0, lastFlushedAt: 0 }
      if (!state.queued && !state.pendingCommits) return
      state.queued = false
      const now = Date.now()
      const elapsedSinceFlush = state.lastFlushedAt ? (now - state.lastFlushedAt) : null
      const queuedCommitCount = state.pendingCommits || 0
      state.pendingCommits = 0
      state.lastFlushedAt = now
      context.state.openingBookPersist = state
      try {
        const graph = normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph())
        localStorage.setItem('openingBookGraph', JSON.stringify(graph))
        localStorage.setItem('openingBookConfig', JSON.stringify(context.state.openingBook || {}))
        localStorage.setItem('openingStartPool', JSON.stringify(context.state.openingStartPool || []))
        if (!state.lastSnapshotAt || now - state.lastSnapshotAt > 5 * 60 * 1000) {
          const snapshot = {
            format: 'LIGROUND-OPENING-BOOK',
            version: 2,
            exportedAt: new Date().toISOString(),
            config: context.state.openingBook || {},
            graph,
            startPool: context.state.openingStartPool || []
          }
          localStorage.setItem('openingBookAutosave3', localStorage.getItem('openingBookAutosave2') || '')
          localStorage.setItem('openingBookAutosave2', localStorage.getItem('openingBookAutosave1') || '')
          localStorage.setItem('openingBookAutosave1', JSON.stringify(snapshot))
          state.lastSnapshotAt = now
        }
        console.log('[opening-book] persist flushed', {
          queuedCommitCount,
          graphSizeEstimate: Object.keys(graph.transitions || {}).length,
          elapsedSinceLastFlushMs: elapsedSinceFlush
        })
      } catch (err) {
      // Ignore invalid speculative reply moves from variants with unusual capture rules.
    }
    },
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
      try {
        if (localStorage.mistakePreventionSettings) context.commit('mistakePreventionSettings', JSON.parse(localStorage.mistakePreventionSettings))
        if (localStorage.mistakeNotebook) context.state.mistakeNotebook = JSON.parse(localStorage.mistakeNotebook)
      } catch (err) {
        localStorage.removeItem('mistakePreventionSettings')
        localStorage.removeItem('mistakeNotebook')
      }
      context.dispatch('loadOpeningBookFromStorage')
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
    async analyzeMistakePreventionMove (context, payload) {
      const fen = payload.fen
      const move = payload.move
      const settings = context.state.mistakePrevention || {}
      const depth = Math.max(10, Math.min(20, Number(payload.depth || settings.verificationDepth) || 14))
      const root = await engine.reviewAnalysis({ fen, line: [move], variant: context.state.variant, depth, multiPv: 3, maxReviewMoves: 0 })
      const best = root && root.root && root.root.candidates && root.root.candidates[0]
      const user = root && root.user && root.user.candidates && root.user.candidates[0]
      const after = root && root.after && root.after.candidates && root.after.candidates[0]
      const beforeCp = scoreToCpForStore(best)
      const userCp = scoreToCpForStore(user)
      const rawCpLoss = beforeCp === null || userCp === null ? 0 : Math.max(0, beforeCp - userCp)
      const cpLoss = settings.evaluationMode === 'perfect' ? rawCpLoss : practicalCpLoss({ rawCpLoss, beforeCp, userCp })
      return { root, best, user, after, beforeCp, userCp, cpLoss, rawCpLoss, evaluationMode: settings.evaluationMode === 'perfect' ? 'perfect' : 'practical', verificationDepth: depth }
    },
    async recordRejectedMistake (context, { fen, move, analysis }) {
      const bestMove = (analysis.best && analysis.best.ucimove) || (analysis.root && analysis.root.root && analysis.root.root.bestmove) || ''
      let previewFen = ''
      let responsePreviewFen = ''
      try {
        const board = boardFromFen(context.state.variant, fen, context.getters.is960)
        board.push(move)
        previewFen = board.fen()
        if (analysis.after && analysis.after.ucimove) {
          board.push(analysis.after.ucimove)
          responsePreviewFen = board.fen()
        }
      } catch (err) {}
      const entry = {
        id: `${Date.now()}-${move}`,
        position: fen,
        userMove: move,
        engineBestMove: bestMove,
        cpLoss: analysis.cpLoss,
        rawCpLoss: analysis.rawCpLoss,
        pointLoss: Number(pointLossString(analysis.cpLoss)),
        evaluationBefore: analysis.beforeCp,
        evaluationAfter: analysis.userCp,
        moveQualityColor: moveQualityColor(analysis.cpLoss),
        pv: (analysis.best && analysis.best.pvUCI) || '',
        opponentBestResponse: (analysis.after && analysis.after.ucimove) || '',
        timestamp: new Date().toISOString(),
        evaluationMode: analysis.evaluationMode,
        verificationDepth: analysis.verificationDepth,
        previewFen,
        responsePreviewFen,
        pieceType: mistakePieceFromFen(fen, move),
        pattern: classifyMistakePattern({ fen, move, bestMove, cpLoss: analysis.cpLoss }),
        explanation: `내 수 ${move}는 엔진 추천 ${bestMove || '없음'}보다 ${analysis.cpLoss}cp (${pointLossString(analysis.cpLoss)} points) 손해입니다.`,
        reviewMove: {
          ply: context.state.moves.length + 1,
          move,
          side: 'user',
          sideLabel: '내 수',
          previewFen,
          punishmentMove: (analysis.after && analysis.after.ucimove) || '',
          bestMove,
          bestPv: (analysis.best && analysis.best.pvUCI) || '',
          classification: analysis.cpLoss >= 300 ? 'blunder' : 'mistake',
          classificationLabel: analysis.cpLoss >= 300 ? 'Large Mistake' : 'Mistake',
          severity: analysis.cpLoss >= 300 ? 'blunder' : 'mistake',
          tone: 'critical',
          loss: analysis.cpLoss,
          rawLoss: analysis.rawCpLoss
        },
        responseReviewMove: responsePreviewFen ? {
          ply: context.state.moves.length + 2,
          move: (analysis.after && analysis.after.ucimove) || '',
          side: 'opponent',
          sideLabel: '상대 응수',
          previewFen: responsePreviewFen,
          classification: 'response',
          classificationLabel: 'Opponent response',
          severity: 'neutral',
          tone: 'practical',
          loss: 0
        } : null
      }
      context.commit('addMistakeNotebookEntry', entry)
      context.commit('humanTrapDiagnostics', { mode: '실수방지 모드', type: 'Move Rejected', reason: entry.explanation, cpLoss: entry.cpLoss, pointLoss: entry.pointLoss, move: entry.userMove, bestMove: entry.engineBestMove, pv: entry.pv, selectedAt: Date.now() })
      return entry
    },
    async push (context, payload) {
      if (context.state.mistakePrevention && context.state.mistakePrevention.enabled && payload && !payload.skipMistakePrevention) {
        const fenBefore = context.state.fen
        const move = String(payload.move || '').split(' ')[0]
        context.commit('mistakePreventionPending', true)
        try {
          const analysis = await context.dispatch('analyzeMistakePreventionMove', { fen: fenBefore, move })
          if (analysis.cpLoss > (context.state.mistakePrevention.thresholdCp || 300)) {
            await context.dispatch('recordRejectedMistake', { fen: fenBefore, move, analysis })
            context.dispatch('updateBoard')
            return false
          }
        } finally {
          context.commit('mistakePreventionPending', false)
        }
      }
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
      context.commit('humanTrapDiagnostics', null)
      context.commit('enginePersonalityDebug', { trapAttempts: 0, trapSelections: 0, closeWinSelections: 0, replacementSelections: 0, combinedSelections: 0, controlledMarginReductions: 0, controlledMarginReductionCp: 0, controlledRefusals: 0, controlledMarginBestCpTotal: 0, controlledMarginSelectedCpTotal: 0, controlledMarginAverageBestCp: 0, controlledMarginAverageSelectedCp: 0, categorySelections: {} })
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
      const personality = personalityFlagsFromState(context.state)
      const rootFen = context.getters.fen
      let rootLines = []
      let handleBestMove
      let handleInfo
      const bestMovePromise = new Promise(resolve => {
        handleBestMove = move => resolve(move)
        engine.on('bestmove', handleBestMove)
      })
      if (personality.enabled) {
        handleInfo = info => collectRootInfoLine(rootLines, info)
        engine.on('info', handleInfo)
      }

      context.dispatch('goEngine', payload)

      try {
        let bestmove = sanitizeEngineMove(await bestMovePromise)
        if (requestSeq !== context.state.singleMoveRequestSeq) return
        if (!bestmove) return
        if (context.state.mistakePrevention && context.state.mistakePrevention.opponentTraining) {
          const level = MISTAKE_PREVENTION_LEVELS.find(l => l.name === context.state.mistakePrevention.opponentLevelName) || MISTAKE_PREVENTION_LEVELS.find(l => l.name === context.state.mistakePrevention.levelName) || MISTAKE_PREVENTION_LEVELS[2]
          const selectedTraining = await selectTrainingOpponentMove({ engineInstance: engine, fen: rootFen, variant: context.getters.variant, is960: context.getters.is960, level, chaos: context.state.mistakePrevention.chaosTraining })
          if (selectedTraining && selectedTraining.move && context.state.board.legalMoves().includes(selectedTraining.move) && normalizeFen(context.getters.fen) === normalizeFen(rootFen)) {
            bestmove = selectedTraining.move
            context.commit('humanTrapDiagnostics', { mode: 'Opponent Training Strength', type: level.name, move: bestmove, cpLoss: selectedTraining.cpLoss, pointLoss: Number(pointLossString(selectedTraining.cpLoss)), reason: `${context.state.mistakePrevention.chaosTraining ? 'chaos' : 'human-like'} sampled legal move within ${selectedTraining.maxLoss}cp${selectedTraining.openingProtected ? ' (opening protected)' : ''}`, probeStats: { probes: selectedTraining.sampled }, selectedAt: Date.now() })
          }
        }
        if (personality.enabled) {
          context.commit('enginePersonalityDebug', { trapAttempts: (context.state.enginePersonalityDebug.trapAttempts || 0) + 1 })
          const selected = await selectPersonalityMove({
            engineInstance: engine,
            fen: rootFen,
            variant: context.getters.variant,
            is960: context.getters.is960,
            bestmove,
            rootLines: rootLines.filter(Boolean),
            humanTrapSettings: personality.humanTrapSettings,
            closeWinSettings: personality.closeWinSettings,
            sideToMove: context.getters.turn
          })
          if (selected && selected.move && context.state.board.legalMoves().includes(selected.move) && normalizeFen(context.getters.fen) === normalizeFen(rootFen)) {
            bestmove = selected.move
            context.commit('personalityDiagnostics', { ...selected, selectedAt: Date.now() })
          } else if (selected) {
            context.commit('personalityDiagnostics', { ...selected, selectedAt: Date.now() })
          }
        }
        await context.dispatch('push', { move: bestmove, prev: context.getters.currentMove[0], skipMistakePrevention: true })
      } catch (err) {
        console.error('[playSingleEngineMove] Failed to apply single engine move:', err)
      } finally {
        if (handleBestMove) {
          engine.off('bestmove', handleBestMove)
        }
        if (handleInfo) engine.off('info', handleInfo)
        context.dispatch('stopEngine')
      }
    },
    async goEngine (context, payload = {}) {
      const source = payload && payload.source ? payload.source : 'unknown'
      if (context.state.openingGeneration && context.state.openingGeneration.running) {
        console.warn('[engine-guard] goEngine blocked during opening-generation session', { source, payload })
        return
      }
      const { goCmd } = await context.dispatch('computeEngineSearchLimits', payload)
      const personality = personalityFlagsFromState(context.state)
      if (personality.enabled) {
        console.info('[Personality]', {
          humanTrap: personality.humanTrapSettings.enabled,
          controlledMargin: personality.closeWinSettings.enabled,
          selectorEntered: true,
          phase: 'analysis-search-start',
          source
        })
        if (personality.humanTrapSettings.enabled) {
          console.info('[HumanTrap]', { entered: true, candidates: 0, filtered: 0, probed: 0, selected: 'pending', reason: 'awaiting_root_bestmove' })
        }
        if (personality.closeWinSettings.enabled) {
          console.info('[ControlledMargin]', { entered: true, bestEval: null, selected: 'pending', reason: 'awaiting_root_bestmove' })
        }
        context.commit('humanTrapDiagnostics', {
          mode: 'Engine Personality',
          type: 'Selector Active',
          selectorEntered: true,
          humanTrapEnabled: personality.humanTrapSettings.enabled,
          controlledMarginEnabled: personality.closeWinSettings.enabled,
          reason: 'analysis_root_search_started',
          selectedAt: Date.now()
        })
        engine.send(`setoption name MultiPV value ${Math.max(personality.humanTrapSettings.multiPv, personality.closeWinSettings.maxCandidates)}`)
      }
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
        context.dispatch('push', { move, prev: context.getters.currentMove[0], skipMistakePrevention: true }).then(() => {
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
        const personality = personalityFlagsFromState(context.state)
        const humanTrapSettings = normalizeTrapSettings({
          ...personality.humanTrapSettings,
          ...(payload.humanTrapSettings || {}),
          enabled: !!(payload.humanTrapMode || (context.state.startGameModal && context.state.startGameModal.humanTrapMode))
        })
        const closeWinSettings = normalizeCloseWinSettings({
          ...personality.closeWinSettings,
          ...(payload.closeWinSettings || {}),
          enabled: !!(payload.closeWinMode || (context.state.startGameModal && context.state.startGameModal.closeWinMode))
        })

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
          if (humanTrapSettings.enabled || closeWinSettings.enabled) {
            console.info('[Personality]', {
              humanTrap: humanTrapSettings.enabled,
              controlledMargin: closeWinSettings.enabled,
              selectorEntered: true,
              phase: 'pve-configured'
            })
            if (humanTrapSettings.enabled) console.info('[HumanTrap]', { entered: true, candidates: 0, filtered: 0, probed: 0, selected: 'pending', reason: 'pve_waiting_for_engine_turn' })
            if (closeWinSettings.enabled) console.info('[ControlledMargin]', { entered: true, bestEval: null, selected: 'pending', reason: 'pve_waiting_for_engine_turn' })
            pveEngine.send(`setoption name MultiPV value ${Math.max(humanTrapSettings.multiPv, closeWinSettings.maxCandidates)}`)
          }
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
        let humanTrapRootFen = ''
        let humanTrapRootLines = []

        const pveInfoHandler = info => {
          if (!(humanTrapSettings.enabled || closeWinSettings.enabled) || !info || !('pv' in info)) return
          const rank = Number(info.multipv) || 1
          const ucimove = typeof info.pv === 'string' ? info.pv.split(/\s+/)[0] : ''
          if (!ucimove) return
          humanTrapRootLines[rank - 1] = {
            multipv: rank,
            cp: info.cp,
            mate: info.mate,
            depth: info.depth,
            pvUCI: info.pv,
            ucimove
          }
        }

        // send position and go to the engine instance
        const sendPositionAndGo = (inst, lim) => {
          try {
            humanTrapRootFen = context.getters.fen
            humanTrapRootLines = []
            if (humanTrapSettings.enabled || closeWinSettings.enabled) {
              console.info('[Personality]', {
                humanTrap: humanTrapSettings.enabled,
                controlledMargin: closeWinSettings.enabled,
                selectorEntered: true,
                phase: 'pve-search-start'
              })
              if (humanTrapSettings.enabled) console.info('[HumanTrap]', { entered: true, candidates: 0, filtered: 0, probed: 0, selected: 'pending', reason: 'awaiting_root_bestmove' })
              if (closeWinSettings.enabled) console.info('[ControlledMargin]', { entered: true, bestEval: null, selected: 'pending', reason: 'awaiting_root_bestmove' })
              context.commit('humanTrapDiagnostics', {
                mode: 'Engine Personality',
                type: 'Selector Active',
                selectorEntered: true,
                humanTrapEnabled: humanTrapSettings.enabled,
                controlledMarginEnabled: closeWinSettings.enabled,
                reason: 'pve_root_search_started',
                selectedAt: Date.now()
              })
            } else {
              context.commit('humanTrapDiagnostics', null)
            }
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
            let move = sanitizeEngineMove(ucimove)
            if (!move) return
            if (humanTrapSettings.enabled || closeWinSettings.enabled) {
              context.commit('enginePersonalityDebug', { trapAttempts: (context.state.enginePersonalityDebug.trapAttempts || 0) + 1 })
              const currentFen = context.getters.fen
              const selected = await selectPersonalityMove({
                engineInstance: pveEngine,
                fen: humanTrapRootFen || currentFen,
                variant: context.getters.variant,
                is960: context.getters.is960,
                bestmove: move,
                rootLines: humanTrapRootLines.filter(Boolean),
                humanTrapSettings,
                closeWinSettings,
                sideToMove: turnIsWhite
              })
              const stillEngineToMove = ((context.getters.turn && engineIsWhite) || (!context.getters.turn && !engineIsWhite))
              if (!context.state.PvE || !stillEngineToMove || normalizeFen(context.getters.fen) !== normalizeFen(currentFen)) return
              if (selected && selected.move && context.state.board.legalMoves().includes(selected.move)) {
                move = selected.move
                context.commit('personalityDiagnostics', { ...selected, selectedAt: Date.now() })
                console.info('[engine-personality] selected', selected)
              } else if (selected) {
                context.commit('personalityDiagnostics', { ...selected, selectedAt: Date.now() })
              } else {
                context.commit('personalityDiagnostics', null)
              }
            }
            await context.dispatch('push', { move, prev: context.getters.currentMove[0] })
          } catch (err) {
            console.error('[PvEMakeMove] Engine provided invalid move:', ucimove, err)
            // try to restart the engine calculation on current position
            context.dispatch('position')
            sendPositionAndGo(pveEngine, pveLimiter)
          }
        }

        // attach listeners
        if (humanTrapSettings.enabled || closeWinSettings.enabled) pveEngine.on('info', pveInfoHandler)
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
            let move = sanitizeEngineMove(ucimove)
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
            let move = sanitizeEngineMove(ucimove)
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
      context.commit('humanTrapDiagnostics', null)
      if (!context.getters.turn) {
        context.dispatch('stopEngine')
      } else {
        context.commit('resetEngineTime')
        context.commit('active', false)
      }
    },
    stopEngine (context, payload = {}) {
      const source = payload && payload.source ? payload.source : 'unknown'
      console.log('[engine-stop] requested', { source, stack: (new Error('[trace] stopEngine caller')).stack })
      if (
        context.state.openingGeneration &&
        context.state.openingGeneration.running &&
        context.state.openingGeneration.analysisActive &&
        source !== 'opening-generation'
      ) {
        console.warn('[engine-guard] stopEngine blocked during opening-generation session', { source })
        return
      }
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
      const source = payload && payload.__source ? payload.__source : 'unknown'
      const optionsPayload = { ...(payload || {}) }
      delete optionsPayload.__source
      console.log('[engine-options] setEngineOptions:requested', {
        activeEngine: context.state.activeEngine,
        source,
        payload: optionsPayload,
        stack: (new Error('[trace] setEngineOptions caller')).stack
      })
      if (context.getters.active && !context.getters.PvE) {
        context.dispatch('stopEngine', { source: `setEngineOptions:${source}` })
      } else if (context.getters.active && context.getters.PvE && !context.getters.turn) {
        context.dispatch('stopEngine', { source: `setEngineOptions:${source}` })
      }
      context.dispatch('resetEngineData')
      for (const [name, value] of Object.entries(optionsPayload)) {
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
        if (context.state.openingGeneration && context.state.openingGeneration.analysisActive) {
          return
        }
        context.dispatch('stopEngine')
        context.commit('analysisMode', false)
        return
      }

      // update pvline. Display eval is deliberately anchored to root MultiPV #1 only;
      // speculative/personality candidates remain internal diagnostics and must not move the eval bar.
      if ('pv' in payload) {
        const rootRank = Number(payload.multipv) || 1
        if (rootRank === 1) {
          const rootEval = typeof payload.cp === 'number' ? payload.cp : context.state.lastAnalysisResult.cp
          context.commit('lastAnalysisResult', {
            cp: rootEval,
            mate: typeof payload.mate === 'number' ? payload.mate : null,
            pv: payload.pv || '',
            ucimove: payload.pv ? payload.pv.split(/\s/)[0] : '',
            turn: context.state.turn,
            displaySource: 'root_multipv_1',
            displayDepth: payload.depth,
            displayEval: rootEval,
            probeEval: null,
            trapEval: null,
            marginCandidateEval: null,
            wdl: Array.isArray(payload.wdl) ? payload.wdl : context.state.lastAnalysisResult.wdl,
            wdlWin: 'wdlWin' in payload ? payload.wdlWin : context.state.lastAnalysisResult.wdlWin,
            wdlDraw: 'wdlDraw' in payload ? payload.wdlDraw : context.state.lastAnalysisResult.wdlDraw,
            wdlLoss: 'wdlLoss' in payload ? payload.wdlLoss : context.state.lastAnalysisResult.wdlLoss
          })
          console.info('[DisplayEval]', {
            rootEval,
            displayEval: rootEval,
            source: 'root_multipv_1',
            depth: payload.depth,
            pv: payload.pv || ''
          })
        } else {
          console.info('[ProbeEval]', {
            candidate: typeof payload.cp === 'number' ? payload.cp : null,
            multipv: rootRank,
            ignored_for_display: true
          })
        }
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
      context.dispatch('rebuildOpeningGraphFromLoadedGames')
    },
    rebuildOpeningGraphFromLoadedGames (context) {
      const graph = createOpeningGraph()
      const games = Array.isArray(context.state.loadedGames) ? context.state.loadedGames : []
      for (const game of games) {
        if (!game || !game.mainlineMoves) continue
        let variant = (game.headers('Variant') || '').toLowerCase()
        if (!variant) variant = 'chess'
        if (!context.getters.variantOptions.revGet(variant) && variant !== 'chess960' && variant !== 'fischerandom') continue
        let fen = game.headers('FEN')
        let boardVariant = variant
        let is960 = false
        if (variant === 'chess960' || variant === 'fischerandom') {
          boardVariant = 'chess'
          is960 = true
        }
        let board
        try {
          board = fen ? new ffish.Board(boardVariant, fen, is960) : new ffish.Board(boardVariant)
        } catch (err) {
          continue
        }
        const movesText = String(game.mainlineMoves() || '').trim()
        const moves = movesText ? movesText.split(/\s+/) : []
        const positions = [board.fen()]
        let legal = true
        for (const uci of moves) {
          try {
            board.push(uci)
            positions.push(board.fen())
          } catch (err) {
            legal = false
            break
          }
        }
        if (legal) addSequenceToOpeningGraph(graph, { moves, positions })
      }
      context.commit('openingGraph', graph)
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
    },
    openingBook (context, payload) {
      context.commit('openingBook', payload)
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
    },
    openingStartPool (context, payload) {
      const list = Array.isArray(payload) ? payload : []
      const normalized = list
        .map(item => ({
          name: String((item && item.name) || '시작 포지션'),
          variant: String((item && item.variant) || context.state.variant),
          fen: String((item && item.fen) || '').trim()
        }))
        .filter(item => item.variant === context.state.variant)
      context.state.openingStartPool = normalized
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
    },
    addCurrentGameToOpeningBook (context) {
      const graph = normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph())
      const moves = context.getters.currentMainlineUci
      let board
      try {
        board = new ffish.Board(context.state.variant, context.state.startFen, context.state.board && context.state.board.is960 && context.state.board.is960())
      } catch (err) {
        return
      }
      const positions = [board.fen()]
      for (const uci of moves) {
        try {
          board.push(uci)
          positions.push(board.fen())
        } catch (err) {
          break
        }
      }
      addSequenceToOpeningGraph(graph, { moves, positions, source: 'manual' })
      context.commit('openingGraph', graph)
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
    },
    playOpeningBookMove (context) {
      const cfg = context.state.openingBook || {}
      if (!cfg.enabled) return
      const candidates = context.getters.openingCandidates || []
      if (!candidates.length) return
      const picked = chooseWeightedCandidate(candidates, {
        topK: cfg.autoResponseTopK || 3,
        temperature: cfg.autoResponseTemperature || 1,
        policy: cfg.moveSelectionPolicy || 'practical'
      })
      if (!picked || !picked.uci) return
      const move = picked.uci
      const current = context.state.moves.find(m => m.fen === context.state.fen)
      context.commit('appendMoves', { move, prev: current })
      context.dispatch('fen', context.state.board.fen())
      context.dispatch('updateBoard')
      context.dispatch('position')
    },
    async runAutoOpeningGeneration (context, payload = {}) {
      const nextSessionId = (context.state.openingGeneration.sessionId || 0) + 1
      console.log('[opening-gen] start requested', {
        variant: context.state.variant,
        fen: context.state.startFen,
        overrideStartPool: Array.isArray(payload && payload.startPoolOverride),
        stopRequested: context.state.openingGeneration && context.state.openingGeneration.stopRequested
      })
      context.commit('openingGeneration', {
        sessionId: nextSessionId,
        optionSyncKey: '',
        running: true,
        stopRequested: false,
        analysisActive: false,
        completedGames: 0,
        completedMoves: 0,
        currentDepth: 0,
        currentMove: '',
        currentStart: '',
        savedBranches: 0,
        lastStopReason: '',
        lastStopDetail: ''
      })
      const cfg = context.state.openingBook || {}
      const setGenerationStop = (reason, detail = '') => {
        const lastStopDetail = typeof detail === 'string' ? detail : JSON.stringify(detail)
        context.commit('openingGeneration', { lastStopReason: reason, lastStopDetail })
        console.log('[opening-gen] stop reason', { reason, detail })
      }
      if (!cfg.autoGenerateEnabled) {
        console.log('[opening-gen] autoGenerateEnabled=false, continuing because manual run was requested')
      }
      const iterations = cfg.autoGenerateUnlimited ? Number.MAX_SAFE_INTEGER : Math.max(1, Number(cfg.autoGenerateIterations) || 8)
      const maxPlies = Math.max(2, Math.min(80, Number(cfg.autoGenerateMaxPlies) || 16))
      const earlyPlies = Math.max(2, Math.min(maxPlies, Number(cfg.autoGenerateEarlyPlies) || 10))
      const usePool = cfg.useStartPool !== false
      const hasOverridePool = Array.isArray(payload && payload.startPoolOverride) && payload.startPoolOverride.length > 0
      const useStandard16 = !hasOverridePool && cfg.useStandard16OpeningSet === true && ['janggi', 'janggimodern'].includes(context.state.variant)
      const poolRaw = hasOverridePool
        ? payload.startPoolOverride
        : (useStandard16
          ? janggiStandard16OpeningPositions(context.state.variant)
          : (usePool && Array.isArray(context.state.openingStartPool) && context.state.openingStartPool.length
            ? context.state.openingStartPool
            : [{ variant: context.state.variant, fen: context.state.startFen || '' }]))
      const pool = poolRaw.filter(item => item && item.variant === context.state.variant)
      const validPool = []
      let invalidStartCount = 0
      for (const item of pool) {
        try {
          const board = item.fen ? new ffish.Board(item.variant || context.state.variant, item.fen) : new ffish.Board(item.variant || context.state.variant)
          validPool.push({ ...item, fen: board.fen() })
        } catch (err) {
          invalidStartCount += 1
          console.warn('[opening-gen] invalid start position skipped', { name: item && item.name, fen: item && item.fen, error: err && err.message })
        }
      }
      if (!validPool.length) {
        setGenerationStop('invalid_start_position', `No valid start positions (${invalidStartCount} invalid).`)
        context.commit('openingGeneration', { running: false, stopRequested: false, currentMove: '', currentDepth: 0, currentStart: '' })
        await context.dispatch('persistOpeningBookFlush')
        return { generatedGames: 0, generatedMoves: 0 }
      }
      let generatedMoves = 0
      let g = 0
      const minTrustedCount = Math.max(0, Number(cfg.autoGenerateMinTrustedCount) || 2)
      while (g < iterations) {
        console.log('[opening-gen] game-loop begin', { gameIndex: g + 1, iterations })
        if (context.state.openingGeneration.stopRequested) {
          setGenerationStop('stop_requested', `Stopped before game ${g + 1}.`)
          break
        }
        const start = useStandard16 && cfg.standard16SelectionMode !== 'random'
          ? validPool[g % validPool.length]
          : validPool[Math.floor(Math.random() * validPool.length)]
        let board
        try {
          board = start.fen ? new ffish.Board(start.variant || context.state.variant, start.fen) : new ffish.Board(start.variant || context.state.variant)
          context.commit('openingGeneration', { currentStart: start.name || board.fen() })
        } catch (err) {
          setGenerationStop('invalid_start_position', err && err.message ? err.message : 'Failed to initialize start position.')
          break
        }
        const positions = [board.fen()]
        const moves = []
        let plyStopReason = 'max_depth_reached'
        for (let ply = 0; ply < maxPlies; ply++) {
          if (context.state.openingGeneration.stopRequested) {
            plyStopReason = 'stop_requested'
            setGenerationStop('stop_requested', `Stopped at game ${g + 1}, ply ${ply + 1}.`)
            break
          }
          console.log('[opening-gen] ply begin', { gameIndex: g + 1, ply: ply + 1, fen: board.fen() })
          const configuredDepth = Number(cfg.autoGenerateDepth)
          const analysisDepth = Math.max(4, configuredDepth || 12)
          const usedFallbackDepth = !(Number.isFinite(configuredDepth) && configuredDepth > 0)
          const analyzed = await context.dispatch('analyzeOpeningGenerationPosition', {
            fen: board.fen(),
            variant: context.state.variant,
            depth: analysisDepth,
            topK: Math.max(1, Number(cfg.autoGenerateTopK) || 3)
          })
          const baseCpThreshold = Math.max(0, Number(cfg.autoGenerateCpThreshold) || 50)
          // Lower-depth generated analysis is intentionally given a wider best-relative
          // CP window; higher-depth searches are allowed to prune more strictly.
          const depthTolerance = analysisDepth < 12 ? 35 : (analysisDepth > 20 ? -15 : 0)
          const cpThreshold = Math.max(10, baseCpThreshold + depthTolerance)
          const sortedAnalyzed = (analyzed || []).slice().sort((a, b) => (b.score || -999999) - (a.score || -999999))
          const bestScore = sortedAnalyzed.length ? Number(sortedAnalyzed[0].score || 0) : null
          const acceptedRaw = bestScore === null
            ? []
            : sortedAnalyzed.filter(c => Number(c.score || -999999) >= (bestScore - cpThreshold))
          const acceptedTotal = acceptedRaw.reduce((sum, c) => {
            const delta = Math.max(0, bestScore - Number(c.score || bestScore))
            return sum + Math.max(0.0001, cpThreshold - delta + 1)
          }, 0) || 1
          const acceptedAnalyzed = acceptedRaw.map(c => {
            const delta = Math.max(0, bestScore - Number(c.score || bestScore))
            const weight = Math.max(0.0001, cpThreshold - delta + 1)
            return { ...c, weight, share: weight / acceptedTotal }
          })
          console.log('[opening-gen] analysis result', {
            gameIndex: g + 1, ply: ply + 1, configuredDepth, analysisDepth, usedFallbackDepth,
            candidateCount: analyzed.length, cpThreshold, bestScore,
            analyzedScores: sortedAnalyzed.map(c => ({ uci: c.uci, score: c.score })),
            accepted: acceptedAnalyzed.map(c => ({ uci: c.uci, score: c.score }))
          })
          const liveGraph = normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph())
          const graphCandidates = openingCandidatesForFen(liveGraph, board.fen(), Math.max(1, Number(cfg.autoGenerateTopK) || 3), {
            policy: cfg.moveSelectionPolicy || 'practical',
            explorationStrength: 0.45
          })
          const candidates = (acceptedAnalyzed.length ? acceptedAnalyzed : graphCandidates)
            .map(c => {
              if (!acceptedAnalyzed.length) return c
              const known = graphCandidates.find(item => item && item.uci === c.uci)
              return known
                ? { ...known, ...c, meta: { ...(known.meta || {}), effectiveCp: c.score }, count: known.count, trustedCount: Math.max(known.trustedCount || 0, minTrustedCount), exploratoryCount: known.exploratoryCount }
                : { ...c, count: 0, trustedCount: minTrustedCount, exploratoryCount: 0, meta: { effectiveCp: c.score, cpSamples: 0, confidence: 0.25, cpStdDev: 0 } }
            })
            .filter(c => (c.trustedCount || 0) >= minTrustedCount)
          const bestCandidateCp = candidates.reduce((best, c) => {
            const cp = Number(c && (c.score !== undefined ? c.score : (c.effectiveCp !== undefined ? c.effectiveCp : c.meta && c.meta.effectiveCp)))
            return Number.isFinite(cp) ? (best === null ? cp : Math.max(best, cp)) : best
          }, null)
          const inExploration = cfg.earlyRandomEnabled !== false && ply < earlyPlies
          const explorationCandidates = applyOpeningExplorationBias(candidates, {
            bestEffectiveCp: bestCandidateCp,
            maxCpDelta: cpThreshold,
            strength: inExploration ? 1 : 0.45,
            maxBonus: 0.65
          })
          console.log('[opening-gen] exploration candidates', {
            gameIndex: g + 1,
            ply: ply + 1,
            mode: inExploration ? 'frontier' : 'reinforce',
            candidates: explorationCandidates.map(c => ({
              uci: c.uci,
              score: c.score,
              explorationScore: c.explorationScore,
              explorationBonus: c.exploration && c.exploration.bonus,
              samples: c.exploration && c.exploration.samples,
              confidence: c.exploration && c.exploration.confidence,
              cpDelta: c.exploration && c.exploration.cpDelta,
              reason: c.exploration && c.exploration.reason
            }))
          })
          let picked = null
          if (explorationCandidates.length) {
            picked = chooseWeightedCandidate(explorationCandidates, {
              topK: inExploration ? (cfg.autoGenerateTopK || 3) : Math.min(2, cfg.autoGenerateTopK || 2),
              temperature: inExploration ? (cfg.autoGenerateTemperature || 1) : 0.6,
              policy: cfg.moveSelectionPolicy || 'practical',
              explorationBias: true
            })
          }
          if (!picked || !picked.uci) {
            plyStopReason = analyzed.length ? 'no_candidates' : 'engine_no_lines'
            setGenerationStop(plyStopReason, `Game ${g + 1}, ply ${ply + 1}: analyzed=${analyzed.length}, accepted=${acceptedAnalyzed.length}, candidates=${candidates.length}.`)
            break
          }
          try {
            const beforeFen = board.fen()
            let committedCount = 0
            for (const branch of acceptedAnalyzed) {
              if (!branch || !branch.uci) continue
              try {
                const branchBoard = new ffish.Board(context.state.variant, beforeFen)
                branchBoard.push(branch.uci)
                const committedBranch = await context.dispatch('commitGeneratedTransition', { fromFen: beforeFen, toFen: branchBoard.fen(), move: branch.uci, depth: analysisDepth, cp: branch.score, source: 'exploration', sessionId: nextSessionId })
                if (committedBranch) {
                  committedCount += 1
                  context.commit('openingGeneration', { savedBranches: context.state.openingGeneration.savedBranches + 1 })
                }
                console.log('[opening-gen] branch decision', { gameIndex: g + 1, ply: ply + 1, move: branch.uci, score: branch.score, accepted: true, committed: committedBranch, continuation: branch.uci === picked.uci })
              } catch (e) {
                console.warn('[opening-gen] branch commit failed', { gameIndex: g + 1, ply: ply + 1, move: branch.uci, error: e && e.message })
              }
            }
            board.push(picked.uci)
            moves.push(picked.uci)
            positions.push(board.fen())
            generatedMoves += 1
            context.commit('openingGeneration', { currentMove: picked.uci })
            if (!acceptedAnalyzed.length) {
              const committed = await context.dispatch('commitGeneratedTransition', { fromFen: beforeFen, toFen: board.fen(), move: picked.uci, depth: analysisDepth, cp: picked.score, source: 'exploration', sessionId: nextSessionId })
              console.log('[opening-gen] commit result', { gameIndex: g + 1, ply: ply + 1, move: picked.uci, committed, committedBranchCount: committedCount })
              if (committed) {
                context.commit('openingGeneration', { savedBranches: context.state.openingGeneration.savedBranches + 1 })
              }
            }
          } catch (err) {
            plyStopReason = 'move_push_failed'
            setGenerationStop('move_push_failed', `Game ${g + 1}, ply ${ply + 1}: ${err && err.message ? err.message : 'move failed'}`)
            console.warn('[opening-gen] ply failed', { gameIndex: g + 1, ply: ply + 1, error: err && err.message })
            break
          }
        }
        if (plyStopReason === 'max_depth_reached' && !context.state.openingGeneration.stopRequested) {
          setGenerationStop('max_depth_reached', `Game ${g + 1} reached ${maxPlies} plies.`)
        }
        g += 1
        context.commit('openingGeneration', { completedGames: g, completedMoves: generatedMoves })
        console.log('[opening-gen] game-loop end', { completedGames: g, completedMoves: generatedMoves })
        if (cfg.autoGenerateUnlimited && g % 200 === 0) {
          setGenerationStop('batch_checkpoint', `Paused after ${g} generated games for autosave.`)
          break
        }
      }
      console.log('[opening-gen] finished', { generatedGames: g, generatedMoves, stopRequested: context.state.openingGeneration.stopRequested })
      context.commit('openingGeneration', { running: false, stopRequested: false, currentMove: '', currentDepth: 0, currentStart: '' })
      await context.dispatch('persistOpeningBookFlush')
      return { generatedGames: g, generatedMoves }
    },
    runAutoOpeningGenerationFromCurrentPosition (context) {
      const fen = context.state.board && typeof context.state.board.fen === 'function'
        ? context.state.board.fen()
        : context.state.fen
      if (!fen) return { generatedGames: 0, generatedMoves: 0 }
      return context.dispatch('runAutoOpeningGeneration', {
        startPoolOverride: [{
          name: '현재 포지션',
          variant: context.state.variant,
          fen
        }]
      })
    },
    stopAutoOpeningGeneration (context) {
      context.commit('openingGeneration', { stopRequested: true })
    },
    commitGeneratedTransition (context, payload) {
      if (payload && payload.sessionId && context.state.openingGeneration && payload.sessionId !== context.state.openingGeneration.sessionId) {
        console.warn('[opening-gen] stale transition skipped', { move: payload.move, payloadSessionId: payload.sessionId, currentSessionId: context.state.openingGeneration.sessionId })
        return false
      }
      const graph = normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph())
      const positions = [payload.fromFen, payload.toFen].filter(Boolean)
      const moves = [payload.move].filter(Boolean)
      if (!positions.length || !moves.length) return false
      const epd = fenToEpd(payload.fromFen)
      const key = `${epd}|${payload.move}`
      const beforeCount = Math.max(0, Number((graph.transitions && graph.transitions[key]) || 0))
      addSequenceToOpeningGraph(graph, {
        moves,
        positions,
        source: payload && payload.source ? payload.source : 'exploration',
        moveMeta: [{ depth: payload && payload.depth, cp: payload && payload.cp }]
      })
      const afterCount = Math.max(0, Number((graph.transitions && graph.transitions[key]) || 0))
      if (afterCount <= beforeCount) {
        console.warn('[opening-gen] transition commit produced no count increase', { move: payload.move, beforeCount, afterCount })
        return false
      }
      context.commit('openingGraph', normalizeOpeningGraph(graph))
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
      console.log('[opening-gen] transition committed', { move: payload.move, depth: payload.depth, cp: payload.cp, afterCount })
      return true
    },
    async analyzeOpeningGenerationPosition (context, payload) {
      const localSessionId = context.state.openingGeneration && context.state.openingGeneration.sessionId
      const depth = Math.max(4, Number(payload && payload.depth) || 12)
      const topK = Math.max(1, Number(payload && payload.topK) || 3)
      const variant = payload.variant || context.state.variant
      const fen = payload.fen
      let infoHandler = null
      let bestMoveHandler = null
      let reachedDepth = 0
      let bestmove = ''
      let bestmoveAtMs = null
      let lastInfoAtMs = null
      let lastDepthIncreaseAtMs = null
      let lastDepthValue = 0
      let lastNodes = 0
      let lastNps = 0
      let depthProgressCount = 0
      let resolveReason = 'none'
      let stopReason = 'none'
      try {
        console.log('[opening-gen] analyze start', { fen, variant, depth, topK })
        await context.dispatch('stopEngine', { source: 'opening-generation' })
        context.dispatch('resetEngineData')
        const optionSyncKey = `${variant}|${topK}`
        if (context.state.openingGeneration.optionSyncKey !== optionSyncKey) {
          await context.dispatch('setEngineOptions', { MultiPV: topK, UCI_Variant: variant, __source: 'opening-generation' })
          context.commit('openingGeneration', { optionSyncKey })
        } else {
          console.log('[opening-gen] option sync skipped (unchanged)', { optionSyncKey })
        }
        context.commit('openingGeneration', { analysisActive: true })
        const board = new ffish.Board(variant, fen)
        const command = `position fen ${board.fen()}`
        console.log('[opening-gen] engine cmd', command)
        const linesByPv = new Map()
        infoHandler = (info) => {
          if (!context.state.openingGeneration || context.state.openingGeneration.sessionId !== localSessionId) return
          if (!info || typeof info !== 'object') return
          const now = Date.now()
          lastInfoAtMs = now
          const curDepth = Number(info.depth || 0)
          if (curDepth > reachedDepth) {
            reachedDepth = curDepth
            lastDepthIncreaseAtMs = now
            depthProgressCount += 1
          }
          if (curDepth > 0) lastDepthValue = curDepth
          if (typeof info.nodes === 'number') lastNodes = info.nodes
          if (typeof info.nps === 'number') lastNps = info.nps
          context.commit('openingGeneration', { currentDepth: curDepth })
          if (!info.pv) return
          const ucimove = String(info.pv).split(/\s/)[0]
          if (!ucimove) return
          const idx = Math.max(1, Number(info.multipv) || 1)
          linesByPv.set(idx, {
            ucimove,
            cp: typeof info.cp === 'number' ? info.cp : null
          })
        }
        bestMoveHandler = (move) => {
          if (!context.state.openingGeneration || context.state.openingGeneration.sessionId !== localSessionId) return
          bestmove = String(move || '')
          bestmoveAtMs = Date.now()
        }
        engine.on('info', infoHandler)
        engine.on('bestmove', bestMoveHandler)
        engine.send(command)
        context.commit('active', true)
        context.commit('setEngineClock')
        console.log('[opening-gen] engine cmd', `go depth ${depth}`)
        engine.send(`go depth ${depth}`)
        const startedAt = Date.now()
        lastInfoAtMs = startedAt
        lastDepthIncreaseAtMs = startedAt
        const hardTimeoutMs = Math.max(12000, depth * 1500)
        const softBestmoveWindowMs = Math.max(2500, depth * 220)
        const depthStallWindowMs = Math.max(2800, depth * 180)
        const infoSilenceWindowMs = Math.max(2200, depth * 150)
        while (Date.now() - startedAt < hardTimeoutMs) {
          if (!context.state.openingGeneration || context.state.openingGeneration.sessionId !== localSessionId) {
            resolveReason = 'stale-session-ignored'
            console.warn('[opening-gen] stale session ignored', { localSessionId, currentSessionId: context.state.openingGeneration && context.state.openingGeneration.sessionId, fen })
            break
          }
          if (context.state.openingGeneration.stopRequested) break
          const elapsedMs = Date.now() - startedAt
          const depthReached = reachedDepth >= depth
          const hasLines = linesByPv.size > 0
          const hasBestmove = Boolean(bestmove)
          const sinceDepthIncreaseMs = lastDepthIncreaseAtMs === null ? elapsedMs : (Date.now() - lastDepthIncreaseAtMs)
          const sinceInfoMs = lastInfoAtMs === null ? elapsedMs : (Date.now() - lastInfoAtMs)
          const bestmoveAgeMs = bestmoveAtMs === null ? null : (Date.now() - bestmoveAtMs)
          const depthStillIncreasing = sinceDepthIncreaseMs < depthStallWindowMs
          const infoStillFlowing = sinceInfoMs < infoSilenceWindowMs
          const nodesGrowing = typeof lastNodes === 'number' && lastNodes > 0
          const searchingActive = depthStillIncreasing || infoStillFlowing || nodesGrowing
          if (depthReached && hasLines) {
            resolveReason = 'requested-depth-reached'
            console.log('[opening-gen] analyze resolve', { resolveReason, fen, requestedDepth: depth, deepestReportedDepth: reachedDepth, bestmove, elapsedMs, lines: linesByPv.size })
            return [...linesByPv.entries()].sort((a, b) => a[0] - b[0]).slice(0, topK).map(([, line], idx) => ({
              uci: line.ucimove,
              score: typeof line.cp === 'number' ? line.cp : (1000 - idx * 30),
              trustedCount: 3,
              depth: reachedDepth || depth
            }))
          }
          if (
            hasBestmove &&
            hasLines &&
            bestmoveAgeMs !== null &&
            bestmoveAgeMs >= softBestmoveWindowMs &&
            !searchingActive
          ) {
            resolveReason = 'bestmove-before-depth-timeboxed-stalled'
            console.warn('[opening-gen] analyze early resolve', {
              resolveReason,
              fen,
              requestedDepth: depth,
              deepestReportedDepth: reachedDepth,
              bestmove,
              elapsedMs,
              lines: linesByPv.size,
              lastDepthProgressAtMs: lastDepthIncreaseAtMs,
              depthDelta: reachedDepth - lastDepthValue,
              sinceDepthIncreaseMs,
              sinceInfoMs,
              nodes: lastNodes,
              nps: lastNps,
              depthStillIncreasing,
              infoStillFlowing,
              searchingActive
            })
            return [...linesByPv.entries()].sort((a, b) => a[0] - b[0]).slice(0, topK).map(([, line], idx) => ({
              uci: line.ucimove,
              score: typeof line.cp === 'number' ? line.cp : (1000 - idx * 30),
              trustedCount: 3,
              depth: reachedDepth || depth
            }))
          }
          if (elapsedMs >= hardTimeoutMs && hasLines) {
            resolveReason = 'analysis-hard-timeout-with-lines'
            console.warn('[opening-gen] analyze timeout resolve', {
              resolveReason,
              fen,
              requestedDepth: depth,
              deepestReportedDepth: reachedDepth,
              bestmove,
              elapsedMs,
              lines: linesByPv.size,
              lastDepthProgressAtMs: lastDepthIncreaseAtMs,
              sinceDepthIncreaseMs,
              sinceInfoMs,
              nodes: lastNodes,
              nps: lastNps,
              depthStillIncreasing,
              infoStillFlowing,
              searchingActive,
              hardTimeoutMs
            })
            return [...linesByPv.entries()].sort((a, b) => a[0] - b[0]).slice(0, topK).map(([, line], idx) => ({
              uci: line.ucimove,
              score: typeof line.cp === 'number' ? line.cp : (1000 - idx * 30),
              trustedCount: 3,
              depth: reachedDepth || depth
            }))
          }
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        resolveReason = context.state.openingGeneration.stopRequested ? 'stop-requested' : 'loop-timeout-no-lines'
      } catch (err) {
        console.warn('[opening-gen] analyze error', { fen, error: err && err.message })
        return []
      } finally {
        if (infoHandler) engine.off('info', infoHandler)
        if (bestMoveHandler) engine.off('bestmove', bestMoveHandler)
        if (context.state.openingGeneration && context.state.openingGeneration.sessionId === localSessionId) {
          context.commit('openingGeneration', { analysisActive: false })
        } else {
          console.warn('[opening-gen] stale session ignored', { localSessionId, currentSessionId: context.state.openingGeneration && context.state.openingGeneration.sessionId, phase: 'cleanup' })
        }
        stopReason = resolveReason === 'requested-depth-reached' ? 'normal-final-stop' : 'forced-cleanup-stop'
        console.log('[opening-gen] analyze cleanup', {
          fen,
          resolveReason,
          stopReason,
          requestedDepth: depth,
          deepestReportedDepth: typeof reachedDepth === 'number' ? reachedDepth : null,
          resolvedBeforeRequestedDepth: reachedDepth < depth,
          bestmove,
          bestmoveAtMs
        })
        await context.dispatch('stopEngine', { source: 'opening-generation' })
      }
      return []
    },
    createOpeningBookSnapshot (context) {
      return {
        format: 'LIGROUND-OPENING-BOOK',
        version: 2,
        exportedAt: new Date().toISOString(),
        config: context.state.openingBook || {},
        graph: normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph()),
        startPool: context.state.openingStartPool || []
      }
    },
    saveOpeningBookSnapshot (context) {
      const snapshot = {
        format: 'LIGROUND-OPENING-BOOK',
        version: 2,
        exportedAt: new Date().toISOString(),
        config: context.state.openingBook || {},
        graph: normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph()),
        startPool: context.state.openingStartPool || []
      }
      localStorage.setItem('openingBookSavedSnapshot', JSON.stringify(snapshot))
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
      return snapshot
    },
    loadOpeningBookSnapshot (context) {
      const raw = localStorage.getItem('openingBookSavedSnapshot') || localStorage.getItem('openingBookAutosave1')
      if (!raw) return false
      return context.dispatch('importOpeningBookSnapshot', { text: raw, mode: 'replace' })
    },
    importOpeningBookSnapshot (context, payload = {}) {
      const text = typeof payload === 'string' ? payload : String(payload.text || '')
      const mode = payload.mode === 'merge' ? 'merge' : 'replace'
      const raw = text.startsWith('LIGROUND-OPENING-BOOK/') ? text.slice(text.indexOf(String.fromCharCode(10)) + 1) : text
      let snapshot
      try {
        snapshot = JSON.parse(raw)
      } catch (err) {
        console.warn('[opening-book] import parse failed', err)
        return false
      }
      const incomingGraph = normalizeOpeningGraph(snapshot.graph || snapshot.openingGraph || snapshot)
      const nextGraph = mode === 'merge'
        ? mergeOpeningGraphs(context.state.openingGraph || createOpeningGraph(), incomingGraph)
        : incomingGraph
      context.commit('openingGraph', nextGraph)
      if (mode === 'replace' && snapshot.config && typeof snapshot.config === 'object') context.commit('openingBook', snapshot.config)
      if (mode === 'replace' && Array.isArray(snapshot.startPool)) context.state.openingStartPool = snapshot.startPool.filter(item => item && (!item.variant || item.variant === context.state.variant))
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
      console.log('[opening-book] imported snapshot', { mode, transitionCount: Object.keys(nextGraph.transitions || {}).length })
      return true
    },
    persistOpeningBook (context) {
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
    },
    loadOpeningBookFromStorage (context) {
      try {
        const graphRaw = localStorage.getItem('openingBookGraph')
        if (graphRaw) context.commit('openingGraph', normalizeOpeningGraph(JSON.parse(graphRaw)))
      } catch (err) {
      // Ignore invalid speculative reply moves from variants with unusual capture rules.
    }
      try {
        const configRaw = localStorage.getItem('openingBookConfig')
        if (configRaw) context.commit('openingBook', JSON.parse(configRaw))
      } catch (err) {
      // Ignore invalid speculative reply moves from variants with unusual capture rules.
    }
      try {
        const poolRaw = localStorage.getItem('openingStartPool')
        if (poolRaw) {
          const pool = JSON.parse(poolRaw)
          context.state.openingStartPool = Array.isArray(pool) ? pool.filter(item => item && item.variant === context.state.variant) : []
        }
      } catch (err) {
      // Ignore invalid speculative reply moves from variants with unusual capture rules.
    }
    },
    clearOpeningBookStorage (context) {
      context.commit('openingGraph', createOpeningGraph())
      context.state.openingStartPool = []
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
    },
    deleteOpeningBookMove (context, payload) {
      const parentFen = String((payload && payload.parentFen) || '').trim()
      const move = String((payload && payload.move) || '').trim()
      if (!parentFen || !move) return false
      const graph = normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph())
      const epd = fenToEpd(parentFen)
      const node = graph.positions[epd]
      if (!node || !node.next || !node.next[move]) return false
      const prevCount = Number(node.next[move] || 0)
      const nextCount = prevCount - 1
      if (nextCount > 0) node.next[move] = nextCount
      else delete node.next[move]
      if (node.weightNext && node.weightNext[move]) {
        if (nextCount > 0) {
          const meta = graph.transitionMeta && graph.transitionMeta[`${epd}|${move}`]
          const qualityWeight = meta && Number.isFinite(Number(meta.qualityWeight)) ? Number(meta.qualityWeight) : 1
          node.weightNext[move] = Math.max(0.0001, nextCount * qualityWeight)
        } else {
          delete node.weightNext[move]
        }
      }
      if (node.trustedNext && node.trustedNext[move]) {
        const v = Number(node.trustedNext[move] || 0) - 1
        if (v > 0) node.trustedNext[move] = v
        else delete node.trustedNext[move]
      }
      if (node.exploratoryNext && node.exploratoryNext[move]) {
        const v = Number(node.exploratoryNext[move] || 0) - 1
        if (v > 0) node.exploratoryNext[move] = v
        else delete node.exploratoryNext[move]
      }
      const key = `${epd}|${move}`
      if (graph.transitions && graph.transitions[key]) {
        const v = Number(graph.transitions[key] || 0) - 1
        if (v > 0) graph.transitions[key] = v
        else delete graph.transitions[key]
      }
      if (graph.transitionMeta && graph.transitionMeta[key]) {
        const meta = graph.transitionMeta[key]
        if ((meta.trusted || 0) > 0) meta.trusted -= 1
        else if ((meta.exploratory || 0) > 0) meta.exploratory -= 1
        if ((meta.trusted || 0) <= 0 && (meta.exploratory || 0) <= 0) delete graph.transitionMeta[key]
      }
      graph.moves = Math.max(0, Number(graph.moves || 0) - 1)
      context.commit('openingGraph', normalizeOpeningGraph(graph))
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
      console.log('[opening-book] move deleted', { parentFen, move, affectedNodeCount: prevCount })
      return true
    },
    cleanupOpeningBookByMinDepth (context, payload) {
      const minDepth = Math.max(1, Number(payload && payload.minDepth) || 12)
      const cfg = context.state.openingBook || {}
      const useQualityFilter = Boolean(payload && payload.useQualityFilter !== undefined ? payload.useQualityFilter : cfg.cleanupUseQualityFilter)
      const baseCpDelta = Math.max(0, Number((payload && payload.cpDelta) || cfg.cleanupCpDelta) || 120)
      const graph = normalizeOpeningGraph(context.state.openingGraph || createOpeningGraph())
      let removedTransitions = 0
      let removedForDepth = 0
      let removedForQuality = 0
      let removedBuckets = 0
      let preservedManual = 0
      const removeTransition = (key, reason) => {
        delete graph.transitionMeta[key]
        delete graph.transitions[key]
        removedTransitions += 1
        if (reason === 'quality') removedForQuality += 1
        else removedForDepth += 1
        const splitAt = key.lastIndexOf('|')
        if (splitAt > 0) {
          const epd = key.slice(0, splitAt)
          const move = key.slice(splitAt + 1)
          const node = graph.positions[epd]
          if (node) {
            if (node.next) delete node.next[move]
            if (node.trustedNext) delete node.trustedNext[move]
            if (node.exploratoryNext) delete node.exploratoryNext[move]
            if (node.weightNext) delete node.weightNext[move]
          }
        }
      }
      for (const key of Object.keys(graph.transitionMeta || {})) {
        const meta = graph.transitionMeta[key] || {}
        const isManual = (meta.manualBoost || 0) > 0
        if (isManual) preservedManual += 1
        const splitAt = key.lastIndexOf('|')
        const epd = splitAt > 0 ? key.slice(0, splitAt) : ''
        const move = splitAt > 0 ? key.slice(splitAt + 1) : ''
        const node = graph.positions[epd]
        const buckets = meta.depthBuckets && typeof meta.depthBuckets === 'object' ? meta.depthBuckets : null
        if (buckets && Object.keys(buckets).length) {
          for (const depthKey of Object.keys(buckets)) {
            const depth = Number(depthKey)
            if (!Number.isFinite(depth) || depth >= minDepth) continue
            const bucket = buckets[depthKey] || {}
            const bucketCount = Math.max(0, Number(bucket.count || 0))
            const trustedRemove = Math.max(0, Number(bucket.trusted || 0))
            const exploratoryRemove = Math.max(0, Number(bucket.exploratory || 0))
            delete buckets[depthKey]
            removedBuckets += 1
            removedForDepth += bucketCount
            if (graph.transitions && graph.transitions[key]) graph.transitions[key] = Math.max(0, Number(graph.transitions[key] || 0) - bucketCount)
            if (node && node.next && node.next[move]) node.next[move] = Math.max(0, Number(node.next[move] || 0) - bucketCount)
            if (node && node.trustedNext && node.trustedNext[move]) node.trustedNext[move] = Math.max(0, Number(node.trustedNext[move] || 0) - trustedRemove)
            if (node && node.exploratoryNext && node.exploratoryNext[move]) node.exploratoryNext[move] = Math.max(0, Number(node.exploratoryNext[move] || 0) - exploratoryRemove)
            meta.trusted = Math.max(0, Number(meta.trusted || 0) - trustedRemove)
            meta.exploratory = Math.max(0, Number(meta.exploratory || 0) - exploratoryRemove)
          }
          if (node && node.next && node.next[move] <= 0) delete node.next[move]
          if (node && node.trustedNext && node.trustedNext[move] <= 0) delete node.trustedNext[move]
          if (node && node.exploratoryNext && node.exploratoryNext[move] <= 0) delete node.exploratoryNext[move]
          if (graph.transitions && graph.transitions[key] <= 0) delete graph.transitions[key]
          if (Object.keys(buckets).length || isManual) {
            refreshTransitionMeta(meta)
            graph.transitionMeta[key] = meta
            if (node && node.next && node.next[move]) node.weightNext[move] = Math.max(0.0001, Number(node.next[move] || 0) * (meta.qualityWeight || 1))
          } else {
            removeTransition(key, 'depth')
          }
          continue
        }
        const depth = Number(meta.avgDepth || meta.lastDepth || 0)
        if (!isManual && depth > 0 && depth < minDepth) removeTransition(key, 'depth')
      }
      const bestByEpd = {}
      if (useQualityFilter) {
        for (const key of Object.keys(graph.transitionMeta || {})) {
          const meta = graph.transitionMeta[key] || {}
          const splitAt = key.lastIndexOf('|')
          if (splitAt <= 0) continue
          const epd = key.slice(0, splitAt)
          const cp = Number.isFinite(Number(meta.effectiveCp)) ? Number(meta.effectiveCp) : (Number.isFinite(Number(meta.avgCp)) ? Number(meta.avgCp) : null)
          if (cp === null) continue
          bestByEpd[epd] = bestByEpd[epd] === undefined ? cp : Math.max(bestByEpd[epd], cp)
        }
        for (const key of Object.keys(graph.transitionMeta || {})) {
          const meta = graph.transitionMeta[key] || {}
          if ((meta.manualBoost || 0) > 0) continue
          const splitAt = key.lastIndexOf('|')
          const epd = splitAt > 0 ? key.slice(0, splitAt) : ''
          const bestCp = bestByEpd[epd]
          const cp = Number.isFinite(Number(meta.effectiveCp)) ? Number(meta.effectiveCp) : (Number.isFinite(Number(meta.avgCp)) ? Number(meta.avgCp) : null)
          const depth = Number(meta.avgDepth || meta.lastDepth || 0)
          if (typeof bestCp === 'number' && cp !== null) {
            const depthTolerance = depth > 20 ? -20 : (depth > 0 && depth < 12 ? 40 : 0)
            const confidenceTolerance = (meta.confidence || 0) < 0.45 ? 25 : 0
            const allowedDelta = Math.max(20, baseCpDelta + depthTolerance + confidenceTolerance)
            if ((bestCp - cp) > allowedDelta) removeTransition(key, 'quality')
          }
        }
      }
      let removedNodes = 0
      for (const epd of Object.keys(graph.positions || {})) {
        const node = graph.positions[epd]
        if (!node || !node.next || Object.keys(node.next).length > 0) continue
        delete graph.positions[epd]
        removedNodes += 1
      }
      graph.moves = Object.values(graph.transitions || {}).reduce((sum, v) => sum + Math.max(0, Number(v) || 0), 0)
      context.commit('openingGraph', normalizeOpeningGraph(graph))
      context.dispatch('scheduleOpeningBookPersist', { immediate: true })
      console.log('[opening-book] depth cleanup', { thresholdDepth: minDepth, useQualityFilter, baseCpDelta, removedTransitionCount: removedTransitions, removedBuckets, removedForDepth, removedForQuality, removedNodeCount: removedNodes, preservedManualEntriesCount: preservedManual })
      return { removedTransitions, removedNodes, preservedManual, minDepth, removedForDepth, removedForQuality, removedBuckets }
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
    async loadGameSequence (context, payload) {
      const variant = payload && payload.variant ? payload.variant : context.state.variant
      const startFen = payload && payload.startFen ? payload.startFen : ''
      const moves = Array.isArray(payload && payload.moves) ? payload.moves : []
      await context.dispatch('variant', variant)
      if (startFen) {
        context.commit('newBoard', { fen: startFen, is960: false })
      } else {
        context.commit('newBoard')
      }
      await context.dispatch('fen', context.state.startFen)
      let prev
      for (const move of moves) {
        context.commit('appendMoves', { move, prev })
        prev = context.state.moves[context.state.moves.length - 1]
      }
      context.dispatch('updateBoard')
      context.dispatch('position')
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
    setMistakePreventionSettings (context, payload) {
      context.commit('mistakePreventionSettings', payload)
    },
    clearMistakeNotebook (context) {
      context.commit('clearMistakeNotebook')
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
    currentMainlineUci (state) {
      const current = state.moves.find(m => m.fen === state.fen)
      const anchor = current || state.moves[state.moves.length - 1]
      return buildMainlineFromMove(anchor).map(move => move.uci)
    },
    openingCandidates (state) {
      if (!state.openingBook || !state.openingBook.enabled) return []
      const recommendationCount = Math.max(1, Math.min(8, Number(state.openingBook.recommendationCount) || 3))
      return openingCandidatesForFen(state.openingGraph, state.fen, Math.max(6, recommendationCount), { policy: state.openingBook.moveSelectionPolicy || 'practical' })
    },
    openingBook (state) {
      return state.openingBook
    },
    openingStartPool (state) {
      return (state.openingStartPool || []).filter(item => item && item.variant === state.variant)
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
    humanTrapDiagnostics (state) {
      return state.humanTrapDiagnostics
    },
    mistakePrevention (state) { return state.mistakePrevention },
    mistakePreventionLevels () { return MISTAKE_PREVENTION_LEVELS },
    mistakeNotebook (state) { return state.mistakeNotebook || [] },
    mistakeStatistics (state) { return mistakeStatsFromNotebook(state.mistakeNotebook || []) },
    mistakePreventionPending (state) { return !!state.mistakePreventionPending },
    personalityDiagnostics (state) {
      return state.humanTrapDiagnostics
    },
    enginePersonalityDebug (state) {
      return state.enginePersonalityDebug || {}
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
      return typeof state.lastAnalysisResult.cp === 'number' ? state.lastAnalysisResult.cp : 0
    },
    wdl (state) {
      return state.lastAnalysisResult.wdl
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
      return state.lastAnalysisResult.pv || (state.multipv[0] && state.multipv[0].pv) || ''
    },
    cpForWhite (state) {
      return typeof state.lastAnalysisResult.cp === 'number' ? state.lastAnalysisResult.cp : 0
    },
    cpForWhiteStr (state, getters) {
      const currentMove = getters.currentMove[0]
      const mate = typeof state.lastAnalysisResult.mate === 'number' ? state.lastAnalysisResult.mate : null

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
      const mate = typeof state.lastAnalysisResult.mate === 'number' ? state.lastAnalysisResult.mate : null
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
      const effectiveTurn = typeof state.lastAnalysisResult.turn === 'boolean' ? state.lastAnalysisResult.turn : state.turn
      const mate = typeof state.lastAnalysisResult.mate === 'number' ? state.lastAnalysisResult.mate : null
      if (typeof mate === 'number') {
        // Bar visualization uses fixed board-side perspective (Cho positive),
        // normalized from transient side-to-move engine outputs.
        return (calcForSide(Math.sign(mate), effectiveTurn) + 1) / 2
      } else if (currentMove && currentMove.name.includes('#')) {
        return state.turn ? 0 : 1
      }
      const rootCpRaw = typeof state.lastAnalysisResult.cp === 'number' ? state.lastAnalysisResult.cp : 0
      const stableCp = calcForSide(rootCpRaw, effectiveTurn)
      return 1 / (1 + Math.exp(-0.003 * stableCp))
    },
    wdlForWhiteWin (state) {
      const wdl = normalizeWdl(state.lastAnalysisResult)
      if (wdl) {
        const win = state.turn ? wdl.win : wdl.loss
        state.lastWdlWin = win
        return win
      }
      return state.lastWdlWin
    },
    wdlForWhiteDraw (state) {
      const wdl = normalizeWdl(state.lastAnalysisResult)
      if (wdl) {
        state.lastWdlDraw = wdl.draw
        return wdl.draw
      }
      return state.lastWdlDraw
    },
    wdlForWhiteLoss (state) {
      const wdl = normalizeWdl(state.lastAnalysisResult)
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
