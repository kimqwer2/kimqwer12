import fs from 'fs'
import path from 'path'
import { app } from 'electron'

const appDataPath = app.getPath('userData')
const savedGamesPath = path.join(appDataPath, 'savedGames.json')
const savedGamesDir = path.join(appDataPath, 'saved-games')

function ensureSavedGamesDir () {
  if (!fs.existsSync(savedGamesDir)) fs.mkdirSync(savedGamesDir, { recursive: true })
}

function safeFileName (name) {
  const base = String(name || 'Saved Game').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'Saved Game'
  return base.slice(0, 80)
}

function gamePathFor (name, savedAt = new Date().toISOString()) {
  ensureSavedGamesDir()
  const stamp = savedAt.replace(/[:.]/g, '-').replace(/Z$/, '')
  return path.join(savedGamesDir, `${stamp}-${safeFileName(name)}.json`)
}

function readJsonFile (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function normalizeSavedGame (game, filePath) {
  const metadata = game && game.metadata ? game.metadata : {}
  const moves = Array.isArray(game && game.moves) ? game.moves : []
  return {
    id: game.id || path.basename(filePath, path.extname(filePath)),
    filePath,
    name: metadata.name || game.name || 'Untitled Game',
    savedAt: metadata.savedAt || game.savedAt || '',
    updatedAt: metadata.updatedAt || metadata.savedAt || game.updatedAt || '',
    moveCount: Number(metadata.moveCount || moves.length || 0),
    result: metadata.result || '*',
    variant: game.variant || metadata.variant || 'janggi',
    startFen: game.startFen || ''
  }
}

export function clearAllGamePaths () {
  try {
    fs.writeFileSync(savedGamesPath, JSON.stringify({ games: [] }, null, 2), 'utf8')
    return true
  } catch (error) {
    console.error('Error clearing all game paths:', error)
    return false
  }
}

/**
 * Load all saved game file paths
 */
export function loadSavedGamePaths () {
  try {
    if (fs.existsSync(savedGamesPath)) {
      const data = fs.readFileSync(savedGamesPath, 'utf8')
      return JSON.parse(data)
    }
  } catch (error) {
    console.error('Error loading saved game paths:', error)
  }
  return { games: [] }
}
/**
 * Save a game file path to the registry
 */
export function addGamePath (filePath) {
  try {
    const data = loadSavedGamePaths()
    // Check if path already exists
    if (!data.games.includes(filePath)) {
      data.games.push(filePath)
      fs.writeFileSync(savedGamesPath, JSON.stringify(data, null, 2), 'utf8')
    }
    return true
  } catch (error) {
    console.error('Error adding game path:', error)
    return false
  }
}
/**
 * Remove a game file path from the registry
 */
export function removeGamePath (filePath) {
  try {
    const data = loadSavedGamePaths()
    data.games = data.games.filter(p => p !== filePath)
    fs.writeFileSync(savedGamesPath, JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch (error) {
    console.error('Error removing game path:', error)
    return false
  }
}
/**
 * Get all saved game file paths
 */
export function getAllSavedGamePaths () {
  const data = loadSavedGamePaths()
  const existingPaths = []
  for (const filePath of data.games) {
    try {
      if (fs.existsSync(filePath)) {
        existingPaths.push(filePath)
      } else {
        // File no longer exists, remove it from the list
        removeGamePath(filePath)
      }
    } catch (error) {
      console.error(`Error checking game file ${filePath}:`, error)
    }
  }
  return existingPaths
}

export function listSavedGameLibrary () {
  ensureSavedGamesDir()
  const libraryGames = fs.readdirSync(savedGamesDir)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(savedGamesDir, name))
    .map(filePath => {
      try {
        return normalizeSavedGame(readJsonFile(filePath), filePath)
      } catch (error) {
        console.error(`Error reading saved game ${filePath}:`, error)
        return null
      }
    })
    .filter(Boolean)
  const externalGames = getAllSavedGamePaths()
    .filter(filePath => filePath.endsWith('.json') && !filePath.startsWith(savedGamesDir))
    .map(filePath => {
      try {
        return normalizeSavedGame(readJsonFile(filePath), filePath)
      } catch (error) {
        return null
      }
    })
    .filter(Boolean)
  return [...libraryGames, ...externalGames].sort((a, b) => String(b.savedAt || b.updatedAt).localeCompare(String(a.savedAt || a.updatedAt)))
}

export function saveGameToLibrary (game) {
  const savedAt = (game.metadata && game.metadata.savedAt) || new Date().toISOString()
  const metadata = {
    ...(game.metadata || {}),
    name: (game.metadata && game.metadata.name) || game.name || 'Untitled Game',
    savedAt,
    updatedAt: new Date().toISOString(),
    moveCount: Array.isArray(game.moves) ? game.moves.length : 0,
    result: (game.metadata && game.metadata.result) || '*',
    variant: game.variant || (game.metadata && game.metadata.variant) || 'janggi'
  }
  const payload = {
    schemaVersion: 1,
    id: game.id || `${Date.now()}`,
    variant: game.variant || metadata.variant,
    startFen: game.startFen || '',
    moves: Array.isArray(game.moves) ? game.moves : [],
    metadata,
    gameInfo: game.gameInfo || {},
    comments: game.comments || {},
    analysis: game.analysis || {},
    review: game.review || null
  }
  const filePath = game.filePath || gamePathFor(metadata.name, savedAt)
  ensureSavedGamesDir()
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
  addGamePath(filePath)
  return normalizeSavedGame(payload, filePath)
}

export function readSavedGame (filePath) {
  const game = readJsonFile(filePath)
  return { ...game, filePath }
}

export function renameSavedGame (filePath, name) {
  const game = readJsonFile(filePath)
  game.metadata = { ...(game.metadata || {}), name: String(name || '').trim() || 'Untitled Game', updatedAt: new Date().toISOString() }
  fs.writeFileSync(filePath, JSON.stringify(game, null, 2), 'utf8')
  return normalizeSavedGame(game, filePath)
}

export function deleteSavedGame (filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  removeGamePath(filePath)
  return true
}

export function savedGamesDirectory () {
  ensureSavedGamesDir()
  return savedGamesDir
}
