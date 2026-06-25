// WinBoard/XBoard Janggi export helpers.
// Coordinate conversion mirrors fjace_analyzer_all10.py:to_fs_uci, which converts
// Liground/Janggi zero-based ranks (a0-i9) to Fairy-Stockfish/WinBoard ranks (a1-i10).

function toFsUci (uci0) {
  const match = /^([a-i])(\d+)([a-i])(\d+)$/i.exec(String(uci0 || '').trim())
  if (!match) return String(uci0 || '').trim()
  return `${match[1].toLowerCase()}${Number(match[2]) + 1}${match[3].toLowerCase()}${Number(match[4]) + 1}`
}

function exportDate (date = new Date()) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}.${mm}.${dd}`
}

function ligroundPieceToWinBoardPiece (piece) {
  if (piece === 'N') return 'H'
  if (piece === 'n') return 'h'
  if (piece === 'B') return 'E'
  if (piece === 'b') return 'e'
  return piece
}

function winBoardPieceToLigroundPiece (piece) {
  if (piece === 'H') return 'N'
  if (piece === 'h') return 'n'
  if (piece === 'E') return 'B'
  if (piece === 'e') return 'b'
  return piece
}

export function serializeWinBoardFen (fen) {
  const parts = String(fen || '').trim().split(/\s+/)
  if (!parts[0]) return ''
  parts[0] = parts[0].replace(/[NnBb]/g, ligroundPieceToWinBoardPiece)
  return parts.join(' ')
}

export function deserializeWinBoardFen (text) {
  const raw = String(text || '').trim()
  const fenMatch = /\[FEN\s+"([^"]+)"\]/i.exec(raw)
  const candidate = (fenMatch ? fenMatch[1] : raw.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('[') && !line.startsWith('{')) || raw)
    .replace(/^position\s+fen\s+/i, '')
    .trim()
  const parts = candidate.split(/\s+/).filter(Boolean)
  if (!parts[0]) return ''
  parts[0] = parts[0].replace(/[HhEe]/g, winBoardPieceToLigroundPiece)
  if (parts.length === 1) parts.push('w')
  while (parts.length < 6) {
    if (parts.length === 2) parts.push('-')
    else if (parts.length === 3) parts.push('-')
    else if (parts.length === 4) parts.push('0')
    else parts.push('1')
  }
  return parts.join(' ')
}

function boardDumpFromFen (fen) {
  const board = String(fen || '').split(/\s+/)[0]
  if (!board) return ''
  const rows = board.split('/').map(row => row.replace(/\d/g, digit => '.'.repeat(Number(digit))))
  return `{--------------\n${rows.join('\n')}\n--------------}`
}

function formatWinBoardMoveList (moves) {
  const safeMoves = Array.isArray(moves) ? moves.filter(Boolean) : []
  const lines = []
  for (let i = 0; i < safeMoves.length; i += 2) {
    const moveNumber = Math.floor(i / 2) + 1
    const whiteMove = toFsUci(safeMoves[i])
    const blackMove = safeMoves[i + 1] ? toFsUci(safeMoves[i + 1]) : ''
    lines.push(`${moveNumber}. ${whiteMove}${blackMove ? ` ${blackMove}` : ''}`)
  }
  return lines.join('\n')
}

export function serializeWinBoardGame ({ fen, moves, includeBoardDump = true, date = new Date() } = {}) {
  const safeFen = serializeWinBoardFen(fen)
  const headers = [
    '[Event "Edited game"]',
    '[Site "--"]',
    `[Date "${exportDate(date)}"]`,
    '[Round "-"]',
    '[White "-"]',
    '[Black "-"]',
    '[Result "*"]',
    '[Variant "janggimodern"]',
    '[VariantFamily "janggi"]',
    `[FEN "${safeFen.replace(/"/g, '\\"')}"]`,
    '[SetUp "1"]'
  ]
  const sections = [headers.join('\n')]
  if (includeBoardDump) sections.push(boardDumpFromFen(safeFen))
  const moveList = formatWinBoardMoveList(moves)
  if (moveList) sections.push(moveList)
  sections.push('*')
  return sections.filter(section => section !== '').join('\n\n')
}

export const __test__ = { toFsUci, ligroundPieceToWinBoardPiece, winBoardPieceToLigroundPiece, boardDumpFromFen, formatWinBoardMoveList, exportDate }
