export const GAMESEQ_PREFIX = 'LIGROUND-GAMESEQ/1'

export function buildMainlineFromMove (move) {
  if (!move) return []
  const line = []
  let current = move
  while (current) {
    line.push(current)
    current = current.prev
  }
  return line.reverse()
}

export function serializeGameSequence ({ variant, startFen, moves, metadata = {} }) {
  const safeMoves = Array.isArray(moves) ? moves.filter(Boolean).map(String) : []
  return [
    GAMESEQ_PREFIX,
    `variant=${variant || 'janggi'}`,
    `startFen=${encodeURIComponent(startFen || '')}`,
    `moves=${safeMoves.join(' ')}`,
    `meta=${encodeURIComponent(JSON.stringify(metadata || {}))}`
  ].join('\n')
}

export function parseGameSequence (text) {
  if (typeof text !== 'string') return null
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length || lines[0] !== GAMESEQ_PREFIX) return null
  const map = {}
  for (const line of lines.slice(1)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    map[line.slice(0, eq)] = line.slice(eq + 1)
  }
  const moves = (map.moves || '').trim() === '' ? [] : map.moves.trim().split(/\s+/)
  let metadata = {}
  if (map.meta) {
    try {
      metadata = JSON.parse(decodeURIComponent(map.meta))
    } catch (err) {
      metadata = {}
    }
  }
  return {
    variant: map.variant || 'janggi',
    startFen: decodeURIComponent(map.startFen || ''),
    moves,
    metadata
  }
}
