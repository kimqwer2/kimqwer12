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

function parseSquare (square) {
  const match = typeof square === 'string' && square.match(/^([a-i])(\d{1,2})$/)
  if (!match) return null
  return { file: match[1].charCodeAt(0) - 97, rank: Number(match[2]), square }
}

function sideName (file) {
  if (file <= 2) return 'left side'
  if (file >= 6) return 'right side'
  return 'center'
}

function inPalace (sq) {
  if (!sq) return false
  return sq.file >= 3 && sq.file <= 5 && ((sq.rank >= 0 && sq.rank <= 2) || (sq.rank >= 7 && sq.rank <= 9))
}

function makeFeature (type, text, confidence, data = {}) {
  return { id: `${type}-${Math.round(confidence * 100)}-${Object.keys(data).length}`, type, text, confidence, ...data }
}

function extractMoveFeatures (move, idx = 0) {
  const split = splitUciMove(move)
  if (!split) return []
  const orig = parseSquare(split.orig)
  const dest = parseSquare(split.dest)
  if (!orig || !dest) return []

  const features = []
  const dx = dest.file - orig.file
  const dy = dest.rank - orig.rank
  const distance = Math.abs(dx) + Math.abs(dy)
  const sameFile = orig.file === dest.file
  const sameRank = orig.rank === dest.rank
  const side = sideName(dest.file)

  if (side !== 'center') {
    features.push(makeFeature('attack_side_concentration', `The move shifts attention toward the ${side}, which often signals a flank attack or pressure-building plan.`, 0.58, { side, move, idx }))
  }
  if (dest.file >= 3 && dest.file <= 5) {
    features.push(makeFeature('central_pressure', 'The destination points into the central files, so the idea is likely connected to central pressure or palace access.', 0.62, { move, idx }))
  }
  if (inPalace(dest)) {
    features.push(makeFeature('palace_pressure', 'The move enters or targets palace geometry, creating king-safety questions rather than just material questions.', 0.70, { square: dest.square, move, idx }))
  }
  if ((sameFile || sameRank) && distance >= 3) {
    features.push(makeFeature('opened_attack_line', 'The long straight move suggests line pressure: rook/cannon style activity, file opening, or a direct route for punishment.', 0.64, { move, idx }))
  }
  if (sameFile && dest.file >= 3 && dest.file <= 5 && distance >= 2) {
    features.push(makeFeature('exposed_king_lane', 'A central-file move can create an exposed king lane if the opponent can answer along the same file.', 0.54, { move, idx }))
  }
  if (distance >= 4) {
    features.push(makeFeature('piece_activation', 'This is an activating move: it changes the piece from local defense into a more active attacking or counterattacking role.', 0.56, { move, idx }))
  }
  if (Math.abs(dy) >= 3 && Math.abs(dx) <= 1) {
    features.push(makeFeature('overextension_check', 'The move gains space quickly, but fast forward movement can leave support behind if the tactic does not work.', 0.46, { move, idx }))
  }

  return features
}

function extractLineFeatures (line) {
  const features = []
  for (const [idx, move] of (Array.isArray(line) ? line : []).entries()) {
    features.push(...extractMoveFeatures(move, idx))
  }
  if (line && line.length >= 3) {
    const sides = line.map(move => splitUciMove(move)).filter(Boolean).map(split => parseSquare(split.dest)).filter(Boolean).map(sq => sideName(sq.file))
    const dominantSide = ['left side', 'right side', 'center'].find(side => sides.filter(s => s === side).length >= Math.ceil(line.length / 2))
    if (dominantSide) {
      features.push(makeFeature('sequence_plan_direction', `Across the sequence, the play repeatedly points toward the ${dominantSide}. That gives the line a recognizable plan rather than isolated moves.`, 0.66, { side: dominantSide }))
    }
  }
  return features
}

function summarizeIntentFromFeatures (features) {
  const has = type => features.some(feature => feature.type === type)
  if (has('palace_pressure') || has('exposed_king_lane')) return { type: 'central_pressure_plan', text: 'The main human idea looks like central or palace pressure: create threats near the king before the opponent fully coordinates.', confidence: 0.72 }
  const sideFeature = features.find(feature => feature.type === 'attack_side_concentration')
  if (sideFeature) return { type: sideFeature.side === 'right side' ? 'right_side_attack_attempt' : 'left_side_attack_attempt', text: `The move sequence looks like a ${sideFeature.side} attack attempt: build activity on one wing and ask the opponent to prove the defense.`, confidence: 0.65 }
  if (has('opened_attack_line')) return { type: 'line_opening_plan', text: 'The human idea appears to be opening or occupying a line so heavier pieces can create direct pressure.', confidence: 0.61 }
  if (has('piece_activation')) return { type: 'piece_activation', text: 'The move is best understood as piece activation: improving activity and practical options rather than chasing an immediate tactic.', confidence: 0.57 }
  return { type: 'candidate_intent', text: 'The move is treated as a human candidate idea: the first pass looks at direction, destination, and practical consequences before engine numbers.', confidence: 0.48 }
}

function classifyMove ({ reviewedMove, bestLine, candidateLine, features }) {
  if (!reviewedMove) return 'no_move'
  if (bestLine && bestLine.move === reviewedMove) return 'engine_supported_idea'
  if (features && features.some(feature => feature.type === 'overextension_check' || feature.type === 'exposed_king_lane')) return 'practical_but_risky'
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

function buildLineOverlays (line) {
  const circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
  return (Array.isArray(line) ? line : []).map((move, idx) => {
    const split = splitUciMove(move)
    if (!split) return null
    return makeOverlay({
      id: `reviewed-line-${idx}`,
      kind: REVIEW_OVERLAY_KINDS.ARROW,
      orig: split.orig,
      dest: split.dest,
      brush: idx % 2 === 0 ? REVIEW_BRUSHES.ATTACK : REVIEW_BRUSHES.IDEA,
      label: circled[idx] || String(idx + 1),
      modifiers: { lineWidth: Math.max(2, 5 - idx * 0.3), opacity: Math.max(0.35, 0.8 - idx * 0.05) },
      explanationId: 'sequence-path',
      priority: 25
    })
  }).filter(Boolean)
}

function buildFeatureOverlays (features) {
  return features.filter(feature => feature.square).slice(0, 4).map((feature, idx) => makeOverlay({
    id: `feature-marker-${feature.type}-${idx}`,
    kind: feature.type.includes('exposed') ? REVIEW_OVERLAY_KINDS.DANGER : REVIEW_OVERLAY_KINDS.HIGHLIGHT,
    square: feature.square,
    brush: feature.type.includes('exposed') ? REVIEW_BRUSHES.DANGER : REVIEW_BRUSHES.ATTACK,
    label: feature.type === 'palace_pressure' ? 'palace' : '!',
    modifiers: { opacity: 0.5 },
    explanationId: feature.id,
    priority: 45
  }))
}

function buildOverlays ({ reviewedMove, reviewedLine, bestLine, classification, features }) {
  const overlays = []
  overlays.push(...buildLineOverlays(reviewedLine && reviewedLine.length ? reviewedLine : [reviewedMove]))
  overlays.push(...buildFeatureOverlays(features || []))

  const reviewed = splitUciMove(reviewedMove)
  if (reviewed) {
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

function buildSummary ({ reviewedMove, moveSan, reviewedLine, bestLine, classification, candidateLine, intent, features }) {
  const displayMove = moveSan || reviewedMove || 'this move'
  const bestMove = bestLine && bestLine.move
  const candidateText = candidateLine ? scoreToText(candidateLine.cp) : null
  const featureText = features && features[0] ? features[0].text : intent.text
  const sequencePrefix = reviewedLine && reviewedLine.length > 1 ? `This ${reviewedLine.length}-move sequence` : displayMove

  if (classification === 'engine_supported_idea') {
    return `${sequencePrefix} is strategically coherent: ${intent.text} It is also tactically supported by the current engine line.`
  }
  if (classification === 'high_risk') {
    return `${sequencePrefix} has a recognizable human idea, but the practical danger is high. ${featureText} The red warning arrow shows where concrete punishment must be checked first.`
  }
  if (classification === 'practical_but_risky' || classification === 'risky_practical_try') {
    return `${sequencePrefix} creates practical chances through ${intent.text.toLowerCase()} The concern is that the same plan may leave a counter-route or overextended piece for the opponent.`
  }
  if (classification === 'playable_alternative') {
    return `${sequencePrefix} looks like a playable human alternative. ${intent.text} It may not be the engine's first choice, but it carries a plan a human can understand.`
  }
  if (bestMove && bestMove !== reviewedMove) {
    return `${sequencePrefix} deserves a tactical check. ${featureText} A concrete reply or competing candidate is highlighted, so the plan should be tested before trusting it.`
  }
  if (candidateText) {
    return `${sequencePrefix} leads toward a ${candidateText}, but the more important review point is strategic: ${intent.text}`
  }
  return `${sequencePrefix} shows a candidate idea rather than just a number. ${intent.text} Future deeper search will add sharper tactical confirmation.`
}

function buildIdeas ({ intent, features }) {
  const ideas = [{ id: 'intent', ...intent }]
  for (const feature of features.slice(0, 3)) {
    ideas.push({ id: feature.id, type: feature.type, confidence: feature.confidence, text: feature.text })
  }
  return ideas
}

function buildRisks ({ bestLine, reviewedMove, classification, features }) {
  const risks = []
  for (const feature of features.filter(feature => ['overextension_check', 'exposed_king_lane'].includes(feature.type)).slice(0, 2)) {
    risks.push({ id: feature.id, type: feature.type, severity: feature.type === 'exposed_king_lane' ? 'high' : 'medium', confidence: feature.confidence, text: feature.text })
  }
  if (bestLine && bestLine.move && bestLine.move !== reviewedMove) {
    risks.push({
      id: 'risk',
      type: 'tactical_counterplay',
      severity: classification === 'high_risk' ? 'high' : 'medium',
      confidence: classification === 'high_risk' ? 0.74 : 0.58,
      move: bestLine.move,
      text: 'The red arrow marks the most concrete available engine-backed reply or competing candidate. This is the first place to check before trusting the human plan.'
    })
  }
  return risks
}

function buildKeyMoments (line, features) {
  if (!Array.isArray(line) || line.length <= 1) return []
  return line.map((move, idx) => {
    const moveFeatures = features.filter(feature => feature.idx === idx)
    return {
      ply: idx + 1,
      move,
      label: moveFeatures[0] ? moveFeatures[0].type.replace(/_/g, ' ') : 'sequence move',
      text: moveFeatures[0] ? moveFeatures[0].text : 'This move keeps the temporary sequence moving and should be checked in context.'
    }
  })
}

export function buildReviewCacheKey (request) {
  const line = Array.isArray(request.line) ? request.line.join(' ') : ''
  const multipv = Array.isArray(request.multipv)
    ? request.multipv.slice(0, 5).map(entry => [entry && entry.ucimove, entry && entry.cp, entry && entry.mate, entry && entry.depth].join(':')).join(',')
    : ''
  return [REVIEW_SERVICE_VERSION, request.variant, request.fen, request.move, line, request.engineName, multipv].join('|')
}

/**
 * Deterministic review service entry point.
 *
 * The service intentionally returns structured JSON instead of UI-specific text.
 * Feature and intent fields are deterministic first-pass coaching signals; deeper
 * engine-backed tactical confirmation can be layered on without touching the engine.
 */
export function analyzeReviewRequest (request) {
  const multipv = Array.isArray(request.multipv) ? request.multipv.map(normalizePvLine).filter(Boolean) : []
  const reviewedMove = request.move || (Array.isArray(request.line) ? request.line[0] : '')
  const reviewedLine = Array.isArray(request.line) ? request.line : (reviewedMove ? [reviewedMove] : [])
  const features = extractLineFeatures(reviewedLine)
  const intent = summarizeIntentFromFeatures(features)
  const bestLine = multipv[0] || null
  const candidateLine = multipv.find(line => line.move === reviewedMove) || null
  const classification = classifyMove({ reviewedMove, bestLine, candidateLine, features })
  const overlays = buildOverlays({ reviewedMove, reviewedLine, bestLine, classification, features })

  return {
    id: request.id,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    serviceVersion: REVIEW_SERVICE_VERSION,
    mode: request.mode || REVIEW_MODES.MOVE,
    variant: request.variant,
    fen: request.fen,
    reviewedMove,
    reviewedLine,
    classification,
    summary: buildSummary({ reviewedMove, moveSan: request.moveSan, reviewedLine, bestLine, classification, candidateLine, intent, features }),
    engineEvidence: {
      engineName: request.engineName || '',
      bestMove: bestLine ? bestLine.move : '',
      bestCp: bestLine ? bestLine.cp : null,
      candidateCp: candidateLine ? candidateLine.cp : null,
      candidateFoundInMultiPv: Boolean(candidateLine),
      evalLoss: bestLine && candidateLine && typeof bestLine.cp === 'number' && typeof candidateLine.cp === 'number' ? Math.max(0, bestLine.cp - candidateLine.cp) : null,
      bestPv: bestLine ? bestLine.pvUCI : ''
    },
    features,
    ideas: buildIdeas({ intent, features }),
    risks: buildRisks({ bestLine, reviewedMove, classification, features }),
    keyMoments: buildKeyMoments(reviewedLine, features),
    alternatives: bestLine && bestLine.move && bestLine.move !== reviewedMove
      ? [{ id: 'engine-main-candidate', move: bestLine.move, text: 'Compare the human idea with this concrete candidate before deciding.' }]
      : [],
    overlays,
    generatedAt: Date.now()
  }
}
