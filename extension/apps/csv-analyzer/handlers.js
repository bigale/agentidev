/**
 * csv-analyzer plugin handlers.
 *
 * Pure-JS implementation — no CheerpX, no external libraries. CSV is parsed
 * with a minimal inline parser that handles quoted fields, embedded commas,
 * and escaped quotes. The parsed dataset lives in memory on the SW for the
 * duration of the session; a reload re-fetches.
 *
 * Handlers:
 *   CSV_LOAD_URL   — fetch CSV, parse, cache, return summary
 *   CSV_QUERY      — filter/sort/limit over the cached dataset
 *   CSV_DESCRIBE   — column stats (type inference, min/max/distinct)
 */

// Module-level cache — survives as long as the SW is alive
let _dataset = null;     // { rows: [{col:val, ...}], columns: [string], url: string, loadedAt: number }

function parseCSV(text) {
  // Simple RFC-4180-ish parser: double-quote for fields with commas/newlines/quotes.
  // Handles "", escaped quotes inside fields.
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = []; field = '';
      i++; continue;
    }
    if (ch === '\r') { i++; continue; } // skip CR
    field += ch; i++;
  }
  // Last field / row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function coerce(val) {
  // Try to coerce to number or boolean, otherwise return string.
  if (val === '') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  const trimmed = val.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (!Number.isNaN(n) && String(n) === trimmed) return n;
  }
  if (/^-?\d*\.\d+$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    if (!Number.isNaN(n)) return n;
  }
  return val;
}

function rowsToObjects(rawRows) {
  if (rawRows.length === 0) return { rows: [], columns: [] };
  const header = rawRows[0].map((h) => String(h).trim() || '_col');
  // De-duplicate column names
  const seen = {};
  const columns = header.map((h) => {
    seen[h] = (seen[h] || 0) + 1;
    return seen[h] === 1 ? h : `${h}_${seen[h]}`;
  });
  const rows = [];
  for (let r = 1; r < rawRows.length; r++) {
    const raw = rawRows[r];
    if (raw.length === 1 && raw[0] === '') continue; // skip blank trailing line
    const obj = {};
    for (let c = 0; c < columns.length; c++) {
      obj[columns[c]] = coerce(raw[c] !== undefined ? raw[c] : '');
    }
    rows.push(obj);
  }
  return { rows, columns };
}

export function register(handlers) {
  /**
   * Fetch a CSV from a URL, parse it, cache in memory, return summary info.
   */
  handlers['CSV_LOAD_URL'] = async (msg) => {
    if (typeof handlers['HOST_NETWORK_FETCH'] !== 'function') {
      return { success: false, error: 'HOST_NETWORK_FETCH not registered' };
    }
    const url = (msg && msg.url) ? String(msg.url).trim() : '';
    if (!url) return { success: false, error: 'url required' };

    const res = await handlers['HOST_NETWORK_FETCH']({ url, as: 'text' });
    if (!res.ok) {
      return { success: false, error: `fetch failed: ${res.status} ${res.statusText || ''}` };
    }

    const rawRows = parseCSV(res.text || '');
    const { rows, columns } = rowsToObjects(rawRows);

    _dataset = {
      url,
      loadedAt: Date.now(),
      rows,
      columns,
    };

    // Return a preview row + summary (as a single-row grid dataset)
    const summary = [{
      url,
      rows: rows.length,
      columns: columns.length,
      columnList: columns.join(', '),
      loadedAt: new Date(_dataset.loadedAt).toLocaleTimeString(),
    }];
    return { success: true, data: summary, totalRows: summary.length };
  };

  /**
   * Query the cached dataset with optional filter / sort / limit.
   *
   * msg = {
   *   filter: "col = value" OR "col > N" OR "col contains 'str'"  (simple expressions)
   *   sort:   "col asc" | "col desc"
   *   limit:  number (default 1000)
   *   columns: string (comma-separated) — project subset
   * }
   */
  handlers['CSV_QUERY'] = async (msg) => {
    if (!_dataset) return { success: false, error: 'No CSV loaded. Use CSV_LOAD_URL first.' };
    const filter = (msg && msg.filter || '').trim();
    const sort = (msg && msg.sort || '').trim();
    const limit = (msg && parseInt(msg.limit, 10)) || 1000;
    const colsArg = (msg && msg.columns || '').trim();

    let rows = _dataset.rows;

    // Filter: supports "col op value" with op in: = != > >= < <= contains starts ends
    if (filter) {
      const m = filter.match(/^([A-Za-z_][\w]*)\s*(=|!=|>=|<=|>|<|contains|starts|ends)\s*(.+)$/i);
      if (!m) {
        return { success: false, error: 'filter must be: col op value (op: = != > >= < <= contains starts ends)' };
      }
      const [, col, op, valRaw] = m;
      let val = valRaw.trim();
      // Strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        const n = coerce(val);
        if (typeof n === 'number' || typeof n === 'boolean') val = n;
      }
      const ops = {
        '=':  (a, b) => a == b, // eslint-disable-line eqeqeq
        '!=': (a, b) => a != b, // eslint-disable-line eqeqeq
        '>':  (a, b) => a >  b,
        '>=': (a, b) => a >= b,
        '<':  (a, b) => a <  b,
        '<=': (a, b) => a <= b,
        'contains': (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
        'starts':   (a, b) => String(a).toLowerCase().startsWith(String(b).toLowerCase()),
        'ends':     (a, b) => String(a).toLowerCase().endsWith(String(b).toLowerCase()),
      };
      const cmp = ops[op.toLowerCase()];
      if (!cmp) return { success: false, error: `unknown op: ${op}` };
      rows = rows.filter((r) => cmp(r[col], val));
    }

    // Sort
    if (sort) {
      const m = sort.match(/^([A-Za-z_][\w]*)(?:\s+(asc|desc))?$/i);
      if (!m) return { success: false, error: 'sort must be: col [asc|desc]' };
      const [, col, dirRaw] = m;
      const dir = (dirRaw || 'asc').toLowerCase() === 'desc' ? -1 : 1;
      rows = rows.slice().sort((a, b) => {
        const av = a[col], bv = b[col];
        if (av == null && bv == null) return 0;
        if (av == null) return  1 * dir;
        if (bv == null) return -1 * dir;
        if (av < bv) return -1 * dir;
        if (av > bv) return  1 * dir;
        return 0;
      });
    }

    // Project columns subset
    let columns = _dataset.columns;
    if (colsArg) {
      const wanted = colsArg.split(',').map((s) => s.trim()).filter(Boolean);
      columns = wanted.filter((c) => _dataset.columns.includes(c));
      rows = rows.map((r) => {
        const o = {};
        for (const c of columns) o[c] = r[c];
        return o;
      });
    }

    // Limit
    const limited = rows.slice(0, limit);

    return {
      success: true,
      data: limited,
      totalRows: limited.length,
      matchedRows: rows.length,
      columns,
    };
  };

  /**
   * Column stats — type inference, counts, min/max/distinct for each column.
   */
  handlers['CSV_DESCRIBE'] = async () => {
    if (!_dataset) return { success: false, error: 'No CSV loaded.' };
    const stats = [];
    for (const col of _dataset.columns) {
      const values = _dataset.rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== '');
      let type = 'string';
      if (values.length > 0) {
        const sample = values.slice(0, 50);
        if (sample.every((v) => typeof v === 'number')) type = 'number';
        else if (sample.every((v) => typeof v === 'boolean')) type = 'boolean';
      }
      const entry = {
        column: col,
        type,
        nonNull: values.length,
        nullCount: _dataset.rows.length - values.length,
        distinct: new Set(values).size,
      };
      if (type === 'number' && values.length > 0) {
        entry.min = Math.min(...values);
        entry.max = Math.max(...values);
        entry.mean = Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100;
      }
      stats.push(entry);
    }
    return { success: true, data: stats, totalRows: stats.length };
  };
}
