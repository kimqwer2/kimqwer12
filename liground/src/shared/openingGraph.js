import { fenToEpd } from './openingLookup'

function defaultNode () {
  return { visits: 0, next: {} }
}

export function createOpeningGraph () {
  return {
    positions: {},
    transitions: {},
    games: 0,
    moves: 0
  }
}

export function addSequenceToOpeningGraph (graph, sequence) {
  if (!graph || !sequence || !Array.isArray(sequence.positions) || !Array.isArray(sequence.moves)) return graph
  graph.games += 1
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
        const key = `${epd}|${uci}`
        graph.transitions[key] = (graph.transitions[key] || 0) + 1
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
  return Object.entries(node.next)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([uci, count]) => ({
      uci,
      count,
      share: node.visits > 0 ? count / node.visits : 0
    }))
}
