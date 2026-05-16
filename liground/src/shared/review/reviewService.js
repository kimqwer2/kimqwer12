import { REVIEW_BRUSHES, REVIEW_MODES, REVIEW_OVERLAY_KINDS, REVIEW_SCHEMA_VERSION, REVIEW_SERVICE_VERSION } from './schema'
import { splitUciMove } from './janggiCoordinates'

function scoreToText (score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return null
  if (Math.abs(score) >= 10000) return score > 0 ? 'winning attack' : 'serious defensive danger'
  if (score > 120) return 'comfortable position'
  if (score > 40) return 'slightly preferable position'
  if (score < -120) return 'difficult position'
  if (score < -40) return 'slightly uncomfortable position'
  return 'balanced position'
}

function normalizePvLine (line) {
  if (!line || typeof line !== 'object') return null
  return {
    move: line.ucimove || (typeof line.pvUCI === 'string' ? line.pvUCI.split(/\s+/)[0] : ''),
    cp: typeof line.cp === 'number' ? line.cp : null,
    mate: typeof line.mate === 'number' ? line.mate : null,
    pvUCI: line.pvUCI || '',
    pv: line.pv || ''
  }
}

function classifyMove ({ reviewedMove, bestLine, candidateLine }) {
  if (!reviewedMove) return 'no_move'
  if (bestLine && bestLine.move === reviewedMove) return 'engine_supported_idea'
  if (candidateLine && bestLine && typeof bestLine.cp === 'number' && typeof candidateLine.cp === 'number') {
    const loss = bestLine.cp - candidateLine.cp
    if (loss >= 180) return 'high_risk'
    if (loss >= 80) return 'risky_practical_try'
    if (loss >= 30) return 'playable_alternative'
  }
  if (bestLine && bestLine.move && bestLine.move !== reviewedMove) return 'needs_tactical_check'
  return 'idea_review'
}

function makeOverlay (overlay) {
  return {
    id: overlay.id,
    kind: overlay.kind || REVIEW_OVERLAY_KINDS.ARROW,
    orig: overlay.orig,
    dest: overlay.dest,
    square: overlay.square,
    brush: overlay.brush || REVIEW_BRUSHES.NEUTRAL,
    label: overlay.label,
    modifiers: overlay.modifiers || {},
    explanationId: overlay.explanationId || null,
    priority: overlay.priority || 0,
    source: 'review'
  }
}

function buildOverlays ({ reviewedMove, bestLine, classification }) {
  const overlays = []
  const reviewed = splitUciMove(reviewedMove)
  if (reviewed) {
    overlays.push(makeOverlay({
      id: 'reviewed-move-direction',
      kind: REVIEW_OVERLAY_KINDS.ARROW,
      orig: reviewed.orig,
      dest: reviewed.dest,
      brush: classification === 'high_risk' ? REVIEW_BRUSHES.DANGER : REVIEW_BRUSHES.ATTACK,
      label: 'idea',
      modifiers: { lineWidth: 5, opacity: 0.85 },
      explanationId: 'intent',
      priority: 40
    }))
    overlays.push(makeOverlay({
      id: 'reviewed-destination',
      kind: classification === 'high_risk' ? REVIEW_OVERLAY_KINDS.DANGER : REVIEW_OVERLAY_KINDS.HIGHLIGHT,
      square: reviewed.dest,
      brush: classification === 'high_risk' ? REVIEW_BRUSHES.DANGER : REVIEW_BRUSHES.ATTACK,
      label: classification === 'high_risk' ? '!' : null,
      modifiers: { opacity: 0.55 },
      explanationId: classification === 'high_risk' ? 'risk' : 'intent',
      priority: 30
    }))
  }

  if (bestLine && bestLine.move && bestLine.move !== reviewedMove) {
    const best = splitUciMove(bestLine.move)
    if (best) {
      overlays.push(makeOverlay({
        id: 'engine-punishment-candidate',
        kind: REVIEW_OVERLAY_KINDS.ARROW,
        orig: best.orig,
        dest: best.dest,
        brush: REVIEW_BRUSHES.DANGER,
        label: '!',
        modifiers: { lineWidth: 7, opacity: 0.9 },
        explanationId: 'risk',
        priority: 80
      }))
    }
  }

  return overlays
}

function buildSummary ({ reviewedMove, moveSan, bestLine, classification, candidateLine }) {
  const displayMove = moveSan || reviewedMove || 'this move'
  const bestMove = bestLine && bestLine.move
  const candidateText = candidateLine ? scoreToText(candidateLine.cp) : null

  if (classification === 'engine_supported_idea') {
    return `${displayMove} is strongly supported by the current engine line. The move appears to combine practical purpose with concrete tactical reliability.`
  }
  if (classification === 'high_risk') {
    return `${displayMove} may have a human attacking idea, but it appears tactically dangerous. The main concern is the immediate counterplay shown by the red warning arrow.`
  }
  if (classification === 'risky_practical_try') {
    return `${displayMove} is a risky practical try: it creates direction and activity, but the position may become easier for the opponent if they find the pointed response.`
  }
  if (classification === 'playable_alternative') {
    return `${displayMove} looks like a playable human alternative. It may not be the engine's first choice, but it can still express a coherent plan.`
  }
  if (bestMove && bestMove !== reviewedMove) {
    return `${displayMove} deserves a tactical check. A strong reply or alternative candidate is highlighted, so the human idea should be weighed against the concrete danger.`
  }
  if (candidateText) {
    return `${displayMove} leads toward a ${candidateText}. The review layer needs deeper feature analysis before making a stronger strategic claim.`
  }
  return `${displayMove} is ready for human-style review. The current phase establishes the review pipeline and visual overlays; deeper feature and intent analysis will be layered on next.`
}

function buildIdeas ({ reviewedMove, classification }) {
  if (!reviewedMove) return []
  return [
    {
      id: 'intent',
      type: 'candidate_intent',
      confidence: classification === 'engine_supported_idea' ? 0.72 : 0.48,
      text: 'The move is treated as a human candidate idea: the first pass looks at its direction, destination, and available engine evidence without reducing it to a raw score.'
    }
  ]
}

function buildRisks ({ bestLine, reviewedMove, classification }) {
  if (!bestLine || !bestLine.move || bestLine.move === reviewedMove) return []
  return [
    {
      id: 'risk',
      type: 'tactical_counterplay',
      severity: classification === 'high_risk' ? 'high' : 'medium',
      confidence: classification === 'high_risk' ? 0.74 : 0.58,
      move: bestLine.move,
      text: 'The red arrow marks the most concrete available engine-backed reply or competing candidate. This is the first place to check before trusting the human plan.'
    }
  ]
}

export function buildReviewCacheKey (request) {
  const line = Array.isArray(request.line) ? request.line.join(' ') : ''
  const multipv = Array.isArray(request.multipv)
    ? request.multipv.slice(0, 5).map(entry => [entry && entry.ucimove, entry && entry.cp, entry && entry.mate, entry && entry.depth].join(':')).join(',')
    : ''
  return [REVIEW_SERVICE_VERSION, request.variant, request.fen, request.move, line, request.engineName, multipv].join('|')
}

/**
 * Deterministic phase-1/phase-2 review service entry point.
 *
 * The service intentionally returns structured JSON instead of UI-specific text.
 * Future feature extraction and natural-language layers should append to this
 * contract without changing Fairy-Stockfish or the normal MultiPV state.
 */
export function analyzeReviewRequest (request) {
  const multipv = Array.isArray(request.multipv) ? request.multipv.map(normalizePvLine).filter(Boolean) : []
  const reviewedMove = request.move || (Array.isArray(request.line) ? request.line[0] : '')
  const bestLine = multipv[0] || null
  const candidateLine = multipv.find(line => line.move === reviewedMove) || null
  const classification = classifyMove({ reviewedMove, bestLine, candidateLine })
  const overlays = buildOverlays({ reviewedMove, bestLine, classification })

  return {
    id: request.id,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    serviceVersion: REVIEW_SERVICE_VERSION,
    mode: request.mode || REVIEW_MODES.MOVE,
    variant: request.variant,
    fen: request.fen,
    reviewedMove,
    reviewedLine: Array.isArray(request.line) ? request.line : (reviewedMove ? [reviewedMove] : []),
    classification,
    summary: buildSummary({ reviewedMove, moveSan: request.moveSan, bestLine, classification, candidateLine }),
    engineEvidence: {
      engineName: request.engineName || '',
      bestMove: bestLine ? bestLine.move : '',
      bestCp: bestLine ? bestLine.cp : null,
      candidateCp: candidateLine ? candidateLine.cp : null,
      candidateFoundInMultiPv: Boolean(candidateLine),
      bestPv: bestLine ? bestLine.pvUCI : ''
    },
    ideas: buildIdeas({ reviewedMove, classification }),
    risks: buildRisks({ bestLine, reviewedMove, classification }),
    alternatives: bestLine && bestLine.move && bestLine.move !== reviewedMove
      ? [{ id: 'engine-main-candidate', move: bestLine.move, text: 'Compare the human idea with this concrete candidate before deciding.' }]
      : [],
    overlays,
    generatedAt: Date.now()
  }
}
