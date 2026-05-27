import { EventEmitter } from 'events'
import EngineWorker from './engine.worker.js'

function arrayify (data) {
  return Array.isArray(data) ? data : [data]
}

/**
 * Class to handle communication with engine.
 * Emits `debug`, `error`, `io`, `info` events.
 */
export class Engine extends EventEmitter {
  constructor (...args) {
    super(...args)

    /** @type {Worker} */
    this.mainWorker = new EngineWorker()

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
    this.reviewRequestSeq = 0
    this.deepRequestSeq = 0
    this.optionState = {}
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
    return new Promise(resolve => {
      let mainInfo = null
      let evalActive = false
      const maybeResolve = () => {
        if (mainInfo && evalActive) {
          this._applyOptionSnapshotToWorkers()
          resolve(mainInfo)
        }
      }
      const isActiveMessage = data => data.type === 'active' || (data.type === 'cache' && data.events.find(event => event.type === 'active'))

      this.once('active', info => {
        mainInfo = info
        maybeResolve()
      })

      // run main engine
      this.mainWorker.postMessage({
        payload: { binary, cwd, listeners: ['io', 'info', 'bestmove'] },
        type: 'run'
      })

      // run eval engine
      this.evalWorker.postMessage({
        payload: { binary, cwd, listeners: [] },
        type: 'run'
      })

      // initialize eval engine options after its UCI init/ready cycle is complete
      const listener = ({ data }) => {
        if (isActiveMessage(data)) {
          this.evalWorker.removeEventListener('message', listener)
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
      this.evalWorker.addEventListener('message', listener)
    })
  }

  /**
   * Send an UCI command to the engine process.
   * @param {string} command UCI command
   */
  send (command) {
    try {
      const line = typeof command === 'string' ? command.trim() : String(command)
      if (line) {
        console.log('[engine-cmd-trace]', line)
      }
    } catch (err) {}
    this._trackOptionFromCommand(command)
    if (typeof command === 'string' && command.trim().toLowerCase().startsWith('setoption ')) {
      // Keep option application deterministic for the eval/review worker:
      // stop any ongoing background search before applying mutable UCI options
      // like Threads/Hash/EvalFile to avoid "apply later" drift.
      this.evalWorker.postMessage({
        payload: 'stop',
        type: 'cmd'
      })
    }
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

  _shouldMirrorCommandToEval (command) {
    if (typeof command !== 'string') return false
    const lower = command.toLowerCase().trim()
    return lower.startsWith('setoption ') ||
      lower === 'stop' ||
      lower.startsWith('ucinewgame') ||
      lower.includes('uci_variant') ||
      lower.includes('evalfile')
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
    return new Promise(resolve => {
      this.evalWorker.onmessage = ({ data }) => {
        if (data.type === 'cache') {
          for (const { type, payload } of data.events) {
            if (type === 'evaluated') {
              resolve(payload)
              delete this.evalWorker.onmessage
            }
          }
        }
      }
      this.evalWorker.postMessage({
        payload: { fen, depth },
        type: 'eval'
      })
    })
  }

  /**
   * Run an engine-backed review search on the eval worker.
   * @param {Object} request review request containing fen, move, and line
   * @returns {Promise<Object>} structured engine evidence
   */
  reviewAnalysis (request) {
    const seq = ++this.reviewRequestSeq
    this.evalWorker.postMessage({ type: 'cancel-review' })
    return new Promise(resolve => {
      const handler = ({ data }) => {
        if (data.type !== 'cache') return
        for (const { type, payload } of data.events) {
          if (type === 'reviewed') {
            if (seq === this.reviewRequestSeq) resolve(payload)
            this.evalWorker.removeEventListener('message', handler)
            return
          }
        }
      }
      this.evalWorker.addEventListener('message', handler)
      this.evalWorker.postMessage({
        payload: request,
        type: 'review'
      })
    })
  }

  /**
   * Run supervised deep analysis on the eval worker.
   * @param {Object} request deep-analysis request
   * @returns {Promise<Object>} structured deep analysis report
   */
  deepAnalysis (request) {
    const seq = ++this.deepRequestSeq
    this.deepAnalysisActive = true
    return new Promise(resolve => {
      const handler = ({ data }) => {
        if (data.type !== 'cache') return
        for (const { type, payload } of data.events) {
          if (type === 'deep-analysis') {
            this.deepAnalysisActive = false
            if (seq === this.deepRequestSeq) resolve(payload)
            this.evalWorker.removeEventListener('message', handler)
            return
          }
        }
      }
      this.evalWorker.addEventListener('message', handler)
      this.evalWorker.postMessage({
        payload: request,
        type: 'deep-analysis'
      })
    })
  }

}
export const engine = new Engine()
