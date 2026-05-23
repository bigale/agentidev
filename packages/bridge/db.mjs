/**
 * SQLite wrapper for bridge-side persistence.
 * Stores script runs, artifacts, and IDB store exports.
 * Database lives at ~/.agentidev/data.sqlite
 */

import Database from 'better-sqlite3';
import { resolve as pathResolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = pathResolve(homedir(), '.agentidev');
const DB_PATH  = pathResolve(DATA_DIR, 'data.sqlite');

let _db = null;
let _activeDbPath = null;

/**
 * Open (or create) the SQLite database and run schema migrations.
 * Safe to call multiple times — idempotent (returns the cached connection on
 * subsequent calls). Tests can pass `{ dbPath }` to direct the singleton at a
 * temp file; production callers pass nothing and get `~/.agentidev/data.sqlite`.
 */
export function initDB(opts = {}) {
  if (_db) return _db;

  const dbPath = opts.dbPath || DB_PATH;
  const dataDir = pathResolve(dbPath, '..');
  mkdirSync(dataDir, { recursive: true });
  _db = new Database(dbPath);
  _activeDbPath = dbPath;

  // WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS script_runs (
      script_id      TEXT PRIMARY KEY,
      name           TEXT,
      state          TEXT,
      started_at     INTEGER,
      completed_at   INTEGER,
      duration_ms    INTEGER,
      step           INTEGER,
      total_steps    INTEGER,
      errors         INTEGER,
      session_id     TEXT,
      artifact_count INTEGER,
      synced_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS script_artifacts (
      id           TEXT PRIMARY KEY,
      run_id       TEXT,
      type         TEXT,
      label        TEXT,
      disk_path    TEXT,
      size         INTEGER,
      content_type TEXT,
      timestamp    INTEGER
    );

    CREATE TABLE IF NOT EXISTS idb_stores (
      store       TEXT    NOT NULL,
      record_id   TEXT    NOT NULL,
      data        TEXT    NOT NULL,
      synced_at   INTEGER,
      PRIMARY KEY (store, record_id)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_started   ON script_runs (started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_run  ON script_artifacts (run_id);
    CREATE INDEX IF NOT EXISTS idx_idb_store      ON idb_stores (store);
  `);

  console.log(`[DB] SQLite opened: ${_activeDbPath}`);
  return _db;
}

function db() {
  if (!_db) initDB();
  return _db;
}

// ---------------------------------------------------------------------------
// Script Runs
// ---------------------------------------------------------------------------

const _upsertRun = () => db().prepare(`
  INSERT INTO script_runs
    (script_id, name, state, started_at, completed_at, duration_ms,
     step, total_steps, errors, session_id, artifact_count, synced_at)
  VALUES
    (@scriptId, @name, @state, @startedAt, @completedAt, @durationMs,
     @step, @totalSteps, @errors, @sessionId, @artifactCount, @syncedAt)
  ON CONFLICT(script_id) DO UPDATE SET
    name           = excluded.name,
    state          = excluded.state,
    started_at     = excluded.started_at,
    completed_at   = excluded.completed_at,
    duration_ms    = excluded.duration_ms,
    step           = excluded.step,
    total_steps    = excluded.total_steps,
    errors         = excluded.errors,
    session_id     = excluded.session_id,
    artifact_count = excluded.artifact_count,
    synced_at      = excluded.synced_at
`);

/** Upsert a script run record. */
export function saveRun(run) {
  _upsertRun().run({
    scriptId:      run.scriptId,
    name:          run.name          || null,
    state:         run.state         || null,
    startedAt:     run.startedAt     || null,
    completedAt:   run.completedAt   || null,
    durationMs:    run.durationMs    || null,
    step:          run.step          ?? null,
    totalSteps:    run.totalSteps    ?? null,
    errors:        run.errors        ?? 0,
    sessionId:     run.sessionId     || null,
    artifactCount: run.artifactCount ?? 0,
    syncedAt:      Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Script Artifacts
// ---------------------------------------------------------------------------

const _upsertArtifact = () => db().prepare(`
  INSERT INTO script_artifacts
    (id, run_id, type, label, disk_path, size, content_type, timestamp)
  VALUES
    (@id, @runId, @type, @label, @diskPath, @size, @contentType, @timestamp)
  ON CONFLICT(id) DO UPDATE SET
    run_id       = excluded.run_id,
    type         = excluded.type,
    label        = excluded.label,
    disk_path    = excluded.disk_path,
    size         = excluded.size,
    content_type = excluded.content_type,
    timestamp    = excluded.timestamp
`);

/** Upsert an artifact record. `artifact` should have {runId, type, label, diskPath, size, contentType, timestamp}. */
export function saveArtifact(artifact) {
  const id = `${artifact.runId}_${artifact.timestamp}_${artifact.type}`;
  _upsertArtifact().run({
    id,
    runId:       artifact.runId        || null,
    type:        artifact.type         || null,
    label:       artifact.label        || null,
    diskPath:    artifact.diskPath      || null,
    size:        artifact.size         ?? 0,
    contentType: artifact.contentType  || null,
    timestamp:   artifact.timestamp    || Date.now(),
  });
}

// ---------------------------------------------------------------------------
// IDB Store Export (Recipes, NotesDS, etc.)
// ---------------------------------------------------------------------------

const _upsertStoreRecord = () => db().prepare(`
  INSERT INTO idb_stores (store, record_id, data, synced_at)
  VALUES (@store, @recordId, @data, @syncedAt)
  ON CONFLICT(store, record_id) DO UPDATE SET
    data      = excluded.data,
    synced_at = excluded.synced_at
`);

/**
 * Bulk-upsert records for a named IDB store.
 * @param {string} storeName
 * @param {Array<object>} records - Each record should have an `id` or `_id` field.
 */
export function upsertStore(storeName, records) {
  const stmt = _upsertStoreRecord();
  const insertMany = db().transaction((recs) => {
    for (const rec of recs) {
      const recordId = String(rec.id ?? rec._id ?? rec.scriptId ?? JSON.stringify(rec).slice(0, 64));
      stmt.run({
        store:    storeName,
        recordId,
        data:     JSON.stringify(rec),
        syncedAt: Date.now(),
      });
    }
  });
  insertMany(records);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List script runs, newest first. */
export function listRuns(criteria = {}) {
  const { limit = 200, name, state } = criteria;
  let sql = 'SELECT * FROM script_runs';
  const params = [];
  const where = [];
  if (name)  { where.push('name = ?');  params.push(name);  }
  if (state) { where.push('state = ?'); params.push(state); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);
  return db().prepare(sql).all(...params);
}

/** Get all artifact rows for a given run. */
export function getArtifacts(runId) {
  return db().prepare('SELECT * FROM script_artifacts WHERE run_id = ? ORDER BY timestamp ASC').all(runId);
}

/**
 * Return a run record joined with its artifact rows. Returns null if no run
 * matches `scriptId`. Artifacts are ordered by timestamp ASC (same as
 * `getArtifacts`). Used by the `script:run` CLI to render a completed run's
 * full state from SQLite — no in-memory bridge state required.
 */
export function getRunWithArtifacts(scriptId) {
  const run = db()
    .prepare('SELECT * FROM script_runs WHERE script_id = ?')
    .get(scriptId);
  if (!run) return null;
  const artifacts = getArtifacts(scriptId);
  return { run, artifacts };
}

// ---------------------------------------------------------------------------
// Inline artifact disk persistence
// ---------------------------------------------------------------------------

// Pick a sensible file extension from a contentType. Falls back to .bin so the
// artifact is still readable as binary if the type is unknown.
const _EXT_BY_CONTENT_TYPE = {
  'application/json': '.json',
  'text/plain':       '.txt',
  'text/markdown':    '.md',
  'text/html':        '.html',
  'text/csv':         '.csv',
  'image/png':        '.png',
  'image/jpeg':       '.jpg',
  'image/gif':        '.gif',
  'video/webm':       '.webm',
  'application/zip':  '.zip',
};

function _pickExt(artifact) {
  const ct = (artifact.contentType || '').toLowerCase();
  return _EXT_BY_CONTENT_TYPE[ct] || '.bin';
}

function _sanitizeLabel(label) {
  return String(label || 'artifact')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'artifact';
}

/**
 * Write an inline-data artifact to disk under `<artifactsDir>/<scriptId>/`
 * and return the resolved file path. The bridge calls this on
 * BRIDGE_SCRIPT_ADD_ARTIFACT so SQLite's disk_path column is populated for
 * inline artifacts the same way it is for filePath-based ones — making them
 * recoverable after a bridge restart via the existing
 * BRIDGE_SCRIPT_GET_ARTIFACT contract.
 *
 * @param {object} artifact - { type, label, data, contentType, timestamp }.
 * @param {string} scriptId
 * @param {string} artifactsDir - absolute path to the artifacts root.
 * @returns {string} absolute path to the written file.
 */
export function persistInlineArtifact(artifact, scriptId, artifactsDir) {
  const ts = artifact.timestamp || Date.now();
  const dir = pathResolve(artifactsDir, scriptId);
  mkdirSync(dir, { recursive: true });
  const ext = _pickExt(artifact);
  const label = _sanitizeLabel(artifact.label || artifact.type);
  const filename = `${artifact.type || 'artifact'}_${label}_${ts}${ext}`;
  const diskPath = pathResolve(dir, filename);
  writeFileSync(diskPath, artifact.data ?? '');
  return diskPath;
}

/** Get all records for a named IDB store. */
export function getStore(storeName) {
  return db()
    .prepare('SELECT record_id, data, synced_at FROM idb_stores WHERE store = ? ORDER BY synced_at DESC')
    .all(storeName)
    .map(row => ({ recordId: row.record_id, data: JSON.parse(row.data), syncedAt: row.synced_at }));
}

// ---------------------------------------------------------------------------
// Full export (for JSON backup / restore payload)
// ---------------------------------------------------------------------------

/**
 * Returns all data from SQLite as plain objects.
 * @returns {{ script_runs: object[], script_artifacts: object[], idb_stores: object[] }}
 */
export function exportAll() {
  return {
    script_runs:      db().prepare('SELECT * FROM script_runs ORDER BY started_at DESC').all(),
    script_artifacts: db().prepare('SELECT * FROM script_artifacts ORDER BY timestamp ASC').all(),
    idb_stores:       db().prepare('SELECT * FROM idb_stores ORDER BY store, synced_at DESC').all(),
  };
}

export { DB_PATH };
