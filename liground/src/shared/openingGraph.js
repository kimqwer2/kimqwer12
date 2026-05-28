import { fenToEpd } from './openingLookup'

function defaultNode () {
  return { visits: 0, next: {}, trustedNext: {}, exploratoryNext: {}, weightNext: {} }
}

function clamp (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function finiteNumber (value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function defaultTransitionMeta () {
  return {
    trusted: 0,
    exploratory: 0,
    avgDepth: 0,
    lastDepth: 0,
    avgCp: 0,
    lastCp: 0,
    manualBoost: 0,
    qualityWeight: 1,
    cpSamples: 0,
    cpWeightSum: 0,
    cpWeightedSum: 0,
    cpWeightedSqSum: 0,
    depthBuckets: {},
    effectiveCp: 0,
    cpStdDev: 0,
    confidence: 0
  }
}


function normalizeDepthBucketKey (depth) {
  const rounded = Math.round(Number(depth) || 0)
  return rounded > 0 ? String(rounded) : ''
}

function bucketValues (meta) {
  return meta && meta.depthBuckets && typeof meta.depthBuckets === 'object'
    ? Object.entries(meta.depthBuckets).map(([depthKey, bucket]) => ({ depthKey, depth: Number(depthKey), bucket: bucket || {} })).filter(item => Number.isFinite(item.depth) && item.depth > 0)
    : []
}

function addDepthBucketSample (meta, depth, cp, source) {
  const depthKey = normalizeDepthBucketKey(depth)
  if (!depthKey || typeof cp !== 'number') return
  if (!meta.depthBuckets || typeof meta.depthBuckets !== 'object') meta.depthBuckets = {}
  const bucket = meta.depthBuckets[depthKey] || { count: 0, trusted: 0, exploratory: 0, cpWeightSum: 0, cpWeightedSum: 0, cpWeightedSqSum: 0, avgCp: 0 }
  const sampleWeight = depthSampleWeight(Number(depthKey))
  bucket.count = Math.max(0, finiteNumber(bucket.count)) + 1
  if (source === 'exploration') bucket.exploratory = Math.max(0, finiteNumber(bucket.exploratory)) + 1
  else bucket.trusted = Math.max(0, finiteNumber(bucket.trusted)) + 1
  bucket.cpWeightSum = Math.max(0, finiteNumber(bucket.cpWeightSum)) + sampleWeight
  bucket.cpWeightedSum = finiteNumber(bucket.cpWeightedSum) + (cp * sampleWeight)
  bucket.cpWeightedSqSum = Math.max(0, finiteNumber(bucket.cpWeightedSqSum)) + (cp * cp * sampleWeight)
  bucket.avgCp = bucket.cpWeightSum > 0 ? bucket.cpWeightedSum / bucket.cpWeightSum : cp
  meta.depthBuckets[depthKey] = bucket
}

function rebuildMetaFromDepthBuckets (meta) {
  const buckets = bucketValues(meta)
  if (!buckets.length) return false
  let sampleCount = 0
  let depthSum = 0
  let cpWeightSum = 0
  let cpWeightedSum = 0
  let cpWeightedSqSum = 0
  let lastDepth = 0
  buckets.forEach(({ depth, bucket }) => {
    const count = Math.max(0, finiteNumber(bucket.count))
    const weightSum = Math.max(0, finiteNumber(bucket.cpWeightSum))
    sampleCount += count
    depthSum += depth * count
    cpWeightSum += weightSum
    cpWeightedSum += finiteNumber(bucket.cpWeightedSum)
    cpWeightedSqSum += Math.max(0, finiteNumber(bucket.cpWeightedSqSum))
    lastDepth = Math.max(lastDepth, depth)
  })
  if (sampleCount <= 0 || cpWeightSum <= 0) return false
  meta.cpSamples = sampleCount
  meta.cpWeightSum = cpWeightSum
  meta.cpWeightedSum = cpWeightedSum
  meta.cpWeightedSqSum = cpWeightedSqSum
  meta.avgDepth = depthSum / sampleCount
  meta.lastDepth = lastDepth
  meta.avgCp = cpWeightedSum / cpWeightSum
  meta.lastCp = meta.avgCp
  return true
}

function depthSampleWeight (depth) {
  if (!Number.isFinite(depth) || depth <= 0) return 1
  // Depth should increase trust, but only gently: one very deep outlier must not
  // overwhelm a stable group of repeated shallower evaluations.
  return clamp(1 + (Math.sqrt(depth) / 5), 1, 2.25)
}

export function refreshTransitionMeta (meta) {
  if (!meta || typeof meta !== 'object') return defaultTransitionMeta()
  rebuildMetaFromDepthBuckets(meta)
  const trusted = Math.max(0, finiteNumber(meta.trusted))
  const exploratory = Math.max(0, finiteNumber(meta.exploratory))
  const total = trusted + exploratory
  const avgDepth = Math.max(0, finiteNumber(meta.avgDepth || meta.lastDepth))
  const manualBoost = Math.max(0, finiteNumber(meta.manualBoost))
  const cpSamples = Math.max(0, finiteNumber(meta.cpSamples))
  const cpWeightSum = Math.max(0, finiteNumber(meta.cpWeightSum))
  const cpWeightedSum = finiteNumber(meta.cpWeightedSum)
  const cpWeightedSqSum = Math.max(0, finiteNumber(meta.cpWeightedSqSum))
  const legacyCp = Number.isFinite(Number(meta.avgCp)) ? Number(meta.avgCp) : null
  let effectiveCp = cpWeightSum > 0 ? cpWeightedSum / cpWeightSum : legacyCp
  if (!Number.isFinite(effectiveCp)) effectiveCp = null
  const variance = cpWeightSum > 0 && effectiveCp !== null
    ? Math.max(0, (cpWeightedSqSum / cpWeightSum) - (effectiveCp * effectiveCp))
    : 0
  const cpStdDev = Math.sqrt(variance)
  const depthTrust = avgDepth > 0 ? clamp(avgDepth / 20, 0.25, 1.15) : 0.45
  const repeatBasis = cpSamples > 0 ? cpSamples : total
  const repeatTrust = repeatBasis > 0 ? clamp(Math.sqrt(repeatBasis / 6), 0.2, 1.1) : 0.2
  const stabilityTrust = cpSamples > 1 ? clamp(1 - (cpStdDev / 180), 0.35, 1.05) : 0.72
  const confidence = clamp(depthTrust * repeatTrust * stabilityTrust, 0.05, 1.2)
  const cpForQuality = effectiveCp !== null ? effectiveCp : legacyCp
  const depthWeight = avgDepth > 0 ? Math.min(1.25, 1 + (avgDepth / 100)) : 1
  const cpPenalty = typeof cpForQuality === 'number' && cpForQuality < -150 ? 0.7 : 1
  const cpBonus = typeof cpForQuality === 'number' && cpForQuality > 50 ? 1.06 : 1
  const manualWeight = 1 + Math.min(0.3, manualBoost)
  // Confidence only nudges quality around the existing depth/cp/manual heuristic.
  // That keeps old books usable while making volatile, single-sample lines less dominant.
  const confidenceWeight = 0.85 + (confidence * 0.25)
  meta.trusted = trusted
  meta.exploratory = exploratory
  meta.avgDepth = avgDepth
  meta.lastDepth = Math.max(0, finiteNumber(meta.lastDepth))
  if (legacyCp !== null) meta.avgCp = legacyCp
  if (Number.isFinite(Number(meta.lastCp))) meta.lastCp = Number(meta.lastCp)
  meta.manualBoost = manualBoost
  meta.cpSamples = cpSamples
  meta.cpWeightSum = cpWeightSum
  meta.cpWeightedSum = cpWeightedSum
  meta.cpWeightedSqSum = cpWeightedSqSum
  if (!meta.depthBuckets || typeof meta.depthBuckets !== 'object') meta.depthBuckets = {}
  meta.effectiveCp = effectiveCp
  meta.cpStdDev = cpStdDev
  meta.confidence = confidence
  meta.qualityWeight = depthWeight * cpPenalty * cpBonus * manualWeight * confidenceWeight
  return meta
}


function candidateSampleCount (candidate) {
  const meta = candidate && candidate.meta ? candidate.meta : {}
  const samples = Math.max(0, finiteNumber(meta.cpSamples))
  return samples > 0 ? samples : Math.max(0, finiteNumber(candidate && candidate.count))
}

function candidateEffectiveCp (candidate) {
  const meta = candidate && candidate.meta ? candidate.meta : {}
  const cp = Number(meta.effectiveCp)
  return Number.isFinite(cp) ? cp : null
}

function explorationProfile (candidate, bestEffectiveCp, options = {}) {
  const meta = candidate && candidate.meta ? candidate.meta : {}
  const effectiveCp = candidateEffectiveCp(candidate)
  const maxCpDelta = Math.max(10, Number(options.maxCpDelta) || 60)
  const strength = clamp(Number(options.strength) || 1, 0, 1.5)
  const maxBonus = Math.max(0, Number(options.maxBonus) || 0.65)
  const confidenceTarget = Math.max(0.2, Number(options.confidenceTarget) || 0.7)
  const confidence = clamp(finiteNumber(meta.confidence, 0.35), 0.05, 1.2)
  const samples = candidateSampleCount(candidate)
  const visits = Math.max(0, finiteNumber(candidate && candidate.count))
  const cpStdDev = Math.max(0, finiteNumber(meta.cpStdDev))
  const cpDelta = effectiveCp !== null && typeof bestEffectiveCp === 'number' ? Math.max(0, bestEffectiveCp - effectiveCp) : 0

  // Exploration is deliberately best-relative: only moves that remain close to
  // the current engine/book leader receive a bonus. Clearly bad outliers keep
  // their normal practical score, preventing tree explosion into junk moves.
  const closeEnough = effectiveCp === null || typeof bestEffectiveCp !== 'number' || cpDelta <= maxCpDelta
  if (!closeEnough || strength <= 0) {
    return {
      factor: 1,
      bonus: 0,
      samples,
      confidence,
      cpDelta,
      reason: closeEnough ? 'exploration-disabled' : 'outside-cp-window'
    }
  }

  const closeness = typeof bestEffectiveCp === 'number' && effectiveCp !== null
    ? clamp(1 - (cpDelta / maxCpDelta), 0, 1)
    : 0.65
  const lowSample = 1 / Math.sqrt(samples + 1)
  const lowVisit = 1 / Math.sqrt(visits + 1)
  const lowConfidence = clamp((confidenceTarget - confidence) / confidenceTarget, 0, 1)
  const uncertainty = clamp(cpStdDev / 140, 0, 1)

  // Bounded, explainable UCB-like pressure without any global scheduling: a
  // close move gets a temporary lift if it has few samples, few visits, low
  // confidence, or high variance. Repeated validation naturally shrinks it.
  const pressure = (lowSample * 0.38) + (lowVisit * 0.22) + (lowConfidence * 0.28) + (uncertainty * 0.12)
  const bonus = Math.min(maxBonus, Math.max(0, pressure * closeness * strength))
  return {
    factor: 1 + bonus,
    bonus,
    samples,
    confidence,
    cpDelta,
    reason: bonus > 0.001 ? 'close-underexplored' : 'already-validated'
  }
}

export function applyOpeningExplorationBias (candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const explicitBest = Number(options.bestEffectiveCp)
  const bestEffectiveCp = Number.isFinite(explicitBest)
    ? explicitBest
    : list.reduce((best, item) => {
      const cp = candidateEffectiveCp(item)
      return cp === null ? best : (best === null ? cp : Math.max(best, cp))
    }, null)
  return list.map(item => {
    const exploration = explorationProfile(item, bestEffectiveCp, options)
    const baseScore = Math.max(0.0001, Number(item && (item.share || item.weight || item.score)) || 0.0001)
    return {
      ...item,
      exploration,
      explorationScore: baseScore * exploration.factor
    }
  })
}

function scoreCandidate (candidate, policy = 'practical') {
  const count = Math.max(0, finiteNumber(candidate.count))
  const trustedCount = Math.max(0, finiteNumber(candidate.trustedCount))
  const exploratoryCount = Math.max(0, finiteNumber(candidate.exploratoryCount))
  const meta = candidate.meta || {}
  const manualBoost = Math.max(0, finiteNumber(meta.manualBoost))
  const avgDepth = Math.max(0, finiteNumber(meta.avgDepth || meta.lastDepth))
  const confidence = clamp(finiteNumber(meta.confidence, 0.4), 0.05, 1.2)
  const base = Math.max(0.0001, count * finiteNumber(meta.qualityWeight, 1))
  if (policy === 'deep-priority') {
    return base * (1 + Math.min(0.55, avgDepth / 45)) * (0.85 + confidence * 0.35)
  }
  if (policy === 'user-priority') {
    return base * (1 + Math.min(0.9, manualBoost)) * (1 + trustedCount * 0.06)
  }
  return base * (1 + trustedCount * 0.04) * (1 + exploratoryCount * 0.01)
}

function formatSigned (value) {
  const rounded = Math.round(value)
  return `${rounded >= 0 ? '+' : ''}${rounded}`
}

function confidenceLabel (confidence) {
  if (confidence >= 0.85) return '신뢰 높음'
  if (confidence >= 0.5) return '신뢰 보통'
  return '신뢰 낮음'
}

function deriveCandidateUi (candidate, bestEffectiveCp, policy) {
  const meta = candidate.meta || {}
  const effectiveCp = Number.isFinite(Number(meta.effectiveCp)) ? Number(meta.effectiveCp) : null
  const cpStdDev = Math.max(0, finiteNumber(meta.cpStdDev))
  const confidence = clamp(finiteNumber(meta.confidence, 0.35), 0.05, 1.2)
  const avgDepth = Math.max(0, finiteNumber(meta.avgDepth || meta.lastDepth))
  const samples = Math.max(0, finiteNumber(meta.cpSamples))
  const repeatCount = Math.max(0, finiteNumber(candidate.count))
  const manualBoost = Math.max(0, finiteNumber(meta.manualBoost))
  const cpDelta = effectiveCp !== null && typeof bestEffectiveCp === 'number' ? Math.max(0, bestEffectiveCp - effectiveCp) : null
  const share = Number(candidate.share || 0)
  const relativeText = cpDelta === null
    ? '-'
    : (cpDelta <= 8 ? '최선 수와 유사' : (cpDelta <= 25 ? '근소한 차이' : (cpDelta <= 60 ? '유력 대안' : '차이 큼')))
  const stabilityPenalty = Math.min(14, cpStdDev / 18)
  const deltaPenalty = cpDelta === null ? 0 : Math.min(18, cpDelta / 9)
  const repeatBonus = Math.min(8, Math.log(repeatCount + 1) * 2.5)
  const depthBonus = Math.min(5, avgDepth / 8)
  const manualBonus = Math.min(5, manualBoost * 5)
  // This is a UI explanation score, not an engine evaluation. It blends the
  // already-persisted ranking metadata into a small relative "practicality"
  // number so users can see why a move was preferred without reading raw CP.
  const practicalScore = Math.round(clamp((confidence * 16) + repeatBonus + depthBonus + manualBonus - stabilityPenalty - deltaPenalty, -30, 30))
  let tag = '실전적'
  if (manualBoost > 0.12 && policy === 'user-priority') tag = '사용자 선호'
  else if (share >= 0.55 && confidence >= 0.45 && cpStdDev < 120) tag = '주력 추천'
  else if (cpDelta !== null && cpDelta <= 12 && confidence >= 0.65 && cpStdDev <= 55) tag = '유력 수순'
  else if (confidence >= 0.75 && cpStdDev <= 65) tag = '안정적'
  else if ((cpStdDev >= 115 || confidence < 0.32) && share < 0.45) tag = '불안정'
  else if (cpDelta !== null && cpDelta >= 75 && share < 0.45) tag = '위험'
  else if ((candidate.exploratoryCount || 0) > (candidate.trustedCount || 0) * 2 && confidence < 0.55 && share < 0.4) tag = '실험적'
  else if (effectiveCp !== null && cpDelta !== null && cpDelta <= 35 && confidence < 0.55) tag = '균형형'
  let reason = '반복/깊이/안정성을 함께 반영한 추천입니다.'
  if (tag === '주력 추천') reason = '추천 비중이 높고 실전 지표가 충분히 뒷받침됩니다.'
  else if (tag === '유력 수순') reason = '상위 후보 대비 손실이 작고 평가가 안정적입니다.'
  else if (tag === '안정적') reason = '반복 평가와 낮은 변동성이 추천을 뒷받침합니다.'
  else if (tag === '불안정') reason = '평가 변동 또는 낮은 신뢰도로 주의가 필요합니다.'
  else if (tag === '위험') reason = '최선 후보와의 상대 격차가 큰 편입니다.'
  else if (tag === '실험적') reason = '탐색 데이터 비중이 높아 검증이 더 필요합니다.'
  else if (tag === '사용자 선호') reason = '직접 추가한 수순의 가중치를 우선 반영합니다.'
  return {
    shareText: `${Math.round((candidate.share || 0) * 100)}%`,
    practicalText: `실전성 ${formatSigned(practicalScore)}`,
    practicalScore,
    confidenceText: confidenceLabel(confidence),
    tag,
    reason,
    cpDelta,
    cpDeltaText: relativeText,
    effectiveCpText: effectiveCp === null ? '-' : `${formatSigned(effectiveCp)}cp`,
    confidenceValue: confidence,
    confidencePercent: `${Math.round(clamp(confidence / 1.2, 0, 1) * 100)}%`,
    cpStdDevText: `${Math.round(cpStdDev)}cp`,
    avgDepthText: avgDepth > 0 ? avgDepth.toFixed(1) : '-',
    samplesText: samples > 0 ? String(Math.round(samples)) : '-',
    qualityWeightText: Number.isFinite(Number(meta.qualityWeight)) ? Number(meta.qualityWeight).toFixed(2) : '-',
    manualBoostText: manualBoost > 0 ? manualBoost.toFixed(2) : '-'
  }
}

export function createOpeningGraph () {
  return {
    positions: {},
    transitions: {},
    transitionMeta: {},
    games: 0,
    moves: 0
  }
}

export function normalizeOpeningGraph (graph) {
  const safe = graph && typeof graph === 'object' ? graph : {}
  const positions = safe.positions && typeof safe.positions === 'object' ? safe.positions : {}
  const transitions = safe.transitions && typeof safe.transitions === 'object' ? safe.transitions : {}
  const transitionMeta = safe.transitionMeta && typeof safe.transitionMeta === 'object' ? safe.transitionMeta : {}
  for (const key of Object.keys(positions)) {
    const node = positions[key] || {}
    if (!node.next) node.next = {}
    if (!node.trustedNext) node.trustedNext = {}
    if (!node.exploratoryNext) node.exploratoryNext = {}
    if (!node.weightNext) node.weightNext = {}
    if (!Number.isFinite(Number(node.visits))) node.visits = 0
  }
  for (const key of Object.keys(transitionMeta)) {
    const meta = refreshTransitionMeta(transitionMeta[key])
    transitionMeta[key] = meta
    const splitAt = key.lastIndexOf('|')
    if (splitAt > 0) {
      const epd = key.slice(0, splitAt)
      const uci = key.slice(splitAt + 1)
      const node = positions[epd]
      if (node && node.next && node.next[uci]) {
        node.weightNext[uci] = Math.max(0.0001, Number(node.next[uci] || 0) * (meta.qualityWeight || 1))
      }
    }
  }
  return {
    positions,
    transitions,
    transitionMeta,
    games: Number.isFinite(Number(safe.games)) ? Number(safe.games) : 0,
    moves: Number.isFinite(Number(safe.moves)) ? Number(safe.moves) : 0
  }
}

export function addSequenceToOpeningGraph (graph, sequence) {
  if (!graph || !sequence || !Array.isArray(sequence.positions) || !Array.isArray(sequence.moves)) return graph
  graph.games += 1
  const source = sequence.source || 'trusted'
  for (let i = 0; i < sequence.positions.length; i++) {
    const fen = sequence.positions[i]
    if (!fen) continue
    const epd = fenToEpd(fen)
    const node = graph.positions[epd] || defaultNode()
    node.visits += 1
    graph.positions[epd] = node
    if (i < sequence.moves.length) {
      const uci = sequence.moves[i]
      if (uci) {
        node.next[uci] = (node.next[uci] || 0) + 1
        if (source === 'exploration') {
          node.exploratoryNext[uci] = (node.exploratoryNext[uci] || 0) + 1
        } else {
          node.trustedNext[uci] = (node.trustedNext[uci] || 0) + 1
        }
        const key = `${epd}|${uci}`
        graph.transitions[key] = (graph.transitions[key] || 0) + 1
        const meta = graph.transitionMeta[key] || defaultTransitionMeta()
        if (source === 'exploration') meta.exploratory = (meta.exploratory || 0) + 1
        else meta.trusted = (meta.trusted || 0) + 1
        const total = meta.trusted + meta.exploratory
        const moveMeta = sequence.moveMeta && sequence.moveMeta[i] ? sequence.moveMeta[i] : null
        const depth = moveMeta && Number.isFinite(Number(moveMeta.depth)) ? Number(moveMeta.depth) : 0
        const cp = moveMeta && Number.isFinite(Number(moveMeta.cp)) ? Number(moveMeta.cp) : null
        if (depth > 0) {
          meta.avgDepth = total > 0 ? (((meta.avgDepth || 0) * Math.max(0, total - 1)) + depth) / total : depth
          meta.lastDepth = depth
        }
        if (typeof cp === 'number') {
          meta.avgCp = total > 0 ? (((meta.avgCp || 0) * Math.max(0, total - 1)) + cp) / total : cp
          meta.lastCp = cp
          addDepthBucketSample(meta, depth || meta.avgDepth || meta.lastDepth, cp, source)
          rebuildMetaFromDepthBuckets(meta)
        }
        if (source === 'manual') {
          meta.manualBoost = Math.min(1.5, (meta.manualBoost || 0) + 0.08)
        }
        refreshTransitionMeta(meta)
        graph.transitionMeta[key] = meta
        const baseCount = node.next[uci] || 0
        node.weightNext[uci] = Math.max(0.0001, baseCount * (meta.qualityWeight || 1))
        graph.moves += 1
      }
    }
  }
  return graph
}

export function openingCandidatesForFen (graph, fen, limit = 6, options = {}) {
  if (!graph || !fen) return []
  const epd = fenToEpd(fen)
  const node = graph.positions[epd]
  if (!node || !node.next) return []
  const policy = options.policy || 'practical'
  const items = Object.entries(node.next).map(([uci, count]) => {
    const trustedCount = node.trustedNext[uci] || 0
    const exploratoryCount = node.exploratoryNext[uci] || 0
    const key = `${epd}|${uci}`
    const meta = graph.transitionMeta && graph.transitionMeta[key] ? refreshTransitionMeta(graph.transitionMeta[key]) : refreshTransitionMeta({ trusted: trustedCount, exploratory: exploratoryCount })
    const weighted = node.weightNext && Number.isFinite(Number(node.weightNext[uci])) ? Number(node.weightNext[uci]) : null
    const fallbackScore = weighted !== null ? weighted : (trustedCount + exploratoryCount * 0.35)
    const item = { uci, count, trustedCount, exploratoryCount, score: fallbackScore, weight: fallbackScore, meta }
    item.score = scoreCandidate(item, policy)
    item.weight = item.score
    item.effectiveCp = meta.effectiveCp
    item.confidence = meta.confidence
    item.avgDepth = meta.avgDepth
    item.manualBoost = meta.manualBoost
    return item
  })
  const bestEffectiveCp = items.reduce((best, item) => {
    const cp = Number.isFinite(Number(item.effectiveCp)) ? Number(item.effectiveCp) : null
    return cp === null ? best : (best === null ? cp : Math.max(best, cp))
  }, null)
  const displayItems = policy === 'practical'
    ? applyOpeningExplorationBias(items, {
      bestEffectiveCp,
      maxCpDelta: Number(options.explorationCpDelta) || 60,
      strength: Number(options.explorationStrength) || 0.35,
      maxBonus: Number(options.explorationMaxBonus) || 0.22
    }).map(item => ({ ...item, score: item.explorationScore, weight: item.explorationScore }))
    : items
  const scoreTotal = displayItems.reduce((sum, cur) => sum + cur.score, 0) || 1
  return displayItems
    .map(item => {
      const withShare = {
        ...item,
        share: item.score / scoreTotal
      }
      withShare.ui = deriveCandidateUi(withShare, bestEffectiveCp, policy)
      return withShare
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export function mergeOpeningGraphs (baseGraph, incomingGraph) {
  const base = normalizeOpeningGraph(baseGraph || createOpeningGraph())
  const incoming = normalizeOpeningGraph(incomingGraph || createOpeningGraph())
  for (const [epd, incomingNode] of Object.entries(incoming.positions || {})) {
    const node = base.positions[epd] || defaultNode()
    node.visits = Math.max(0, finiteNumber(node.visits)) + Math.max(0, finiteNumber(incomingNode.visits))
    const countFields = ['next', 'trustedNext', 'exploratoryNext']
    countFields.forEach(field => {
      node[field] = node[field] || {}
      for (const [uci, count] of Object.entries((incomingNode && incomingNode[field]) || {})) {
        node[field][uci] = Math.max(0, finiteNumber(node[field][uci])) + Math.max(0, finiteNumber(count))
      }
    })
    node.weightNext = node.weightNext || {}
    base.positions[epd] = node
  }
  for (const [key, count] of Object.entries(incoming.transitions || {})) {
    base.transitions[key] = Math.max(0, finiteNumber(base.transitions[key])) + Math.max(0, finiteNumber(count))
  }
  for (const [key, incomingMetaRaw] of Object.entries(incoming.transitionMeta || {})) {
    const meta = base.transitionMeta[key] || defaultTransitionMeta()
    const incomingMeta = refreshTransitionMeta(incomingMetaRaw || {})
    meta.trusted = Math.max(0, finiteNumber(meta.trusted)) + Math.max(0, finiteNumber(incomingMeta.trusted))
    meta.exploratory = Math.max(0, finiteNumber(meta.exploratory)) + Math.max(0, finiteNumber(incomingMeta.exploratory))
    meta.manualBoost = Math.min(1.5, Math.max(finiteNumber(meta.manualBoost), finiteNumber(incomingMeta.manualBoost)))
    meta.depthBuckets = meta.depthBuckets && typeof meta.depthBuckets === 'object' ? meta.depthBuckets : {}
    for (const [depthKey, incomingBucket] of Object.entries(incomingMeta.depthBuckets || {})) {
      const bucket = meta.depthBuckets[depthKey] || { count: 0, trusted: 0, exploratory: 0, cpWeightSum: 0, cpWeightedSum: 0, cpWeightedSqSum: 0, avgCp: 0 }
      bucket.count = Math.max(0, finiteNumber(bucket.count)) + Math.max(0, finiteNumber(incomingBucket.count))
      bucket.trusted = Math.max(0, finiteNumber(bucket.trusted)) + Math.max(0, finiteNumber(incomingBucket.trusted))
      bucket.exploratory = Math.max(0, finiteNumber(bucket.exploratory)) + Math.max(0, finiteNumber(incomingBucket.exploratory))
      bucket.cpWeightSum = Math.max(0, finiteNumber(bucket.cpWeightSum)) + Math.max(0, finiteNumber(incomingBucket.cpWeightSum))
      bucket.cpWeightedSum = finiteNumber(bucket.cpWeightedSum) + finiteNumber(incomingBucket.cpWeightedSum)
      bucket.cpWeightedSqSum = Math.max(0, finiteNumber(bucket.cpWeightedSqSum)) + Math.max(0, finiteNumber(incomingBucket.cpWeightedSqSum))
      bucket.avgCp = bucket.cpWeightSum > 0 ? bucket.cpWeightedSum / bucket.cpWeightSum : finiteNumber(incomingBucket.avgCp)
      meta.depthBuckets[depthKey] = bucket
    }
    if (!Object.keys(meta.depthBuckets).length && incomingMeta.cpWeightSum > 0) {
      meta.cpSamples = Math.max(0, finiteNumber(meta.cpSamples)) + Math.max(0, finiteNumber(incomingMeta.cpSamples))
      meta.cpWeightSum = Math.max(0, finiteNumber(meta.cpWeightSum)) + Math.max(0, finiteNumber(incomingMeta.cpWeightSum))
      meta.cpWeightedSum = finiteNumber(meta.cpWeightedSum) + finiteNumber(incomingMeta.cpWeightedSum)
      meta.cpWeightedSqSum = Math.max(0, finiteNumber(meta.cpWeightedSqSum)) + Math.max(0, finiteNumber(incomingMeta.cpWeightedSqSum))
    }
    base.transitionMeta[key] = refreshTransitionMeta(meta)
  }
  base.games = Math.max(0, finiteNumber(base.games)) + Math.max(0, finiteNumber(incoming.games))
  base.moves = Object.values(base.transitions || {}).reduce((sum, v) => sum + Math.max(0, finiteNumber(v)), 0)
  return normalizeOpeningGraph(base)
}

export function chooseWeightedCandidate (candidates, { topK = 3, temperature = 1, policy = 'practical', explorationBias = false } = {}) {
  const list = Array.isArray(candidates) ? candidates.slice(0, Math.max(1, topK)) : []
  if (!list.length) return null
  const safeTemp = Math.max(0.2, Number(temperature) || 1)
  const weights = list.map(c => {
    const trustedBias = 1 + Math.max(0, Number(c.trustedCount || 0)) * 0.15
    const manualBias = policy === 'user-priority' ? (1 + Math.min(0.8, Number(c.manualBoost || (c.meta && c.meta.manualBoost) || 0))) : 1
    const depthBias = policy === 'deep-priority' ? (1 + Math.min(0.35, Number(c.avgDepth || (c.meta && c.meta.avgDepth) || 0) / 60)) : 1
    const explorationScore = explorationBias && Number.isFinite(Number(c.explorationScore)) ? Number(c.explorationScore) : null
    const base = Math.max(0.0001, explorationScore !== null ? explorationScore : Number(c.share || c.weight || c.score || 0.0001))
    return Math.pow(base * trustedBias * manualBias * depthBias, 1 / safeTemp)
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < list.length; i++) {
    r -= weights[i]
    if (r <= 0) return list[i]
  }
  return list[0]
}
