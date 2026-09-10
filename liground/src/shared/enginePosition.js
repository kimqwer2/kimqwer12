function hashText (text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function orderedMovesFromHistory (moves) {
  if (!Array.isArray(moves) || moves.length === 0) return []
  const line = []
  let node = moves[moves.length - 1]
  while (node) {
    if (node.uci) line.push(String(node.uci))
    node = node.prev
  }
  return line.reverse()
}

export function createPositionSnapshot (gameState, { createBoard, normalizeFen }) {
  const currentFen = typeof gameState.fen === 'string' ? gameState.fen.trim() : ''
  const startFen = typeof gameState.startFen === 'string' ? gameState.startFen.trim() : ''
  const variant = gameState.variant || 'chess'
  const is960 = !!gameState.is960
  const moves = orderedMovesFromHistory(gameState.moves)
  if (!startFen) throw Object.assign(new Error('Invalid GameState: missing startFen'), { code: 'MISSING_START_FEN' })

  const board = createBoard(variant, startFen, is960)
  for (const move of moves) board.push(move)
  const reconstructedFen = board.fen()
  if (currentFen && normalizeFen(currentFen) !== normalizeFen(reconstructedFen)) {
    throw Object.assign(new Error(`Position history mismatch: live=${currentFen} reconstructed=${reconstructedFen}`), {
      code: 'POSITION_HISTORY_MISMATCH', currentFen, reconstructedFen
    })
  }
  const identity = `${variant}\n${startFen}\n${moves.join(' ')}`
  return {
    variant,
    startFen,
    moves,
    currentFen: reconstructedFen,
    sideToMove: gameState.sideToMove || (String(reconstructedFen).split(/\s+/)[1] === 'b' ? 'black' : 'white'),
    historyHash: hashText(identity),
    is960
  }
}

export function positionCommandFromSnapshot (snapshot, standardStartFen, normalizeFen) {
  const moveLine = snapshot.moves.join(' ')
  const standard = normalizeFen(snapshot.startFen) === normalizeFen(standardStartFen)
  const root = standard ? 'position startpos' : `position fen ${snapshot.startFen}`
  return moveLine ? `${root} moves ${moveLine}` : root
}
