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

export async function loadFutureExplorerData () {
  try {
    const contents = await fs.promises.readFile(futureExplorerPath, 'utf8')
    return normalizeFutureExplorerData(JSON.parse(contents))
  } catch (err) {
    if (err.code === 'ENOENT') return emptyFutureExplorerData()
    if (err instanceof SyntaxError) {
      await fs.promises.rename(futureExplorerPath, `${futureExplorerPath}.corrupt-${Date.now()}`).catch(() => {})
      return emptyFutureExplorerData()
    }
    throw err
  }
}

export async function saveFutureExplorerData (data) {
  const payload = normalizeFutureExplorerData(data)
  const temporaryPath = `${futureExplorerPath}.tmp`
  await fs.promises.writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf8')
  await fs.promises.rename(temporaryPath, futureExplorerPath)
  return payload
}

export async function clearFutureExplorerData () {
  await fs.promises.unlink(futureExplorerPath).catch(err => {
    if (err.code !== 'ENOENT') throw err
  })
  return emptyFutureExplorerData()
}
