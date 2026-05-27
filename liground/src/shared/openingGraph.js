import { fenToEpd } from './openingLookup'

function defaultNode () {
  return { visits: 0, next: {}, trustedNext: {}, exploratoryNext: {} }
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
        const meta = graph.transitionMeta[key] || { trusted: 0, exploratory: 0 }
        if (source === 'exploration') meta.exploratory += 1
        else meta.trusted += 1
        graph.transitionMeta[key] = meta
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
    const score = trustedCount + exploratoryCount * 0.35
    return { uci, count, trustedCount, exploratoryCount, score }
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
