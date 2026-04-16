/**
 * sqlite-query plugin handlers.
 *
 * Flow:
 *   1. SQLITE_UPLOAD — receives a base64 blob of a .db file, writes it to
 *      the CheerpX DataDevice at /data/user.db, then copies to /tmp/user.db
 *      (ext2) since DataDevice files are read-only from the VM.
 *   2. SQLITE_QUERY — runs a SQL query against /tmp/user.db via:
 *        sqlite3 /tmp/user.db -json "<SQL>"
 *      Parses the JSON output and returns an array of row objects.
 *   3. SQLITE_TABLES — convenience: returns a list of tables in the DB.
 *
 * All three return SmartClient-friendly responses: either a `rows` array
 * for grids, or a formatted text payload for display.
 */

export function register(handlers) {
  const DB_PATH_VM = '/tmp/user.db';
  const DB_PATH_DATA = '/data/user.db';

  /**
   * Load a SQLite database from a URL into the CheerpX VM, then return the
   * list of tables with row counts. One-shot convenience for the UI.
   *
   * The extension does the HTTP fetch (via HOST_FS_UPLOAD → cheerpx-fs-upload,
   * which writes to the VM filesystem in chunks). Then we copy from /data to
   * /tmp (ext2) since DataDevice files have limitations, and query sqlite_master.
   */
  handlers['SQLITE_LOAD_URL'] = async (msg) => {
    if (typeof handlers['HOST_FS_UPLOAD'] !== 'function') {
      return { success: false, error: 'HOST_FS_UPLOAD not registered' };
    }
    if (typeof handlers['HOST_EXEC_SPAWN'] !== 'function') {
      return { success: false, error: 'HOST_EXEC_SPAWN not registered' };
    }
    const url = (msg && msg.url) ? String(msg.url).trim() : '';
    if (!url) return { success: false, error: 'url required' };

    // Upload: fetch URL → write directly to ext2 filesystem in the VM
    const uploadRes = await handlers['HOST_FS_UPLOAD']({ url, path: DB_PATH_VM });
    if (!uploadRes.success) {
      return { success: false, error: 'upload failed: ' + (uploadRes.error || 'unknown') };
    }

    // Query sqlite_master to get tables + row counts
    const listRes = await handlers['HOST_EXEC_SPAWN']({
      cmd: '/usr/bin/sqlite3',
      args: [DB_PATH_VM, '-json', "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"],
    });
    if (listRes.exitCode !== 0) {
      return { success: false, error: 'sqlite3 error: ' + (listRes.stderr || listRes.stdout || 'exit ' + listRes.exitCode) };
    }
    let tables = [];
    try {
      tables = JSON.parse((listRes.stdout || '').trim() || '[]');
    } catch (e) {
      return { success: false, error: 'parse error: ' + e.message };
    }

    // Get row count per table (separate queries since sqlite3 can't DECLARE variables in -json)
    const rows = [];
    for (const t of tables) {
      const countRes = await handlers['HOST_EXEC_SPAWN']({
        cmd: '/usr/bin/sqlite3',
        args: [DB_PATH_VM, '-json', 'SELECT COUNT(*) AS n FROM "' + t.name.replace(/"/g, '""') + '"'],
      });
      let count = 0;
      try {
        const parsed = JSON.parse((countRes.stdout || '').trim() || '[]');
        count = parsed[0] ? parsed[0].n : 0;
      } catch {}
      rows.push({ name: t.name, rows: count });
    }

    return {
      success: true,
      data: rows,
      totalRows: rows.length,
      bytes: uploadRes.bytes || 0,
    };
  };

  /**
   * Run a SQL query against the uploaded DB. Returns rows as an array of
   * objects suitable for a SmartClient ListGrid.
   */
  handlers['SQLITE_QUERY'] = async (msg) => {
    if (typeof handlers['HOST_EXEC_SPAWN'] !== 'function') {
      return { success: false, error: 'HOST_EXEC_SPAWN not registered' };
    }
    const sql = (msg && msg.sql) ? String(msg.sql).trim() : '';
    if (!sql) return { success: false, error: 'sql required', rows: [] };

    // sqlite3 -json outputs an array of objects, one per row
    const res = await handlers['HOST_EXEC_SPAWN']({
      cmd: '/usr/bin/sqlite3',
      args: [DB_PATH_VM, '-json', sql],
    });
    if (res.exitCode !== 0) {
      return {
        success: false,
        error: (res.stderr || 'sqlite3 exit ' + res.exitCode).trim(),
        rows: [],
      };
    }

    const out = (res.stdout || '').trim();
    if (!out) return { success: true, rows: [], rowCount: 0 };

    let rows;
    try {
      rows = JSON.parse(out);
      if (!Array.isArray(rows)) rows = [rows];
    } catch (e) {
      return {
        success: false,
        error: 'Failed to parse sqlite3 JSON output: ' + e.message,
        rawOutput: out.slice(0, 500),
        rows: [],
      };
    }

    // Return shape matches fetchAndLoadGrid expectations (data + totalRows)
    return {
      success: true,
      data: rows,
      totalRows: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      elapsedMs: res.elapsedMs,
    };
  };

  /**
   * List tables in the uploaded DB with row counts.
   */
  handlers['SQLITE_TABLES'] = async () => {
    if (typeof handlers['HOST_EXEC_SPAWN'] !== 'function') {
      return { success: false, error: 'HOST_EXEC_SPAWN not registered' };
    }
    const res = await handlers['HOST_EXEC_SPAWN']({
      cmd: '/usr/bin/sqlite3',
      args: [DB_PATH_VM, '-json', "SELECT name, (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name=m.name) AS indexes FROM sqlite_master m WHERE type='table' ORDER BY name"],
    });
    if (res.exitCode !== 0) {
      return { success: false, error: res.stderr || 'sqlite3 exit ' + res.exitCode, rows: [] };
    }
    const out = (res.stdout || '').trim();
    let tables = [];
    try {
      if (out) tables = JSON.parse(out);
    } catch (e) {
      return { success: false, error: 'parse: ' + e.message, rows: [] };
    }
    // Get row count for each table (separate query since sqlite3 -json doesn't support dynamic COUNT via UNION)
    const rows = [];
    for (const t of tables) {
      const countRes = await handlers['HOST_EXEC_SPAWN']({
        cmd: '/usr/bin/sqlite3',
        args: [DB_PATH_VM, '-json', 'SELECT COUNT(*) AS n FROM "' + t.name.replace(/"/g, '""') + '"'],
      });
      let count = 0;
      try {
        const parsed = JSON.parse((countRes.stdout || '').trim() || '[]');
        count = parsed[0] ? parsed[0].n : 0;
      } catch {}
      rows.push({ name: t.name, rows: count, indexes: t.indexes || 0 });
    }
    return { success: true, data: rows, totalRows: rows.length };
  };

  /**
   * Schema of a specific table (PRAGMA table_info).
   */
  handlers['SQLITE_SCHEMA'] = async (msg) => {
    const table = (msg && msg.table) ? String(msg.table) : '';
    if (!table) return { success: false, error: 'table required', rows: [] };
    const res = await handlers['HOST_EXEC_SPAWN']({
      cmd: '/usr/bin/sqlite3',
      args: [DB_PATH_VM, '-json', 'PRAGMA table_info("' + table.replace(/"/g, '""') + '")'],
    });
    if (res.exitCode !== 0) {
      return { success: false, error: res.stderr || 'sqlite3 exit ' + res.exitCode, rows: [] };
    }
    const out = (res.stdout || '').trim();
    let rows = [];
    try {
      if (out) rows = JSON.parse(out);
    } catch (e) {
      return { success: false, error: 'parse: ' + e.message, rows: [] };
    }
    return { success: true, data: rows, totalRows: rows.length };
  };
}
