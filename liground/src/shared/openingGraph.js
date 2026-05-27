import { fenToEpd } from './openingLookup'

function defaultNode () {
  return { visits: 0, next: {}, trustedNext: {}, exploratoryNext: {}, weightNext: {} }
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
        const meta = graph.transitionMeta[key] || { trusted: 0, exploratory: 0, avgDepth: 0, lastDepth: 0, avgCp: 0, lastCp: 0, manualBoost: 0, qualityWeight: 1 }
        if (source === 'exploration') meta.exploratory += 1
        else meta.trusted += 1
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
        }
        if (source === 'manual') {
          meta.manualBoost = Math.min(1.5, (meta.manualBoost || 0) + 0.08)
        }
        const depthWeight = meta.avgDepth > 0 ? Math.min(1.25, 1 + (meta.avgDepth / 100)) : 1
        const cpPenalty = typeof meta.avgCp === 'number' && meta.avgCp < -150 ? 0.7 : 1
        const cpBonus = typeof meta.avgCp === 'number' && meta.avgCp > 50 ? 1.06 : 1
        const manualWeight = 1 + Math.min(0.3, meta.manualBoost || 0)
        meta.qualityWeight = depthWeight * cpPenalty * cpBonus * manualWeight
        graph.transitionMeta[key] = meta
        const baseCount = node.next[uci] || 0
        node.weightNext[uci] = Math.max(0.0001, baseCount * (meta.qualityWeight || 1))
        graph.moves += 1
      }
    }
  }
  return graph
}

export function openingCandidatesForFen (graph, fen, limit = 6) {
  if (!graph || !fen) return []
  const epd = fenToEpd(fen)
  const node = graph.positions[epd]
  if (!node || !node.next) return []
  const items = Object.entries(node.next).map(([uci, count]) => {
    const trustedCount = node.trustedNext[uci] || 0
    const exploratoryCount = node.exploratoryNext[uci] || 0
    const weighted = node.weightNext && Number.isFinite(Number(node.weightNext[uci])) ? Number(node.weightNext[uci]) : null
    const score = weighted !== null ? weighted : (trustedCount + exploratoryCount * 0.35)
    return { uci, count, trustedCount, exploratoryCount, score, weight: score }
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

export function chooseWeightedCandidate (candidates, { topK = 3, temperature = 1 } = {}) {
  const list = Array.isArray(candidates) ? candidates.slice(0, Math.max(1, topK)) : []
  if (!list.length) return null
  const safeTemp = Math.max(0.2, Number(temperature) || 1)
  const weights = list.map(c => {
    const trustedBias = 1 + Math.max(0, Number(c.trustedCount || 0)) * 0.15
    const base = Math.max(0.0001, Number(c.share || 0.0001))
    return Math.pow(base * trustedBias, 1 / safeTemp)
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < list.length; i++) {
    r -= weights[i]
    if (r <= 0) return list[i]
  }
  return list[0]
}
