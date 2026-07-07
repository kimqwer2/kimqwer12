import fs from 'fs'
import path from 'path'
import { app } from 'electron'

const futureExplorerPath = path.join(app.getPath('userData'), 'futureExplorer.json')
const SCHEMA_VERSION = 1

function emptyFutureExplorerData () {
  return {
    schemaVersion: SCHEMA_VERSION,
    rootFen: '',
    rootKey: '',
    openings: {},
    groups: {},
    lastSignature: '',
    activePositionRootKey: '',
    currentGameKey: '',
    nextGameIndex: 1
  }
}

function normalizeFutureExplorerData (data) {
  const next = emptyFutureExplorerData()
  if (!data || typeof data !== 'object') return next
  next.rootFen = data.rootFen || ''
  next.rootKey = data.rootKey || ''
  next.lastSignature = data.lastSignature || ''
  next.activePositionRootKey = data.activePositionRootKey || ''
  next.currentGameKey = data.currentGameKey || ''
  next.nextGameIndex = Math.max(1, Number(data.nextGameIndex) || 1)
  if (data.openings && typeof data.openings === 'object') {
    next.openings = Object.keys(data.openings).reduce((acc, key) => {
      const opening = data.openings[key]
      acc[key] = opening && typeof opening === 'object' ? { ...opening, name: opening.name || '', autoName: opening.autoName || '' } : opening
      return acc
    }, {})
  }
  if (data.groups && typeof data.groups === 'object') {
    next.groups = data.groups
  }
  return next
}

export function loadFutureExplorerData () {
  if (!fs.existsSync(futureExplorerPath)) return emptyFutureExplorerData()
  return normalizeFutureExplorerData(JSON.parse(fs.readFileSync(futureExplorerPath, 'utf8')))
}

export function saveFutureExplorerData (data) {
  const payload = normalizeFutureExplorerData(data)
  fs.writeFileSync(futureExplorerPath, JSON.stringify(payload, null, 2), 'utf8')
  return payload
}

export function clearFutureExplorerData () {
  if (fs.existsSync(futureExplorerPath)) fs.unlinkSync(futureExplorerPath)
  return emptyFutureExplorerData()
}
