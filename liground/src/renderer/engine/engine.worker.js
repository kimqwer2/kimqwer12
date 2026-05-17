import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import EngineDriver from './driver'
import EngineSender from './sender'

// create sender with 50ms interval
const msg = new EngineSender(50)

/** @type {import('child_process').ChildProcess} */
let child = null

/** @type {EngineDriver} */
let engine = null
let engineCwd = ''
let pendingEvalFile = null
let deepAnalysisCancelled = false

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
  engineCwd = cwd
  msg.debug('Running:', { binary, cwd })
  child = spawn(binary, [], { cwd }).on('error', err => msg.error(err.message))

  // success
  if (typeof child.pid === 'number') {
    // create engine
    engine = new EngineDriver(child.stdin, child.stdout)

    // setup error logging & crash handling
    child.stderr.on('data', err => {
      const text = err.toString().trim()
      msg.error('Engine reported Error:', text)
      if (pendingEvalFile && /nnue|evalfile|network|net/i.test(text)) {
        msg.queue('nnue', {
          status: 'rejected',
          requested: pendingEvalFile.requested,
          resolved: pendingEvalFile.resolved,
          cwd: engineCwd,
          error: text
        })
      }
    })
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
function parseSetOption (cmd) {
  const match = cmd.match(/^setoption\s+name\s+(.+?)(?:\s+value\s+(.+))?$/i)
  if (!match) return null
  return {
    name: match[1].trim(),
    value: match[2] !== undefined ? match[2].trim() : null
  }
}

function resolveEvalFilePath (value) {
  if (!value || value.toLowerCase() === '<empty>') return null
  return path.isAbsolute(value) ? value : path.resolve(engineCwd || '.', value)
}

async function exec (cmd) {
  cmd = cmd.trim()
  msg.debug(`Received command "${cmd}"`)
  if (cmd.toLowerCase() === 'stop') {
    deepAnalysisCancelled = true
  }
  if (!engine) {
    msg.error('Engine not running')
    return
  }

  const option = parseSetOption(cmd)
  if (option && option.name === 'EvalFile') {
    const resolved = resolveEvalFilePath(option.value)
    if (resolved && !fs.existsSync(resolved)) {
      const payload = {
        status: 'missing',
        requested: option.value,
        resolved,
        cwd: engineCwd
      }
      msg.queue('nnue', payload)
      msg.error(`[NNUE] EvalFile not found: ${option.value} (resolved to ${resolved}). Keeping engine default network.`)
      return
    }
    if (resolved) {
      pendingEvalFile = { requested: option.value, resolved }
      msg.queue('nnue', {
        status: 'found',
        requested: option.value,
        resolved,
        cwd: engineCwd
      })
    }
  }

  try {
    await engine.exec(cmd)
    if (option) {
      await engine.waitForReady()
      const payload = { name: option.name, value: option.value }
      msg.queue('option-applied', payload)
      if (option.name === 'EvalFile') {
        const resolved = resolveEvalFilePath(option.value)
        pendingEvalFile = resolved ? { requested: option.value, resolved } : null
        msg.queue('nnue', {
          status: 'applied',
          requested: option.value,
          resolved,
          cwd: engineCwd
        })
      }
    }
  } catch (err) {
    msg.error(err.message)
    if (option && option.name === 'EvalFile') {
      msg.queue('nnue', {
        status: 'rejected',
        requested: option.value,
        resolved: resolveEvalFilePath(option.value),
        cwd: engineCwd,
        error: err.message
      })
    }
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

function scoreToCp (info) {
  if (!info) return null
  if (typeof info.cp === 'number') return info.cp
  if (typeof info.mate === 'number') return info.mate > 0 ? 100000 - info.mate : -100000 - info.mate
  return null
}

function scorePayload (info, perspective = 1) {
  if (!info) return {}
  const normalized = scoreToCp(info)
  return {
    cp: info.cp,
    mate: info.mate,
    normalized: normalized === null ? null : normalized * perspective
  }
}

function volatilityLabel (switches, drift, samples, sensitivity) {
  const sampleCount = Math.max(1, samples)
  const switchRate = switches / sampleCount
  const highDrift = Math.max(120, sensitivity * 1.8)
  if (drift >= highDrift || switchRate >= 0.45) return 'highly volatile'
  if (drift >= sensitivity || switchRate >= 0.20) return 'unstable'
  return 'stable'
}

function collectDeepSearch (positionCommand, goCommand, timeout, sensitivity, perspective = 1, displayPrefix = '') {
  return new Promise(resolve => {
    const samples = []
    let done = false
    let latest = null
    let maxDepth = 0
    let maxScore = null
    let minScore = null
    let bestMoveSwitches = 0
    let pvChanges = 0
    let previousBestMove = ''
    let previousPv = ''
    const startedAt = Date.now()
    const cleanup = () => {
      engine.events.off('info', listener)
      engine.events.off('bestmove', bestmoveListener)
      clearTimeout(timer)
    }
    const finish = bestmove => {
      if (done) return
      done = true
      cleanup()
      const elapsedMs = Date.now() - startedAt
      const rawFinalScore = scoreToCp(latest)
      const finalScore = rawFinalScore === null ? null : rawFinalScore * perspective
      const drift = maxScore !== null && minScore !== null ? Math.abs(maxScore - minScore) : 0
      resolve({
        bestmove,
        final: latest,
        finalScore: scorePayload(latest, perspective),
        maxScore,
        minScore,
        evalDrift: drift,
        depthReached: maxDepth,
        timeMs: elapsedMs,
        samples,
        sampleCount: samples.length,
        bestMoveSwitches,
        pvChanges,
        stability: volatilityLabel(bestMoveSwitches + pvChanges, drift, samples.length, sensitivity),
        uncertainty: volatilityLabel(bestMoveSwitches + pvChanges, drift, samples.length, sensitivity),
        flags: {
          highDisagreement: drift >= Math.max(80, sensitivity),
          lateImprovement: samples.length >= 2 && finalScore !== null && Math.abs(finalScore - samples[0].score.normalized) >= sensitivity,
          collapsedCandidate: finalScore !== null && samples.some(sample => sample.score.normalized !== null && sample.score.normalized - finalScore >= Math.max(120, sensitivity * 1.5))
        }
      })
    }
    const listener = info => {
      if (!('pv' in info)) return
      const firstMove = typeof info.pv === 'string' ? info.pv.split(/\s+/)[0] : ''
      const rawNormalized = scoreToCp(info)
      const normalized = rawNormalized === null ? null : rawNormalized * perspective
      latest = {
        cp: info.cp,
        mate: info.mate,
        pvUCI: info.pv,
        ucimove: firstMove,
        depth: info.depth,
        seldepth: info.seldepth,
        wdl: info.wdl,
        wdlWin: info.wdlWin,
        wdlDraw: info.wdlDraw,
        wdlLoss: info.wdlLoss
      }
      if (typeof info.depth === 'number') maxDepth = Math.max(maxDepth, info.depth)
      if (normalized !== null) {
        maxScore = maxScore === null ? normalized : Math.max(maxScore, normalized)
        minScore = minScore === null ? normalized : Math.min(minScore, normalized)
      }
      if (previousBestMove && firstMove && previousBestMove !== firstMove) bestMoveSwitches++
      if (previousPv && info.pv && previousPv !== info.pv) pvChanges++
      previousBestMove = firstMove || previousBestMove
      previousPv = info.pv || previousPv
      const displayPv = displayPrefix ? `${displayPrefix} ${info.pv || ''}`.trim() : info.pv
      msg.queue('info', {
        multipv: 1,
        cp: typeof info.cp === 'number' ? info.cp * perspective : info.cp,
        mate: typeof info.mate === 'number' ? info.mate * perspective : info.mate,
        pv: displayPv,
        depth: info.depth,
        seldepth: info.seldepth,
        wdl: info.wdl,
        wdlWin: info.wdlWin,
        wdlDraw: info.wdlDraw,
        wdlLoss: info.wdlLoss
      })
      samples.push({
        atMs: Date.now() - startedAt,
        depth: info.depth,
        seldepth: info.seldepth,
        bestMove: firstMove,
        pvUCI: info.pv,
        displayPvUCI: displayPv,
        score: scorePayload(info, perspective)
      })
    }
    const bestmoveListener = bestmove => finish(bestmove)
    const timer = setTimeout(() => {
      try { engine.exec('stop') } catch (err) {}
      finish(null)
    }, timeout)
    engine.events.on('info', listener)
    engine.events.once('bestmove', bestmoveListener)
    engine.exec(positionCommand)
    engine.exec(goCommand)
  })
}

function deepGoCommand (settings, candidateIndex) {
  const mode = settings.scheduleMode || 'equal'
  const depth = Number(settings.depthPerCandidate)
  let movetime = Number(settings.timePerCandidateMs) || 30000
  if (mode === 'top-short-secondary-long' && candidateIndex > 0) {
    movetime = Number(settings.secondaryTimeMs) || movetime
  }
  if (Number.isFinite(depth) && depth > 0) return `go depth ${depth}`
  return `go movetime ${Math.max(1000, movetime)}`
}

function mergeDeepResults (primary, extra, sensitivity) {
  const samples = primary.samples.concat(extra.samples || [])
  const maxScores = [primary.maxScore, extra.maxScore].filter(value => typeof value === 'number')
  const minScores = [primary.minScore, extra.minScore].filter(value => typeof value === 'number')
  const maxScore = maxScores.length ? Math.max(...maxScores) : null
  const minScore = minScores.length ? Math.min(...minScores) : null
  const drift = maxScore !== null && minScore !== null ? Math.abs(maxScore - minScore) : Math.max(primary.evalDrift || 0, extra.evalDrift || 0)
  return {
    ...primary,
    bestmove: extra.bestmove || primary.bestmove,
    final: extra.final || primary.final,
    finalScore: extra.finalScore || primary.finalScore,
    maxScore,
    minScore,
    evalDrift: drift,
    depthReached: Math.max(primary.depthReached || 0, extra.depthReached || 0),
    timeMs: (primary.timeMs || 0) + (extra.timeMs || 0),
    samples,
    sampleCount: samples.length,
    bestMoveSwitches: (primary.bestMoveSwitches || 0) + (extra.bestMoveSwitches || 0),
    pvChanges: (primary.pvChanges || 0) + (extra.pvChanges || 0),
    stability: volatilityLabel((primary.bestMoveSwitches || 0) + (extra.bestMoveSwitches || 0) + (primary.pvChanges || 0) + (extra.pvChanges || 0), drift, samples.length, sensitivity),
    uncertainty: volatilityLabel((primary.bestMoveSwitches || 0) + (extra.bestMoveSwitches || 0) + (primary.pvChanges || 0) + (extra.pvChanges || 0), drift, samples.length, sensitivity),
    flags: {
      highDisagreement: primary.flags.highDisagreement || extra.flags.highDisagreement,
      lateImprovement: primary.flags.lateImprovement || extra.flags.lateImprovement,
      collapsedCandidate: primary.flags.collapsedCandidate || extra.flags.collapsedCandidate,
      dynamicallyExtended: true
    }
  }
}

function candidateDiversityTag (item, rank) {
  if (!item) return 'engine candidate'
  if (typeof item.mate === 'number') return 'forcing / tactical'
  const score = scoreToCp(item)
  if (score !== null && Math.abs(score) >= 250) return score > 0 ? 'advantage conversion' : 'defensive resource'
  if (rank > 1) return 'alternative plan'
  return 'principal plan'
}

function selectDeepCandidates (root, count) {
  const seen = new Set()
  const candidates = []
  for (const item of root.candidates || []) {
    const move = item.ucimove || (typeof item.pvUCI === 'string' ? item.pvUCI.split(/\s+/)[0] : '')
    if (move && !seen.has(move)) {
      seen.add(move)
      candidates.push({ move, root: item, diversityTag: candidateDiversityTag(item, candidates.length + 1) })
    }
    if (candidates.length >= count) break
  }
  if (root.bestmove && !seen.has(root.bestmove) && candidates.length < count) {
    candidates.push({ move: root.bestmove, root: null, diversityTag: 'engine bestmove fallback' })
  }
  return candidates
}

async function deepAnalyze (payload) {
  deepAnalysisCancelled = false
  if (!engine) {
    msg.error('Engine not running')
    return
  }
  const settings = payload.settings || {}
  const fen = payload.fen
  const variant = payload.variant
  const candidateCount = Math.max(1, Math.min(Number(settings.candidateCount) || 3, 8))
  const rootTime = Math.max(1000, Number(settings.rootTimeMs) || 15000)
  const sensitivity = Math.max(20, Number(settings.instabilitySensitivityCp) || 80)
  const startedAt = Date.now()

  try {
    if (variant) await engine.exec(`setoption name UCI_Variant value ${variant}`)
    await engine.exec(`setoption name MultiPV value ${candidateCount}`)
    await engine.exec('setoption name UCI_ShowWDL value true')
    await engine.waitForReady()

    const root = await collectSearch(`position fen ${fen}`, `go movetime ${rootTime}`, rootTime + 5000)
    if (deepAnalysisCancelled) {
      msg.queue('deep-analysis', { error: 'Deep analysis cancelled', cancelled: true, fen, variant, settings, elapsedMs: Date.now() - startedAt })
      return
    }
    const selected = selectDeepCandidates(root, candidateCount)
    const results = []

    for (let idx = 0; idx < selected.length; idx++) {
      if (deepAnalysisCancelled) {
        msg.queue('deep-analysis', { error: 'Deep analysis cancelled', cancelled: true, fen, variant, settings, partial: results, elapsedMs: Date.now() - startedAt })
        return
      }
      const candidate = selected[idx]
      if (settings.clearHashBetweenCandidates) {
        await engine.exec('setoption name Clear Hash')
        await engine.waitForReady()
      }
      await engine.exec('setoption name MultiPV value 1')
      await engine.waitForReady()
      const goCommand = deepGoCommand(settings, idx)
      const timeout = (Number(settings.depthPerCandidate) > 0 ? Number(settings.maxDurationMs) || 300000 : Math.max(Number(settings.maxDurationMs) || 300000, (Number(settings.timePerCandidateMs) || 30000) + 5000))
      let analyzed = await collectDeepSearch(`position fen ${fen} moves ${candidate.move}`, goCommand, timeout, sensitivity, -1, candidate.move)
      if (deepAnalysisCancelled) {
        msg.queue('deep-analysis', { error: 'Deep analysis cancelled', cancelled: true, fen, variant, settings, partial: results, elapsedMs: Date.now() - startedAt })
        return
      }
      if (settings.scheduleMode === 'dynamic-instability' && analyzed.stability !== 'stable' && !(Number(settings.depthPerCandidate) > 0)) {
        const extensionMs = Math.min(Number(settings.maxDurationMs) || 300000, Number(settings.timePerCandidateMs) || 30000)
        const extra = await collectDeepSearch(`position fen ${fen} moves ${candidate.move}`, `go movetime ${extensionMs}`, extensionMs + 5000, sensitivity, -1, candidate.move)
        if (deepAnalysisCancelled) {
          msg.queue('deep-analysis', { error: 'Deep analysis cancelled', cancelled: true, fen, variant, settings, partial: results, elapsedMs: Date.now() - startedAt })
          return
        }
        analyzed = mergeDeepResults(analyzed, extra, sensitivity)
      }
      results.push({
        rank: idx + 1,
        move: candidate.move,
        initialRank: idx + 1,
        diversityTag: candidate.diversityTag,
        initial: candidate.root,
        ...analyzed
      })
    }

    const ranked = results.slice().sort((a, b) => {
      const bScore = b.finalScore && typeof b.finalScore.normalized === 'number' ? b.finalScore.normalized : -Infinity
      const aScore = a.finalScore && typeof a.finalScore.normalized === 'number' ? a.finalScore.normalized : -Infinity
      return bScore - aScore
    })
    ranked.forEach((item, idx) => { item.finalRank = idx + 1; item.rankingChange = item.initialRank - item.finalRank })

    msg.queue('deep-analysis', {
      fen,
      variant,
      settings,
      root,
      candidates: ranked,
      startedAt,
      completedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      summary: {
        candidateCount: ranked.length,
        volatileCount: ranked.filter(item => item.stability !== 'stable').length,
        bestMove: ranked[0] ? ranked[0].move : '',
        clearHash: !!settings.clearHashBetweenCandidates,
        diversityTags: Array.from(new Set(ranked.map(item => item.diversityTag).filter(Boolean))),
        diversityThresholdMet: Array.from(new Set(ranked.map(item => item.diversityTag).filter(Boolean))).length >= (Number(settings.diversityThreshold) || 1)
      }
    })
  } catch (err) {
    msg.queue('deep-analysis', { error: err.message, fen, variant, settings, elapsedMs: Date.now() - startedAt })
  }
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
    case 'deep-analysis':
      deepAnalyze(payload)
      break
  }
})
