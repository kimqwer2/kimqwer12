const assert = require('assert')
const fs = require('fs')
const path = require('path')

function loadFunctions (relativePath, names) {
  const filename = path.join(__dirname, relativePath)
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
  return Function(`${source}\nreturn { ${names.join(', ')} }`)()
}

const { createPositionSnapshot, orderedMovesFromHistory, positionCommandFromSnapshot } = loadFunctions('../src/shared/enginePosition.js', ['createPositionSnapshot', 'orderedMovesFromHistory', 'positionCommandFromSnapshot'])
const { parseGameSequence, serializeGameSequence } = loadFunctions('../src/shared/gameSequence.js', ['parseGameSequence', 'serializeGameSequence'])

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const normalizeFen = fen => String(fen).trim().split(/\s+/).slice(0, 4).join(' ')
const start = 'start w - - 0 1'
const positions = {
  [start]: {
    a1a2: 'after-a b - - 1 1',
    e2e2: 'after-pass b - - 1 1'
  },
  'after-a b - - 1 1': { a9a8: 'after-b w - - 2 2' },
  'custom w - - 0 1': { f10f10: 'custom-pass b - - 1 1' }
}
function createBoard (_variant, fen) {
  let current = fen
  return {
    push (move) {
      const next = positions[current] && positions[current][move]
      if (!next) throw new Error(`illegal test move ${move}`)
      current = next
    },
    fen () { return current }
  }
}
function history (moves) {
  let prev = null
  return moves.map(uci => (prev = { uci, prev }))
}

test('standard start emits startpos with complete history', () => {
  const moves = history(['a1a2', 'a9a8'])
  const snapshot = createPositionSnapshot({ variant: 'janggi', startFen: start, fen: 'after-b w - - 99 40', moves }, { createBoard, normalizeFen })
  assert.deepStrictEqual(snapshot.moves, ['a1a2', 'a9a8'])
  assert.strictEqual(positionCommandFromSnapshot(snapshot, start, normalizeFen), 'position startpos moves a1a2 a9a8')
  assert.ok(snapshot.historyHash)
})

test('custom starts and native self-square PASS remain in history', () => {
  const moves = history(['f10f10'])
  const snapshot = createPositionSnapshot({ variant: 'janggimodern', startFen: 'custom w - - 0 1', fen: 'custom-pass b - - 1 1', moves }, { createBoard, normalizeFen })
  assert.strictEqual(positionCommandFromSnapshot(snapshot, start, normalizeFen), 'position fen custom w - - 0 1 moves f10f10')
})

test('variation history follows the selected node chain', () => {
  const main = history(['a1a2', 'a9a8'])
  const variation = { uci: 'e2e2', prev: null }
  assert.deepStrictEqual(orderedMovesFromHistory(main), ['a1a2', 'a9a8'])
  assert.deepStrictEqual(orderedMovesFromHistory([main[1], variation]), ['e2e2'])
})

test('position mismatch is explicit and does not provide a fallback command', () => {
  assert.throws(() => createPositionSnapshot({ variant: 'janggi', startFen: start, fen: 'wrong w - - 0 1', moves: history(['a1a2']) }, { createBoard, normalizeFen }), err => err.code === 'POSITION_HISTORY_MISMATCH')
})

test('LIGROUND-GAMESEQ/2 round-trips custom starts and PASS', () => {
  const encoded = serializeGameSequence({ variant: 'janggimodern', startFen: 'custom w - - 0 1', moves: ['f10f10'] })
  const decoded = parseGameSequence(encoded)
  assert.strictEqual(decoded.variant, 'janggimodern')
  assert.strictEqual(decoded.startFen, 'custom w - - 0 1')
  assert.deepStrictEqual(decoded.moves, ['f10f10'])
})

Promise.resolve().then(async () => {
  for (const item of tests) {
    await item.fn()
    process.stdout.write(`✓ ${item.name}\n`)
  }
  process.stdout.write(`${tests.length} tests passed\n`)
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
