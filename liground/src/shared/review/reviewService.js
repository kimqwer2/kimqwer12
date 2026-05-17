import { REVIEW_BRUSHES, REVIEW_MARKER_MODES, REVIEW_MODES, REVIEW_OVERLAY_KINDS, REVIEW_SCHEMA_VERSION, REVIEW_SERVICE_VERSION } from './schema'
import { splitUciMove } from './janggiCoordinates'

function scoreToText (score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return null
  if (Math.abs(score) >= 10000) return score > 0 ? '공격이 크게 성공한 형세' : '수비가 크게 위험한 형세'
  if (score > 120) return '편안한 형세'
  if (score > 40) return '약간 편한 형세'
  if (score < -120) return '어려운 형세'
  if (score < -40) return '조금 불편한 형세'
  return '균형 잡힌 형세'
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
    features.push(makeFeature('attack_side_concentration', `이 수는 ${side === 'right side' ? '우측' : '좌측'}으로 힘을 모읍니다. 측면 공격이나 압박을 쌓으려는 의도가 보입니다.`, 0.58, { side, move, idx }))
  }
  if (dest.file >= 3 && dest.file <= 5) {
    features.push(makeFeature('central_pressure', '착점이 중앙 파일과 연결되어 중앙 압박 또는 궁성 진입 의도가 강합니다.', 0.62, { move, idx }))
  }
  if (inPalace(dest)) {
    features.push(makeFeature('palace_pressure', '궁성 구조를 직접 건드리는 수입니다. 단순한 기물 이동보다 왕 안전 문제가 커집니다.', 0.70, { square: dest.square, move, idx }))
  }
  if ((sameFile || sameRank) && distance >= 3) {
    features.push(makeFeature('opened_attack_line', '긴 직선 이동은 차/포 계열의 라인 압박, 길 열기, 직접적인 응징 루트를 의미할 수 있습니다.', 0.64, { move, idx }))
  }
  if (sameFile && dest.file >= 3 && dest.file <= 5 && distance >= 2) {
    features.push(makeFeature('exposed_king_lane', '중앙 파일이 열리면 상대가 같은 선으로 반격할 때 왕 노출이 생길 수 있습니다.', 0.54, { move, idx }))
  }
  if (distance >= 4) {
    features.push(makeFeature('piece_activation', '기물을 활성화하는 수입니다. 수비에 머물던 기물이 공격 또는 반격 역할로 전환됩니다.', 0.56, { move, idx }))
  }
  if (Math.abs(dy) >= 3 && Math.abs(dx) <= 1) {
    features.push(makeFeature('overextension_check', '공간을 빠르게 얻는 대신, 전술이 맞지 않으면 지원이 끊긴 과확장이 될 수 있습니다.', 0.46, { move, idx }))
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
      features.push(makeFeature('sequence_plan_direction', `이 수순은 반복해서 ${dominantSide === 'right side' ? '우측' : dominantSide === 'left side' ? '좌측' : '중앙'}을 향합니다. 개별 수가 아니라 하나의 계획으로 볼 수 있습니다.`, 0.66, { side: dominantSide }))
    }
  }
  return features
}

function summarizeIntentFromFeatures (features) {
  const has = type => features.some(feature => feature.type === type)
  if (has('palace_pressure') || has('exposed_king_lane')) return { type: 'central_pressure_plan', label: '중앙 압박', text: '핵심 의도는 중앙 또는 궁성 압박으로 보입니다. 상대가 정비하기 전에 왕 주변에 위협을 만들려는 계획입니다.', confidence: 0.72 }
  const sideFeature = features.find(feature => feature.type === 'attack_side_concentration')
  if (sideFeature) return { type: sideFeature.side === 'right side' ? 'right_side_attack_attempt' : 'left_side_attack_attempt', label: sideFeature.side === 'right side' ? '우측 공격' : '좌측 공격', text: `${sideFeature.side === 'right side' ? '우측' : '좌측'} 공격 의도가 보입니다. 한쪽 날개에 활동성을 모아 상대 수비를 시험하는 수순입니다.`, confidence: 0.65 }
  if (has('opened_attack_line')) return { type: 'line_opening_plan', label: '라인 개방', text: '차나 포가 압박할 수 있는 길을 열거나 점유하려는 의도가 보입니다.', confidence: 0.61 }
  if (has('piece_activation')) return { type: 'piece_activation', label: '기물 활성화', text: '즉각적인 전술보다 기물 활동성과 선택지를 늘리는 활성화 수로 이해할 수 있습니다.', confidence: 0.57 }
  return { type: 'candidate_intent', label: '아이디어 검토', text: '엔진 수치보다 먼저 방향, 착점, 실전적 의미를 기준으로 후보 아이디어를 검토합니다.', confidence: 0.48 }
}


function normalizeEngineCandidate (candidate, idx = 0) {
  if (!candidate) return null
  const move = candidate.ucimove || candidate.move || candidate.bestmove || ''
  return {
    rank: idx + 1,
    move,
    cp: typeof candidate.cp === 'number' ? candidate.cp : null,
    mate: typeof candidate.mate === 'number' ? candidate.mate : null,
    pvUCI: candidate.pvUCI || candidate.pv || '',
    depth: candidate.depth || null,
    meaning: engineMoveMeaning(move, idx)
  }
}

function engineMoveMeaning (move, idx) {
  const features = extractMoveFeatures(move, idx)
  const intent = summarizeIntentFromFeatures(features)
  return intent.label || intent.text
}

function engineCandidatesFromAnalysis (engineAnalysis) {
  const rootCandidates = engineAnalysis && engineAnalysis.root && Array.isArray(engineAnalysis.root.candidates)
    ? engineAnalysis.root.candidates.map(normalizeEngineCandidate).filter(Boolean)
    : []
  return rootCandidates
}

function userCandidateFromAnalysis (engineAnalysis) {
  const candidate = engineAnalysis && engineAnalysis.user && Array.isArray(engineAnalysis.user.candidates) ? engineAnalysis.user.candidates[0] : null
  return normalizeEngineCandidate(candidate, 0)
}

function punishmentFromAnalysis (engineAnalysis) {
  const candidate = engineAnalysis && engineAnalysis.after && Array.isArray(engineAnalysis.after.candidates) ? engineAnalysis.after.candidates[0] : null
  return normalizeEngineCandidate(candidate, 0)
}

function classifyMove ({ reviewedMove, bestLine, candidateLine, features, evalLoss }) {
  if (!reviewedMove) return 'no_move'
  if (bestLine && bestLine.move === reviewedMove) return 'engine_supported_idea'
  if (typeof evalLoss === 'number' && evalLoss >= 160) return 'high_risk'
  if (features && features.some(feature => feature.type === 'overextension_check' || feature.type === 'exposed_king_lane')) return 'practical_but_risky'
  if (candidateLine && bestLine && typeof bestLine.cp === 'number' && typeof candidateLine.cp === 'number') {
    const loss = bestLine.cp - candidateLine.cp
    if (loss >= 160) return 'high_risk'
    if (loss >= 70) return 'risky_practical_try'
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

function buildOverlays ({ reviewedMove, reviewedLine, bestLine, punishmentLine, classification, features }) {
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

  const warningLine = punishmentLine && punishmentLine.move ? punishmentLine : bestLine
  if (warningLine && warningLine.move && warningLine.move !== reviewedMove) {
    const best = splitUciMove(warningLine.move)
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


function markerModeLabel (mode) {
  const labels = {
    [REVIEW_MARKER_MODES.FIRST_MOVE_ONLY]: '첫 수만 보기',
    [REVIEW_MARKER_MODES.MY_MOVES_ONLY]: '내 수만 보기',
    [REVIEW_MARKER_MODES.OPPONENT_MOVES_ONLY]: '상대 수만 보기',
    [REVIEW_MARKER_MODES.BOTH_SIDES]: '양쪽 모두 보기'
  }
  return labels[mode] || labels[REVIEW_MARKER_MODES.MY_MOVES_ONLY]
}

function shouldDisplayMoveForMarkerMode (ply, markerMode) {
  if (markerMode === REVIEW_MARKER_MODES.FIRST_MOVE_ONLY) return ply === 1
  if (markerMode === REVIEW_MARKER_MODES.OPPONENT_MOVES_ONLY) return ply % 2 === 0
  if (markerMode === REVIEW_MARKER_MODES.BOTH_SIDES) return true
  return ply % 2 === 1
}

function practicalSignalsFromFeatures (features) {
  const has = type => features.some(feature => feature.type === type)
  return {
    attackChances: has('attack_side_concentration') || has('palace_pressure') || has('opened_attack_line'),
    complexityIncrease: has('overextension_check') || has('opened_attack_line') || has('palace_pressure'),
    initiative: has('central_pressure') || has('piece_activation') || has('attack_side_concentration'),
    defensiveConcern: has('exposed_king_lane') || has('overextension_check'),
    tacticalSharpness: has('palace_pressure') || has('opened_attack_line') || has('exposed_king_lane')
  }
}

function practicalLabel (signals) {
  if (signals.attackChances && signals.initiative) return '공격 기회'
  if (signals.complexityIncrease) return '복잡성 증가'
  if (signals.initiative) return '주도권 유지'
  if (signals.defensiveConcern) return '수비 확인'
  return '안정성'
}

function classifyHumanMove ({ move, bestLine, candidateLine, features, evalLoss }) {
  if (!move) return { key: 'no_move', label: '수 없음', severity: 'neutral', tone: 'neutral' }
  const signals = practicalSignalsFromFeatures(features || [])
  const bestMove = bestLine && bestLine.move
  const moveIsBest = Boolean(bestMove && bestMove === move)
  const loss = typeof evalLoss === 'number' ? evalLoss : null

  if (moveIsBest && (loss === null || loss <= 20)) return { key: 'excellent', label: '훌륭한 수', severity: 'excellent', tone: 'positive' }
  if (loss !== null && loss >= 320) return { key: 'blunder', label: '큰 실수', severity: 'blunder', tone: 'critical' }
  if (loss !== null && loss >= 180) return { key: 'mistake', label: '큰 손해가 나는 수', severity: 'mistake', tone: 'critical' }
  if (loss !== null && loss >= 120) {
    const label = signals.attackChances || signals.complexityIncrease ? '반격 의도는 있지만 위험한 수' : '위험한 수'
    return { key: 'inaccuracy', label, severity: 'inaccuracy', tone: 'caution' }
  }
  if (loss !== null && loss >= 70) {
    if (signals.attackChances || signals.complexityIncrease) return { key: 'interesting_risk', label: '반격 여지가 있는 시도', severity: 'caution', tone: 'caution' }
    return { key: 'needs_care', label: '응수 확인 후보', severity: 'caution', tone: 'caution' }
  }
  if (loss !== null && loss >= 35) {
    if (signals.attackChances) return { key: 'attacking_try', label: '공격적인 시도', severity: 'practical', tone: 'practical' }
    if (signals.complexityIncrease) return { key: 'complexity', label: '복잡성을 높이는 수', severity: 'practical', tone: 'practical' }
    return { key: 'practical', label: '실전적인 수', severity: 'practical', tone: 'practical' }
  }
  if (loss !== null && loss >= 30) return { key: signals.attackChances ? 'attacking_try' : 'practical', label: signals.attackChances ? '공격적인 시도' : '실전적인 수', severity: 'good', tone: 'positive' }
  if (bestMove && bestMove !== move && !candidateLine && loss === null) return { key: 'natural', label: '자연스러운 수', severity: 'natural', tone: 'positive' }
  if (signals.initiative || signals.attackChances) return { key: 'good', label: '좋은 수', severity: 'good', tone: 'positive' }
  return { key: 'natural', label: '자연스러운 수', severity: 'natural', tone: 'positive' }
}

function summaryForMoveReview ({ ply, sideLabel, move, classification, intent, evalLoss, practical }) {
  const lossText = typeof evalLoss === 'number' && evalLoss >= 180
    ? ' 평가상 손해가 크게 잡힙니다.'
    : (typeof evalLoss === 'number' && evalLoss >= 120
      ? ' 평가상 손해가 뚜렷합니다.'
      : (typeof evalLoss === 'number' && evalLoss >= 70 ? ' 평가상 손해가 보입니다.' : ''))
  const practicalText = practical ? ` ${practicalLabel(practical)} 관점의 의도는 함께 확인할 수 있습니다.` : ''
  if (classification.tone === 'critical') return `${ply}수 ${sideLabel} ${move}: ${classification.label}입니다.${lossText}${practicalText} 표시된 상대 응수와 목표 지점을 먼저 확인해 보세요.`
  if (classification.tone === 'caution') return `${ply}수 ${sideLabel} ${move}: ${classification.label}입니다.${lossText}${practicalText} 실전적으로 둘 수 있어도 응수와 수비 균형을 한 번 확인하면 좋습니다.`
  if (classification.tone === 'practical') return `${ply}수 ${sideLabel} ${move}: ${classification.label}입니다. 가장 엄격한 추천이 아니어도 사람 입장에서는 압박과 선택지를 만드는 수입니다.${practicalText}`
  return `${ply}수 ${sideLabel} ${move}: ${classification.label}입니다. ${intent.text}`
}

function risksForMove ({ features, classification, punishmentLine, move, evalLoss }) {
  const risks = []
  const serious = ['inaccuracy', 'mistake', 'blunder', 'needs_care', 'interesting_risk'].includes(classification.key)
  for (const feature of (features || []).filter(feature => ['overextension_check', 'exposed_king_lane'].includes(feature.type)).slice(0, 1)) {
    risks.push({ id: `${feature.id}-move`, type: feature.type, severity: feature.type === 'exposed_king_lane' && serious ? 'high' : 'medium', confidence: feature.confidence, text: feature.text })
  }
  if (serious && punishmentLine && punishmentLine.move && punishmentLine.move !== move) {
    risks.push({
      id: `punishment-${move}`,
      type: 'tactical_counterplay',
      severity: classification.key === 'blunder' || classification.key === 'mistake' ? 'high' : 'medium',
      confidence: typeof evalLoss === 'number' && evalLoss >= 180 ? 0.76 : 0.58,
      move: punishmentLine.move,
      text: `${punishmentLine.move} 응수가 후보로 보입니다. 이 수가 실제로 가능한지 먼저 확인하면 판단이 훨씬 명확해집니다.`
    })
  }
  return risks
}

function overlaysForReviewedMove ({ move, ply, classification, features, punishmentLine }) {
  const overlays = []
  const split = splitUciMove(move)
  const brush = classification.tone === 'critical' ? REVIEW_BRUSHES.DANGER : (classification.tone === 'practical' ? REVIEW_BRUSHES.ATTACK : REVIEW_BRUSHES.SUPPORT)
  if (split) {
    overlays.push(makeOverlay({
      id: `move-marker-${ply}`,
      kind: REVIEW_OVERLAY_KINDS.ARROW,
      orig: split.orig,
      dest: split.dest,
      brush,
      label: String(ply),
      modifiers: { lineWidth: classification.tone === 'critical' ? 6 : 4 },
      explanationId: `move-${ply}`,
      priority: 50 - ply
    }))
  }
  const hotspot = (features || []).find(feature => feature.square)
  if (hotspot) {
    overlays.push(makeOverlay({
      id: `move-hotspot-${ply}`,
      kind: hotspot.type.includes('exposed') ? REVIEW_OVERLAY_KINDS.DANGER : REVIEW_OVERLAY_KINDS.HIGHLIGHT,
      square: hotspot.square,
      brush: hotspot.type.includes('exposed') ? REVIEW_BRUSHES.DANGER : REVIEW_BRUSHES.ATTACK,
      label: hotspot.type.includes('exposed') ? '!' : '•',
      modifiers: { lineWidth: 3 },
      explanationId: hotspot.id,
      priority: 45 - ply
    }))
  }
  if (classification.tone === 'critical' && punishmentLine && punishmentLine.move && punishmentLine.move !== move) {
    const punish = splitUciMove(punishmentLine.move)
    if (punish) {
      overlays.push(makeOverlay({
        id: `move-punishment-${ply}`,
        kind: REVIEW_OVERLAY_KINDS.ARROW,
        orig: punish.orig,
        dest: punish.dest,
        brush: REVIEW_BRUSHES.DANGER,
        label: '!',
        modifiers: { lineWidth: 7 },
        explanationId: `risk-${ply}`,
        priority: 80 - ply
      }))
    }
  }
  return overlays
}

function perMoveAnalysisFromEngine (engineAnalysis, idx) {
  return engineAnalysis && Array.isArray(engineAnalysis.moves) ? engineAnalysis.moves[idx] : null
}

function buildMoveReviews ({ reviewedLine, markerMode, engineAnalysis, fallbackMultipv }) {
  const allMoves = []
  const markerMoves = []
  for (const [idx, move] of (reviewedLine || []).entries()) {
    const ply = idx + 1
    const side = ply % 2 === 1 ? 'user' : 'opponent'
    const sideLabel = side === 'user' ? '내 수' : '상대 수'
    const moveEngine = perMoveAnalysisFromEngine(engineAnalysis, idx)
    const rootCandidates = moveEngine && moveEngine.root && Array.isArray(moveEngine.root.candidates)
      ? moveEngine.root.candidates.map(normalizeEngineCandidate).filter(Boolean)
      : (idx === 0 ? fallbackMultipv : [])
    const userCandidate = moveEngine && moveEngine.user && Array.isArray(moveEngine.user.candidates) ? normalizeEngineCandidate(moveEngine.user.candidates[0], 0) : null
    const afterCandidate = moveEngine && moveEngine.after && Array.isArray(moveEngine.after.candidates) ? normalizeEngineCandidate(moveEngine.after.candidates[0], 0) : null
    const bestLine = rootCandidates[0] || null
    const candidateLine = rootCandidates.find(line => line.move === move) || userCandidate
    const evalLoss = bestLine && candidateLine && typeof bestLine.cp === 'number' && typeof candidateLine.cp === 'number' ? Math.max(0, bestLine.cp - candidateLine.cp) : null
    const features = extractMoveFeatures(move, idx)
    const intent = summarizeIntentFromFeatures(features)
    const practical = practicalSignalsFromFeatures(features)
    const classification = classifyHumanMove({ move, bestLine, candidateLine, features, evalLoss })
    const risks = risksForMove({ features, classification, punishmentLine: afterCandidate, move, evalLoss })
    const moveReview = {
      ply,
      side,
      sideLabel,
      move,
      classification: classification.key,
      classificationLabel: classification.label,
      severity: classification.severity,
      tone: classification.tone,
      evalBefore: bestLine ? bestLine.cp : null,
      evalAfter: candidateLine ? candidateLine.cp : null,
      loss: evalLoss,
      bestMove: bestLine ? bestLine.move : '',
      bestPv: bestLine ? bestLine.pvUCI : '',
      punishmentMove: afterCandidate ? afterCandidate.move : '',
      previewLine: reviewedLine.slice(0, ply),
      intent: buildIdeas({ intent, features }).slice(0, 3),
      risks,
      practical,
      summary: summaryForMoveReview({ ply, sideLabel, move, classification, intent, evalLoss, practical }),
      overlays: overlaysForReviewedMove({ move, ply, classification, features, punishmentLine: afterCandidate }),
      confidence: typeof evalLoss === 'number' ? Math.max(0.48, Math.min(0.92, 0.84 - Math.min(evalLoss, 260) / 1000)) : 0.56
    }
    allMoves.push(moveReview)
    if (shouldDisplayMoveForMarkerMode(ply, markerMode)) markerMoves.push(moveReview)
  }
  return { allMoves, markerMoves }
}

function overallFromMoveReviews (markerMoves, fallbackClassification) {
  if (!markerMoves.length) return { classification: fallbackClassification, label: '리뷰', summaryMove: null }
  const order = ['blunder', 'mistake', 'inaccuracy', 'needs_care', 'interesting_risk', 'attacking_try', 'complexity', 'practical', 'natural', 'good', 'excellent']
  const sorted = markerMoves.slice().sort((a, b) => order.indexOf(a.classification) - order.indexOf(b.classification))
  const critical = sorted.find(move => ['blunder', 'mistake', 'inaccuracy', 'needs_care'].includes(move.classification))
  const positive = markerMoves.find(move => ['excellent', 'good', 'natural', 'practical', 'attacking_try'].includes(move.classification))
  const summaryMove = critical || positive || markerMoves[0]
  return { classification: summaryMove.classification, label: summaryMove.classificationLabel, summaryMove }
}

function buildSummary ({ reviewedMove, moveSan, reviewedLine, bestLine, classification, candidateLine, intent, features, evalLoss, punishmentLine, markerMode, markerMoves, overallMove }) {
  const displayMove = moveSan || reviewedMove || '이 수'
  const bestMove = bestLine && bestLine.move
  const candidateText = candidateLine ? scoreToText(candidateLine.cp) : null
  const featureText = features && features[0] ? features[0].text : intent.text
  const sequencePrefix = reviewedLine && reviewedLine.length > 1 ? `이 ${reviewedLine.length}수 임시 수순은` : `${displayMove}는`
  if (markerMoves && markerMoves.length) {
    const modeText = markerModeLabel(markerMode)
    const headline = overallMove ? `${overallMove.ply}수 ${overallMove.sideLabel} ${overallMove.move}는 ${overallMove.classificationLabel}입니다.` : ''
    const practicalCount = markerMoves.filter(move => ['excellent', 'good', 'natural', 'practical', 'attacking_try', 'complexity'].includes(move.classification)).length
    const cautionCount = markerMoves.length - practicalCount
    return `${sequencePrefix} ${modeText} 기준으로 ${markerMoves.length}개의 수를 나누어 보았습니다. ${headline} 무난하거나 실전적인 수는 ${practicalCount}개, 추가 확인이 필요한 수는 ${cautionCount}개입니다. 평가는 엔진 수치보다 실제 계획과 대응 난이도를 함께 반영했습니다.`
  }
  const evalHint = typeof evalLoss === 'number' ? `엔진 비교상 약 ${Math.round(evalLoss)}cp의 차이가 있어 전술 확인이 필요합니다.` : ''
  const punishmentHint = punishmentLine && punishmentLine.move ? `특히 ${punishmentLine.move} 응수가 실제 반격 후보로 잡힙니다.` : ''

  if (classification === 'engine_supported_idea') {
    return `${sequencePrefix} 전략적으로도 자연스럽고 엔진도 지지하는 아이디어입니다. ${intent.text}`
  }
  if (classification === 'high_risk') {
    return `${sequencePrefix} 의도는 분명하지만 구체적인 확인이 필요합니다. ${featureText} ${punishmentHint || evalHint} 표시된 반격 후보를 먼저 확인해 보세요.`
  }
  if (classification === 'practical_but_risky' || classification === 'risky_practical_try') {
    return `${sequencePrefix} 실전적인 찬스를 만드는 시도입니다. ${intent.text} 다만 같은 방향성이 상대의 반격 경로나 과확장을 허용할 수 있습니다. ${punishmentHint}`
  }
  if (classification === 'playable_alternative') {
    return `${sequencePrefix} 엔진 1순위는 아니어도 사람이 이해할 수 있는 계획을 가진 대안입니다. ${intent.text}`
  }
  if (bestMove && bestMove !== reviewedMove) {
    return `${sequencePrefix} 조금 더 확인하면 좋은 후보입니다. ${featureText} 추천수와 비교해 계획이 실제로 성립하는지 확인해야 합니다.`
  }
  if (candidateText) {
    return `${sequencePrefix} ${candidateText}로 이어집니다. 하지만 핵심은 수치보다 계획입니다. ${intent.text}`
  }
  return `${sequencePrefix} 단순한 엔진 숫자가 아니라 아이디어로 검토할 수 있습니다. ${intent.text}`
}

function buildIdeas ({ intent, features }) {
  const ideas = [{ id: 'intent', ...intent, text: intent.text }]
  for (const feature of features.slice(0, 3)) {
    ideas.push({ id: feature.id, type: feature.type, confidence: feature.confidence, text: feature.text })
  }
  return ideas
}

function buildRisks ({ bestLine, punishmentLine, reviewedMove, classification, features }) {
  const risks = []
  for (const feature of features.filter(feature => ['overextension_check', 'exposed_king_lane'].includes(feature.type)).slice(0, 2)) {
    risks.push({ id: feature.id, type: feature.type, severity: feature.type === 'exposed_king_lane' ? 'high' : 'medium', confidence: feature.confidence, text: feature.text })
  }
  const warningLine = punishmentLine && punishmentLine.move ? punishmentLine : bestLine
  if (warningLine && warningLine.move && warningLine.move !== reviewedMove) {
    risks.push({
      id: 'risk',
      type: 'tactical_counterplay',
      severity: classification === 'high_risk' ? 'high' : 'medium',
      confidence: classification === 'high_risk' ? 0.78 : 0.62,
      move: warningLine.move,
      text: `엔진이 확인한 구체적인 반격 후보입니다: ${warningLine.move}. 이 응수를 막지 못하면 아이디어보다 전술 손실이 먼저 발생할 수 있습니다.`
    })
  }
  return risks
}


function featureLabel (type) {
  const labels = {
    attack_side_concentration: '측면 압박',
    central_pressure: '중앙 압박',
    palace_pressure: '궁성 압박',
    opened_attack_line: '공격 라인',
    exposed_king_lane: '왕 노출',
    piece_activation: '기물 활성화',
    overextension_check: '과확장 주의',
    sequence_plan_direction: '수순 방향성'
  }
  return labels[type] || '핵심 장면'
}

function buildKeyMoments (line, features) {
  if (!Array.isArray(line) || line.length <= 1) return []
  return line.map((move, idx) => {
    const moveFeatures = features.filter(feature => feature.idx === idx)
    return {
      ply: idx + 1,
      move,
      label: moveFeatures[0] ? featureLabel(moveFeatures[0].type) : '수순 진행',
      text: moveFeatures[0] ? moveFeatures[0].text : '이 수는 임시 수순의 흐름을 이어 가는 장면입니다. 전후 맥락에서 의미를 확인해야 합니다.'
    }
  })
}

export function buildReviewCacheKey (request) {
  const line = Array.isArray(request.line) ? request.line.join(' ') : ''
  const multipv = Array.isArray(request.multipv)
    ? request.multipv.slice(0, 5).map(entry => [entry && entry.ucimove, entry && entry.cp, entry && entry.mate, entry && entry.depth].join(':')).join(',')
    : ''
  const engineRoot = request.engineAnalysis && request.engineAnalysis.root && Array.isArray(request.engineAnalysis.root.candidates)
    ? request.engineAnalysis.root.candidates.slice(0, 3).map(entry => [entry && entry.ucimove, entry && entry.cp, entry && entry.mate, entry && entry.depth].join(':')).join(',')
    : ''
  const engineMoves = request.engineAnalysis && Array.isArray(request.engineAnalysis.moves)
    ? request.engineAnalysis.moves.slice(0, 12).map(entry => entry && entry.user && entry.user.candidates && entry.user.candidates[0] ? [entry.user.candidates[0].ucimove, entry.user.candidates[0].cp, entry.user.candidates[0].mate, entry.user.candidates[0].depth].join(':') : '').join(',')
    : ''
  return [REVIEW_SERVICE_VERSION, request.variant, request.fen, request.move, line, request.markerMode, request.engineName, multipv, engineRoot, engineMoves].join('|')
}

/**
 * Deterministic review service entry point.
 *
 * The service intentionally returns structured JSON instead of UI-specific text.
 * Feature and intent fields are deterministic first-pass coaching signals; deeper
 * engine-backed tactical confirmation can be layered on without touching the engine.
 */
export function analyzeReviewRequest (request) {
  const engineAnalysis = request.engineAnalysis || null
  const engineRecommendations = engineCandidatesFromAnalysis(engineAnalysis)
  const multipv = engineRecommendations.length > 0 ? engineRecommendations : (Array.isArray(request.multipv) ? request.multipv.map(normalizePvLine).filter(Boolean) : [])
  const reviewedMove = request.move || (Array.isArray(request.line) ? request.line[0] : '')
  const reviewedLine = Array.isArray(request.line) ? request.line : (reviewedMove ? [reviewedMove] : [])
  const features = extractLineFeatures(reviewedLine)
  const intent = summarizeIntentFromFeatures(features)
  const bestLine = multipv[0] || null
  const candidateLine = multipv.find(line => line.move === reviewedMove) || userCandidateFromAnalysis(engineAnalysis)
  const punishmentLine = punishmentFromAnalysis(engineAnalysis)
  const evalLoss = bestLine && candidateLine && typeof bestLine.cp === 'number' && typeof candidateLine.cp === 'number' ? Math.max(0, bestLine.cp - candidateLine.cp) : null
  const legacyClassification = classifyMove({ reviewedMove, bestLine, candidateLine, features, evalLoss })
  const markerMode = request.markerMode || (request.context && request.context.markerMode) || REVIEW_MARKER_MODES.MY_MOVES_ONLY
  const { allMoves, markerMoves } = buildMoveReviews({ reviewedLine, markerMode, engineAnalysis, fallbackMultipv: multipv })
  const overall = overallFromMoveReviews(markerMoves, legacyClassification)
  const classification = overall.classification
  const overlays = markerMoves.length > 0
    ? markerMoves.slice(0, 6).flatMap(move => move.overlays || [])
    : buildOverlays({ reviewedMove, reviewedLine, bestLine, punishmentLine, classification: legacyClassification, features })
  const risks = markerMoves.length > 0
    ? markerMoves.flatMap(move => move.risks || []).slice(0, 4)
    : buildRisks({ bestLine, punishmentLine, reviewedMove, classification: legacyClassification, features })

  return {
    id: request.id,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    serviceVersion: REVIEW_SERVICE_VERSION,
    mode: request.mode || REVIEW_MODES.MOVE,
    markerMode,
    markerModeLabel: markerModeLabel(markerMode),
    requestContext: request.context || {},
    variant: request.variant,
    fen: request.fen,
    reviewedMove,
    reviewedLine,
    classification,
    classificationLabel: overall.label,
    summary: buildSummary({ reviewedMove, moveSan: request.moveSan, reviewedLine, bestLine, classification: legacyClassification, candidateLine, intent, features, evalLoss, punishmentLine, markerMode, markerMoves, overallMove: overall.summaryMove }),
    engineEvidence: {
      engineName: request.engineName || '',
      bestMove: bestLine ? bestLine.move : '',
      bestCp: bestLine ? bestLine.cp : null,
      candidateCp: candidateLine ? candidateLine.cp : null,
      candidateFoundInMultiPv: Boolean(candidateLine),
      evalLoss,
      bestPv: bestLine ? bestLine.pvUCI : '',
      punishmentMove: punishmentLine ? punishmentLine.move : '',
      perMoveCount: allMoves.length,
      engineError: engineAnalysis && engineAnalysis.error ? engineAnalysis.error : null
    },
    features,
    engineRecommendations,
    ideas: buildIdeas({ intent, features }),
    risks,
    moves: allMoves,
    markerMoves,
    keyMoments: buildKeyMoments(reviewedLine, features),
    alternatives: bestLine && bestLine.move && bestLine.move !== reviewedMove
      ? [{ id: 'engine-main-candidate', move: bestLine.move, text: '이 구체적인 추천수와 사람의 아이디어를 비교해 보세요.' }]
      : [],
    overlays,
    generatedAt: Date.now()
  }
}
