import fs from 'fs'
import { spawn } from 'child_process'
import EngineDriver from './driver'
import EngineSender from './sender'

// create sender with 50ms interval
const msg = new EngineSender(50)

/** @type {import('child_process').ChildProcess} */
let child = null

/** @type {EngineDriver} */
let engine = null

/**
 * Run a new engine, killing the old process.
 * @param {string} binary binary to use
 * @param {string} cwd working directory to use
 * @param {string[]} listeners listeners to attach to driver
 */
async function run (binary, cwd, listeners) {
  // kill old engine
  if (engine) {
    msg.debug('Killing...')

    // remove listeners
    child.removeAllListeners('exit')
    engine.events.removeAllListeners('input')
    engine.events.removeAllListeners('output')
    engine.events.removeAllListeners('info')

    // quit engine
    await engine.quit()
    engine = null
    msg.debug('Killed!')
  }

  // spawn engine process
  if (!fs.existsSync(binary)) {
    msg.error(`Could not find engine binary "${binary}"`)
    return
  }
  msg.debug('Running:', { binary, cwd })
  child = spawn(binary, [], { cwd }).on('error', err => msg.error(err.message))

  // success
  if (typeof child.pid === 'number') {
    // create engine
    engine = new EngineDriver(child.stdin, child.stdout)

    // setup error logging & crash handling
    child.stderr.on('data', err => msg.error('Engine reported Error:', err.toString().trim()))
    child.on('exit', () => msg.queue('crash'))

    // setup listeners
    for (const event of listeners) {
      if (event === 'io') {
        engine.events.on('input', data => msg.queue('io', `> ${data}`))
        engine.events.on('line', data => msg.queue('io', data))
      } else {
        engine.events.on(event, info => msg.queue(event, info))
      }
    }

    // initialize
    await engine.initialize()

    msg.debug('Engine active:', engine.info)

    // reply with engine infos
    msg.queue('active', engine.info)
  }
}

/**
 * Execute a UCI command.
 * @param {string} cmd
 */
function exec (cmd) {
  cmd = cmd.trim()
  msg.debug(`Received command "${cmd}"`)
  if (engine) {
    engine.exec(cmd).catch(err => msg.error(err.message))
  } else {
    msg.error('Engine not running')
  }
}

function evalPos (fen, depth) {
  msg.debug(`Evaluating "${fen}" with depth ${depth}`)
  if (engine) {
    let result = ''
    engine.exec(`position fen ${fen}`)
    const listener = info => {
      if ('cp' in info) {
        result = `${info.cp}`
      } else if ('mate' in info) {
        result = `#${info.mate}`
      }
    }
    engine.events.on('info', listener)
    engine.events.once('bestmove', () => {
      engine.events.off('info', listener)
      msg.debug(`Eval finished with result: ${result}`)
      msg.queue('evaluated', result)
    })
    engine.exec(`go depth ${depth}`)
  } else {
    msg.error('Engine not running')
  }
}


function normalizeReviewLine (line) {
  return Array.isArray(line) ? line.filter(Boolean).join(' ') : ''
}

function positionForReviewPrefix (fen, line, count) {
  const prefix = normalizeReviewLine(line.slice(0, count))
  return prefix ? `position fen ${fen} moves ${prefix}` : `position fen ${fen}`
}

function collectSearch (positionCommand, goCommand, timeout = 20000) {
  return new Promise(resolve => {
    const lines = []
    let done = false
    const cleanup = () => {
      engine.events.off('info', listener)
      engine.events.off('bestmove', bestmoveListener)
      clearTimeout(timer)
    }
    const finish = payload => {
      if (done) return
      done = true
      cleanup()
      resolve(payload)
    }
    const listener = info => {
      if ('pv' in info) {
        const rank = info.multipv || 1
        lines[rank - 1] = {
          cp: info.cp,
          mate: info.mate,
          pvUCI: info.pv,
          ucimove: typeof info.pv === 'string' ? info.pv.split(/\s+/)[0] : '',
          depth: info.depth,
          seldepth: info.seldepth,
          wdl: info.wdl,
          wdlWin: info.wdlWin,
          wdlDraw: info.wdlDraw,
          wdlLoss: info.wdlLoss
        }
      }
    }
    const bestmoveListener = bestmove => finish({ bestmove, candidates: lines.filter(Boolean) })
    const timer = setTimeout(() => {
      try { engine.exec('stop') } catch (err) {}
      finish({ error: 'review search timeout', candidates: lines.filter(Boolean) })
    }, timeout)
    engine.events.on('info', listener)
    engine.events.once('bestmove', bestmoveListener)
    engine.exec(positionCommand)
    engine.exec(goCommand)
  })
}

async function reviewAnalyze (payload) {
  if (!engine) {
    msg.error('Engine not running')
    return
  }
  const depth = payload.depth || 10
  const multiPv = payload.multiPv || 3
  const variant = payload.variant
  const fen = payload.fen
  const line = Array.isArray(payload.line) ? payload.line.filter(Boolean) : []
  const firstMove = payload.move || line[0]
  const joinedLine = normalizeReviewLine(line)
  const positionRoot = `position fen ${fen}`
  const positionAfter = joinedLine ? `position fen ${fen} moves ${joinedLine}` : positionRoot

  try {
    if (variant) {
      await engine.exec(`setoption name UCI_Variant value ${variant}`)
    }
    await engine.exec(`setoption name MultiPV value ${multiPv}`)
    await engine.exec('setoption name UCI_ShowWDL value true')
    const root = await collectSearch(positionRoot, `go depth ${depth}`)
    let user = null
    if (firstMove) {
      await engine.exec('setoption name MultiPV value 1')
      user = await collectSearch(positionRoot, `go depth ${depth} searchmoves ${firstMove}`)
      await engine.exec(`setoption name MultiPV value ${multiPv}`)
    }
    const after = joinedLine ? await collectSearch(positionAfter, `go depth ${depth}`) : null
    const moves = []
    const perMoveDepth = Math.max(4, Math.min(depth, payload.perMoveDepth || depth))
    const maxReviewMoves = Math.min(line.length, payload.maxReviewMoves || 20)
    for (let idx = 0; idx < maxReviewMoves; idx++) {
      const move = line[idx]
      const before = positionForReviewPrefix(fen, line, idx)
      const afterMove = positionForReviewPrefix(fen, line, idx + 1)
      await engine.exec(`setoption name MultiPV value ${Math.min(2, multiPv)}`)
      const moveRoot = await collectSearch(before, `go depth ${perMoveDepth}`, 16000)
      await engine.exec('setoption name MultiPV value 1')
      const moveUser = await collectSearch(before, `go depth ${perMoveDepth} searchmoves ${move}`, 16000)
      const moveAfter = await collectSearch(afterMove, `go depth ${Math.max(4, perMoveDepth - 1)}`, 16000)
      moves.push({
        ply: idx + 1,
        move,
        positionBefore: before,
        positionAfter: afterMove,
        root: moveRoot,
        user: moveUser,
        after: moveAfter
      })
    }
    await engine.exec(`setoption name MultiPV value ${multiPv}`)
    msg.queue('reviewed', {
      depth,
      multiPv,
      root,
      user,
      after,
      moves,
      line,
      variant,
      rootFen: fen,
      finalPositionCommand: positionAfter
    })
  } catch (err) {
    msg.queue('reviewed', { error: err.message })
  }
}

self.addEventListener('message', ({ data: { type, payload } }) => {
  switch (type) {
    case 'run':
      run(payload.binary, payload.cwd, payload.listeners || [])
      break
    case 'cmd':
      exec(payload)
      break
    case 'eval': {
      const { fen, depth } = payload
      evalPos(fen, depth)
      break
    }
    case 'review':
      reviewAnalyze(payload)
      break
  }
})
