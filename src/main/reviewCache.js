import path from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'

const dbPath = path.join(app.getPath('userData'), 'review-cache.db')
const db = new Database(dbPath, { verbose: console.log })
db.pragma('journal_mode = WAL')

export function createReviewSchema () {
  const ddl = db.prepare(`
    CREATE TABLE IF NOT EXISTS review_cache (
      request_key TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      service_version TEXT NOT NULL,
      result_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return ddl.run()
}

export function getReviewResult (requestKey) {
  const select = db.prepare(`
    SELECT result_json FROM review_cache
    WHERE request_key = ?;
  `)
  const row = select.get(requestKey)
  if (!row) return null
  return JSON.parse(row.result_json)
}

export function insertReviewResult (requestKey, result) {
  const insert = db.prepare(`
    INSERT INTO review_cache (request_key, schema_version, service_version, result_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(request_key) DO UPDATE SET
      schema_version = excluded.schema_version,
      service_version = excluded.service_version,
      result_json = excluded.result_json,
      updated_at = excluded.updated_at;
  `)
  return insert.run(
    requestKey,
    result.schemaVersion,
    result.serviceVersion,
    JSON.stringify(result),
    Date.now()
  )
}
