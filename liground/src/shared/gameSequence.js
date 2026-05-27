export const GAMESEQ_PREFIX = 'LIGROUND-GAMESEQ/1'
export const GAMESEQ_PREFIX_V2 = 'LIGROUND-GAMESEQ/2'

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
    GAMESEQ_PREFIX_V2,
    `variant: ${variant || 'janggi'}`,
    `startFen: ${startFen || ''}`,
    'moves:',
    ...safeMoves.map((move, idx) => `${idx + 1}. ${move}`),
    'meta:',
    ...Object.entries(metadata || {}).map(([k, v]) => `  ${k}: ${String(v)}`)
  ].join('\n')
}

export function parseGameSequence (text) {
  if (typeof text !== 'string') return null
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) return null
  if (lines[0] === GAMESEQ_PREFIX_V2) {
    let variant = 'janggi'
    let startFen = ''
    const moves = []
    const metadata = {}
    let inMoves = false
    let inMeta = false
    for (const line of lines.slice(1)) {
      if (line.startsWith('variant:')) {
        variant = line.replace(/^variant:\s*/, '') || 'janggi'
        inMoves = false
        inMeta = false
      } else if (line.startsWith('startFen:')) {
        startFen = line.replace(/^startFen:\s*/, '')
        inMoves = false
        inMeta = false
      } else if (line === 'moves:') {
        inMoves = true
        inMeta = false
      } else if (line === 'meta:') {
        inMoves = false
        inMeta = true
      } else if (inMoves) {
        const move = line.replace(/^\d+\.\s*/, '').trim()
        if (move) moves.push(move)
      } else if (inMeta && line.includes(':')) {
        const idx = line.indexOf(':')
        metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }
    return { variant, startFen, moves, metadata }
  }
  if (lines[0] !== GAMESEQ_PREFIX) return null
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
