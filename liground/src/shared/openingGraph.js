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
    effectiveCp: 0,
    cpStdDev: 0,
    confidence: 0
  }
}

function depthSampleWeight (depth) {
  if (!Number.isFinite(depth) || depth <= 0) return 1
  // Depth should increase trust, but only gently: one very deep outlier must not
  // overwhelm a stable group of repeated shallower evaluations.
  return clamp(1 + (Math.sqrt(depth) / 5), 1, 2.25)
}

export function refreshTransitionMeta (meta) {
  if (!meta || typeof meta !== 'object') return defaultTransitionMeta()
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
  meta.effectiveCp = effectiveCp
  meta.cpStdDev = cpStdDev
  meta.confidence = confidence
  meta.qualityWeight = depthWeight * cpPenalty * cpBonus * manualWeight * confidenceWeight
  return meta
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
          const sampleWeight = depthSampleWeight(depth || meta.avgDepth || meta.lastDepth)
          meta.cpSamples = Math.max(0, finiteNumber(meta.cpSamples)) + 1
          meta.cpWeightSum = Math.max(0, finiteNumber(meta.cpWeightSum)) + sampleWeight
          meta.cpWeightedSum = finiteNumber(meta.cpWeightedSum) + (cp * sampleWeight)
          meta.cpWeightedSqSum = Math.max(0, finiteNumber(meta.cpWeightedSqSum)) + (cp * cp * sampleWeight)
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
  const scoreTotal = items.reduce((sum, cur) => sum + cur.score, 0) || 1
  return items
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => ({
      ...item,
      share: item.score / scoreTotal
    }))
}

export function chooseWeightedCandidate (candidates, { topK = 3, temperature = 1, policy = 'practical' } = {}) {
  const list = Array.isArray(candidates) ? candidates.slice(0, Math.max(1, topK)) : []
  if (!list.length) return null
  const safeTemp = Math.max(0.2, Number(temperature) || 1)
  const weights = list.map(c => {
    const trustedBias = 1 + Math.max(0, Number(c.trustedCount || 0)) * 0.15
    const manualBias = policy === 'user-priority' ? (1 + Math.min(0.8, Number(c.manualBoost || (c.meta && c.meta.manualBoost) || 0))) : 1
    const depthBias = policy === 'deep-priority' ? (1 + Math.min(0.35, Number(c.avgDepth || (c.meta && c.meta.avgDepth) || 0) / 60)) : 1
    const base = Math.max(0.0001, Number(c.share || c.weight || c.score || 0.0001))
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
