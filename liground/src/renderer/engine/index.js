import { EventEmitter } from 'events'
import EngineWorker from './engine.worker.js'

function arrayify (data) {
  return Array.isArray(data) ? data : [data]
}

const ENGINE_TRACE_ENABLED = typeof process !== 'undefined' && process.env && process.env.LIGROUND_ENGINE_TRACE === '1'
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1000
let nextEngineInstanceId = 1

/**
 * Class to handle communication with engine.
 * Emits `debug`, `error`, `io`, `info` events.
 */
export class Engine extends EventEmitter {
  constructor (...args) {
    super(...args)

    /** @type {Worker} */
    this.mainWorker = new EngineWorker()
    this.instanceId = `engine-${nextEngineInstanceId++}`

    // create global listener to emit events based on received messages
    this.mainWorker.addEventListener('message', ({ data }) => {
      if (data.type === 'cache') {
        const { pv, io, info, events } = data
        for (const line of pv) {
          if (line) {
            this.emit('info', line)
          }
        }
        if (Object.keys(info).length > 0) {
          this.emit('info', info)
        }
        if (io.length > 0) {
          this.emit('io', io)
        }
        for (const { type, payload } of events) {
          this.emit(type, ...arrayify(payload))
        }
      } else {
        this.emit(data.type, ...arrayify(data.payload))
      }
    })

    // second thread for evaluation only
    /** @type {Worker} */
    this.evalWorker = new EngineWorker()
    this.deepAnalysisActive = false
    this.evalRequestSeq = 0
    this.optionState = {}
    this.mainRequestSeq = 0
    this.evalJobs = []
    this.activeEvalJob = null
    this.evalWorker.addEventListener('message', ({ data }) => {
      if (data.type === 'cache') {
        if (this.deepAnalysisActive) {
          const { pv, info } = data
          for (const line of pv) {
            if (line) {
              this.emit('info', line)
            }
          }
          if (Object.keys(info).length > 0) {
            this.emit('info', info)
          }
        }
      } else {
        this.emit(`eval-${data.type}`, ...arrayify(data.payload))
      }
    })
  }

  /**
   * Start the engine process.
   * @param {string} binary path to engine binary to run
   * @param {string} cwd working directory to run the engine in
   */
  run (binary, cwd) {
    this.cancelEvaluationJobs('Engine restarting')
    return new Promise((resolve, reject) => {
      const startupId = `${this.instanceId}-startup-${Date.now()}`
      let mainInfo = null
      let evalActive = false
      let settled = false
      let evalListener = null
      const mainActive = info => {
        mainInfo = info
        maybeResolve()
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.off('startup-failed', startupFailed)
        this.off('active', mainActive)
        if (evalListener) this.evalWorker.removeEventListener('message', evalListener)
      }
      const startupFailed = failure => {
        if (!failure || failure.requestId !== startupId || settled) return
        settled = true
        cleanup()
        reject(Object.assign(new Error(failure.error || 'Engine startup failed'), { requestId: startupId, engineInstanceId: this.instanceId }))
      }
      const timeout = setTimeout(() => startupFailed({ requestId: startupId, error: `Engine startup timed out for ${binary}` }), 30000)
      this.on('startup-failed', startupFailed)
      const maybeResolve = () => {
        if (!settled && mainInfo && evalActive) {
          settled = true
          cleanup()
          this._applyOptionSnapshotToWorkers()
          resolve(mainInfo)
        }
      }
      const isActiveMessage = data => data.type === 'active' || (data.type === 'cache' && data.events.find(event => event.type === 'active'))

      this.once('active', mainActive)

      // run main engine
      this.mainWorker.postMessage({
        payload: { binary, cwd, listeners: ['io', 'info', 'bestmove'], requestId: startupId },
        type: 'run'
      })

      // run eval engine
      this.evalWorker.postMessage({
        payload: { binary, cwd, listeners: [], requestId: startupId },
        type: 'run'
      })

      // initialize eval engine options after its UCI init/ready cycle is complete
      evalListener = ({ data }) => {
        if (isActiveMessage(data)) {
          this.evalWorker.removeEventListener('message', evalListener)
          const options = {
            UCI_AnalyseMode: 'true',
            'Analysis Contempt': 'Off'
          }
          for (const [name, value] of Object.entries(options)) {
            this.evalWorker.postMessage({
              payload: `setoption name ${name} value ${value}`,
              type: 'cmd'
            })
          }
          evalActive = true
          maybeResolve()
        }
      }
      this.evalWorker.addEventListener('message', evalListener)
    })
  }

  /**
   * Send an UCI command to the engine process.
   * @param {string} command UCI command
   */
  send (command) {
    if (ENGINE_TRACE_ENABLED) try {
      const line = typeof command === 'string' ? command.trim() : String(command)
      if (line) {
        console.log('[engine-cmd-trace]', line)
      }
    } catch (err) {}
    this._trackOptionFromCommand(command)
    this.mainWorker.postMessage({
      payload: command,
      type: 'cmd'
    })
    if (this._shouldMirrorCommandToEval(command)) {
      this.evalWorker.postMessage({
        payload: command,
        type: 'cmd'
      })
    }
  }

  stopMainSearch (timeoutMs = 5000) {
    const requestId = `${this.instanceId}-barrier-${++this.mainRequestSeq}`
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.mainWorker.removeEventListener('message', handler)
        if (error) reject(Object.assign(new Error(error), { requestId }))
        else resolve({ requestId, engineInstanceId: this.instanceId, status: 'cancelled' })
      }
      const handler = ({ data }) => {
        if (data.type !== 'cache') return
        const event = (data.events || []).find(item => item.type === 'barrier' && item.payload && item.payload.requestId === requestId)
        if (event) finish(event.payload.error)
      }
      const timer = setTimeout(() => finish('Engine stop barrier timed out'), timeoutMs)
      this.mainWorker.addEventListener('message', handler)
      this.mainWorker.postMessage({ type: 'barrier', payload: { requestId } })
    })
  }

  _shouldMirrorCommandToEval (command) {
    if (typeof command !== 'string') return false
    const lower = command.toLowerCase().trim()
    return lower === 'quit'
  }

  _trackOptionFromCommand (command) {
    if (typeof command !== 'string') return
    const match = command.trim().match(/^setoption\s+name\s+(.+?)(?:\s+value\s+(.+))?$/i)
    if (!match) return
    const name = match[1].trim()
    const value = match[2] !== undefined ? match[2].trim() : null
    this.optionState[name] = value
  }

  _applyOptionSnapshotToWorkers () {
    const entries = Object.entries(this.optionState || {})
    if (!entries.length) return
    this.emit('debug', '[engine-option-sync] applying snapshot to workers', { count: entries.length, options: this.optionState })
    for (const [name, value] of entries) {
      const payload = value === null
        ? `setoption name ${name}`
        : `setoption name ${name} value ${value}`
      this.mainWorker.postMessage({ payload, type: 'cmd' })
      this.evalWorker.postMessage({ payload, type: 'cmd' })
    }
  }

  /**
   * Evaluate a position.
   * @param {string} fen FEN position
   * @param {number} depth search depth
   * @returns {Promise<string>} score in cp or mate
   */
  evaluate (fen, depth) {
    return this._enqueueEvalJob('eval', 'evaluated', { fen, depth }, Math.max(20000, Number(depth) * 5000))
  }

  /**
   * Run an engine-backed review search on the eval worker.
   * @param {Object} request review request containing fen, move, and line
   * @returns {Promise<Object>} structured engine evidence
   */
  reviewAnalysis (request) {
    return this._enqueueEvalJob('review', 'reviewed', request, DEFAULT_JOB_TIMEOUT_MS)
  }

  /**
   * Run supervised deep analysis on the eval worker.
   * @param {Object} request deep-analysis request
   * @returns {Promise<Object>} structured deep analysis report
   */
  deepAnalysis (request) {
    return this._enqueueEvalJob('deep-analysis', 'deep-analysis', request, Number(request && request.settings && request.settings.maxDurationMs) || DEFAULT_JOB_TIMEOUT_MS)
  }

  _enqueueEvalJob (type, resultType, payload, timeoutMs) {
    const requestId = `${this.instanceId}-eval-${++this.evalRequestSeq}`
    return new Promise((resolve, reject) => {
      this.evalJobs.push({ requestId, type, resultType, payload, timeoutMs, resolve, reject, status: 'queued' })
      this._runNextEvalJob()
    })
  }

  _runNextEvalJob () {
    if (this.activeEvalJob || !this.evalJobs.length) return
    const job = this.evalJobs.shift()
    this.activeEvalJob = job
    job.status = 'running'
    this.deepAnalysisActive = job.type === 'deep-analysis'
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      this.evalWorker.removeEventListener('message', handler)
      job.status = error ? (error.cancelled ? 'cancelled' : 'failed') : 'completed'
      this.activeEvalJob = null
      this.deepAnalysisActive = false
      if (error) job.reject(error)
      else job.resolve(result)
      this._runNextEvalJob()
    }
    const handler = ({ data }) => {
      if (data.type !== 'cache') return
      for (const event of data.events || []) {
        if (event.type !== job.resultType || !event.payload || event.payload.requestId !== job.requestId) continue
        const result = event.payload.result
        if (job.terminalError) finish(job.terminalError)
        else if (result && result.error && result.failed) finish(Object.assign(new Error(result.error), { requestId: job.requestId }))
        else finish(null, result)
      }
    }
    let timer = setTimeout(() => {
      job.terminalError = Object.assign(new Error(`${job.type} request timed out`), { requestId: job.requestId })
      this.evalWorker.postMessage({ type: 'cancel-job', payload: { requestId: job.requestId } })
      timer = setTimeout(() => finish(job.terminalError), 5000)
    }, Math.max(1000, Number(job.timeoutMs) || DEFAULT_JOB_TIMEOUT_MS))
    this.evalWorker.addEventListener('message', handler)
    this.evalWorker.postMessage({ type: job.type, payload: { ...job.payload, requestId: job.requestId, optionSnapshot: { ...this.optionState } } })
  }

  cancelEvaluationJobs (reason = 'cancelled') {
    const errorFor = requestId => Object.assign(new Error(reason), { requestId, cancelled: true })
    for (const job of this.evalJobs.splice(0)) {
      job.status = 'cancelled'
      job.reject(errorFor(job.requestId))
    }
    if (this.activeEvalJob) {
      const job = this.activeEvalJob
      job.terminalError = errorFor(job.requestId)
      this.evalWorker.postMessage({ type: 'cancel-job', payload: { requestId: job.requestId } })
    }
  }

}
export const engine = new Engine()
