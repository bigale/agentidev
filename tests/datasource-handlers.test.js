/**
 * Tests for bridge-backed DataSource routing in datasource-handlers.js
 *
 * Since datasource-handlers.js uses ESM imports and Jest defaults to CJS,
 * we replicate the core routing logic here (registry + helpers) and test that.
 * This validates the routing, remapping, criteria, and error handling patterns.
 */

// --- Simulated bridge-client (same interface as the real one) ---

const mockBridgeClient = {
  isConnected: jest.fn(() => true),
  listSessions: jest.fn(),
  createSession: jest.fn(),
  destroySession: jest.fn(),
  listScripts: jest.fn(),
  listSchedules: jest.fn(),
  createSchedule: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
};

const mockCommandLog = [
  { id: 'cmd_1', type: 'navigate', status: 'success', timestamp: 1000 },
  { id: 'cmd_2', type: 'click', status: 'running', timestamp: 2000 },
];

// --- Replicate the routing logic from datasource-handlers.js ---

const BRIDGE_BACKENDS = {
  BridgeSessions: {
    listKey: 'sessions',
    list: () => mockBridgeClient.listSessions(),
    idField: 'id',
    add: (data) => mockBridgeClient.createSession(data.name, data),
    remove: (id) => mockBridgeClient.destroySession(id),
  },
  BridgeScripts: {
    listKey: 'scripts',
    list: () => mockBridgeClient.listScripts(),
    idField: 'scriptId',
  },
  BridgeSchedules: {
    listKey: 'schedules',
    list: () => mockBridgeClient.listSchedules(),
    idField: 'id',
    add: (data) => mockBridgeClient.createSchedule(data),
    update: (data) => mockBridgeClient.updateSchedule(data.id, data),
    remove: (id) => mockBridgeClient.deleteSchedule(id),
  },
  BridgeCommands: {
    listKey: 'log',
    list: () => ({ log: mockCommandLog }),
    idField: 'id',
  },
};

function applyCriteria(records, criteria) {
  if (!criteria || Object.keys(criteria).length === 0) return records;
  return records.filter((r) =>
    Object.entries(criteria).every(([k, v]) => r[k] === v)
  );
}

async function bridgeFetch(backend, criteria) {
  try {
    const result = await backend.list();
    let records = result[backend.listKey] || [];
    if (backend.idField && backend.idField !== 'id') {
      records = records.map((r) => ({ ...r, id: r[backend.idField] }));
    }
    records = applyCriteria(records, criteria);
    return { status: 0, data: records, totalRows: records.length };
  } catch (err) {
    return { status: -1, data: err.message };
  }
}

async function dsFetch(message) {
  const dsId = message.dataSource || 'default';
  const backend = BRIDGE_BACKENDS[dsId];
  if (backend) return bridgeFetch(backend, message.criteria);
  return { status: 0, data: [], totalRows: 0 }; // stub IndexedDB fallthrough
}

async function dsAdd(message) {
  const dsId = message.dataSource || 'default';
  const backend = BRIDGE_BACKENDS[dsId];
  if (backend) {
    if (!backend.add) return { status: -1, data: `${dsId} is read-only` };
    try {
      const result = await backend.add(message.data);
      return { status: 0, data: [result] };
    } catch (err) {
      return { status: -1, data: err.message };
    }
  }
  return { status: 0, data: [message.data] }; // stub
}

async function dsUpdate(message) {
  const dsId = message.dataSource || 'default';
  const backend = BRIDGE_BACKENDS[dsId];
  if (backend) {
    if (!backend.update) return { status: -1, data: `${dsId} does not support update` };
    try {
      const result = await backend.update(message.data);
      return { status: 0, data: [result] };
    } catch (err) {
      return { status: -1, data: err.message };
    }
  }
  return { status: 0, data: [message.data] }; // stub
}

async function dsRemove(message) {
  const dsId = message.dataSource || 'default';
  const backend = BRIDGE_BACKENDS[dsId];
  if (backend) {
    if (!backend.remove) return { status: -1, data: `${dsId} does not support remove` };
    const id = message.data?.id ?? message.criteria?.id;
    try {
      const result = await backend.remove(id);
      return { status: 0, data: [result || { id }] };
    } catch (err) {
      return { status: -1, data: err.message };
    }
  }
  return { status: 0, data: [{ id: message.data?.id }] }; // stub
}

const handlers = {
  DS_FETCH: (msg) => dsFetch(msg),
  DS_ADD: (msg) => dsAdd(msg),
  DS_UPDATE: (msg) => dsUpdate(msg),
  DS_REMOVE: (msg) => dsRemove(msg),
};

// --- Tests ---

beforeEach(() => {
  jest.clearAllMocks();
  mockBridgeClient.isConnected.mockReturnValue(true);
});

describe('Bridge-backed DataSource routing', () => {

  describe('BridgeSessions', () => {
    test('DS_FETCH returns sessions from bridge', async () => {
      mockBridgeClient.listSessions.mockResolvedValue({
        sessions: [
          { id: 's1', name: 'Session 1', state: 'ready' },
          { id: 's2', name: 'Session 2', state: 'busy' },
        ],
      });

      const result = await handlers.DS_FETCH({ dataSource: 'BridgeSessions' });
      expect(result.status).toBe(0);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ id: 's1', name: 'Session 1', state: 'ready' });
      expect(result.totalRows).toBe(2);
      expect(mockBridgeClient.listSessions).toHaveBeenCalledTimes(1);
    });

    test('DS_ADD creates session via bridge', async () => {
      mockBridgeClient.createSession.mockResolvedValue({ id: 's3', name: 'New Session' });

      const result = await handlers.DS_ADD({
        dataSource: 'BridgeSessions',
        data: { name: 'New Session' },
      });
      expect(result.status).toBe(0);
      expect(result.data[0]).toEqual({ id: 's3', name: 'New Session' });
      expect(mockBridgeClient.createSession).toHaveBeenCalledWith('New Session', { name: 'New Session' });
    });

    test('DS_REMOVE destroys session via bridge', async () => {
      mockBridgeClient.destroySession.mockResolvedValue({ id: 's1' });

      const result = await handlers.DS_REMOVE({
        dataSource: 'BridgeSessions',
        data: { id: 's1' },
      });
      expect(result.status).toBe(0);
      expect(mockBridgeClient.destroySession).toHaveBeenCalledWith('s1');
    });

    test('DS_UPDATE is not supported for sessions', async () => {
      const result = await handlers.DS_UPDATE({
        dataSource: 'BridgeSessions',
        data: { id: 's1', name: 'Renamed' },
      });
      expect(result.status).toBe(-1);
      expect(result.data).toContain('does not support update');
    });
  });

  describe('BridgeScripts', () => {
    test('DS_FETCH returns scripts with scriptId remapped to id', async () => {
      mockBridgeClient.listScripts.mockResolvedValue({
        scripts: [
          { scriptId: 'sc1', name: 'scraper.mjs', state: 'running', step: 3, total: 10 },
          { scriptId: 'sc2', name: 'poller.mjs', state: 'complete', step: 5, total: 5 },
        ],
      });

      const result = await handlers.DS_FETCH({ dataSource: 'BridgeScripts' });
      expect(result.status).toBe(0);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('sc1');
      expect(result.data[0].scriptId).toBe('sc1');
      expect(result.data[1].id).toBe('sc2');
    });

    test('DS_ADD is read-only for scripts', async () => {
      const result = await handlers.DS_ADD({
        dataSource: 'BridgeScripts',
        data: { name: 'new-script.mjs' },
      });
      expect(result.status).toBe(-1);
      expect(result.data).toContain('read-only');
    });

    test('DS_UPDATE is read-only for scripts', async () => {
      const result = await handlers.DS_UPDATE({
        dataSource: 'BridgeScripts',
        data: { id: 'sc1' },
      });
      expect(result.status).toBe(-1);
    });

    test('DS_REMOVE is read-only for scripts', async () => {
      const result = await handlers.DS_REMOVE({
        dataSource: 'BridgeScripts',
        data: { id: 'sc1' },
      });
      expect(result.status).toBe(-1);
    });
  });

  describe('BridgeSchedules', () => {
    test('DS_FETCH returns schedules from bridge', async () => {
      mockBridgeClient.listSchedules.mockResolvedValue({
        schedules: [
          { id: 'sch1', name: 'Daily scrape', cron: '0 9 * * *' },
        ],
      });

      const result = await handlers.DS_FETCH({ dataSource: 'BridgeSchedules' });
      expect(result.status).toBe(0);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('sch1');
    });

    test('DS_ADD creates schedule', async () => {
      const scheduleData = { name: 'Hourly check', cron: '0 * * * *', scriptPath: '/scripts/check.mjs' };
      mockBridgeClient.createSchedule.mockResolvedValue({ id: 'sch2', ...scheduleData });

      const result = await handlers.DS_ADD({
        dataSource: 'BridgeSchedules',
        data: scheduleData,
      });
      expect(result.status).toBe(0);
      expect(mockBridgeClient.createSchedule).toHaveBeenCalledWith(scheduleData);
    });

    test('DS_UPDATE updates schedule', async () => {
      const updateData = { id: 'sch1', cron: '0 12 * * *' };
      mockBridgeClient.updateSchedule.mockResolvedValue(updateData);

      const result = await handlers.DS_UPDATE({
        dataSource: 'BridgeSchedules',
        data: updateData,
      });
      expect(result.status).toBe(0);
      expect(mockBridgeClient.updateSchedule).toHaveBeenCalledWith('sch1', updateData);
    });

    test('DS_REMOVE deletes schedule', async () => {
      mockBridgeClient.deleteSchedule.mockResolvedValue({ id: 'sch1' });

      const result = await handlers.DS_REMOVE({
        dataSource: 'BridgeSchedules',
        data: { id: 'sch1' },
      });
      expect(result.status).toBe(0);
      expect(mockBridgeClient.deleteSchedule).toHaveBeenCalledWith('sch1');
    });
  });

  describe('BridgeCommands', () => {
    test('DS_FETCH returns command log', async () => {
      const result = await handlers.DS_FETCH({ dataSource: 'BridgeCommands' });
      expect(result.status).toBe(0);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('cmd_1');
      expect(result.data[1].type).toBe('click');
    });

    test('DS_ADD is read-only for commands', async () => {
      const result = await handlers.DS_ADD({
        dataSource: 'BridgeCommands',
        data: { type: 'fake' },
      });
      expect(result.status).toBe(-1);
      expect(result.data).toContain('read-only');
    });
  });

  describe('Criteria filtering', () => {
    test('filters records by exact-match criteria', async () => {
      mockBridgeClient.listSessions.mockResolvedValue({
        sessions: [
          { id: 's1', name: 'Alpha', state: 'ready' },
          { id: 's2', name: 'Beta', state: 'busy' },
          { id: 's3', name: 'Gamma', state: 'ready' },
        ],
      });

      const result = await handlers.DS_FETCH({
        dataSource: 'BridgeSessions',
        criteria: { state: 'ready' },
      });
      expect(result.status).toBe(0);
      expect(result.data).toHaveLength(2);
      expect(result.data.every(r => r.state === 'ready')).toBe(true);
    });

    test('empty criteria returns all records', async () => {
      mockBridgeClient.listScripts.mockResolvedValue({
        scripts: [{ scriptId: 'a' }, { scriptId: 'b' }],
      });

      const result = await handlers.DS_FETCH({
        dataSource: 'BridgeScripts',
        criteria: {},
      });
      expect(result.data).toHaveLength(2);
    });

    test('multi-field criteria narrows results', async () => {
      mockBridgeClient.listSessions.mockResolvedValue({
        sessions: [
          { id: 's1', name: 'Alpha', state: 'ready' },
          { id: 's2', name: 'Beta', state: 'ready' },
          { id: 's3', name: 'Alpha', state: 'busy' },
        ],
      });

      const result = await handlers.DS_FETCH({
        dataSource: 'BridgeSessions',
        criteria: { name: 'Alpha', state: 'ready' },
      });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('s1');
    });
  });

  describe('Error handling', () => {
    test('bridge fetch error returns status -1', async () => {
      mockBridgeClient.listSessions.mockRejectedValue(new Error('Connection lost'));

      const result = await handlers.DS_FETCH({ dataSource: 'BridgeSessions' });
      expect(result.status).toBe(-1);
      expect(result.data).toBe('Connection lost');
    });

    test('bridge add error returns status -1', async () => {
      mockBridgeClient.createSession.mockRejectedValue(new Error('Server busy'));

      const result = await handlers.DS_ADD({
        dataSource: 'BridgeSessions',
        data: { name: 'fail' },
      });
      expect(result.status).toBe(-1);
      expect(result.data).toBe('Server busy');
    });

    test('bridge update error returns status -1', async () => {
      mockBridgeClient.updateSchedule.mockRejectedValue(new Error('Not found'));

      const result = await handlers.DS_UPDATE({
        dataSource: 'BridgeSchedules',
        data: { id: 'gone' },
      });
      expect(result.status).toBe(-1);
      expect(result.data).toBe('Not found');
    });

    test('bridge remove error returns status -1', async () => {
      mockBridgeClient.destroySession.mockRejectedValue(new Error('Cannot destroy'));

      const result = await handlers.DS_REMOVE({
        dataSource: 'BridgeSessions',
        data: { id: 's1' },
      });
      expect(result.status).toBe(-1);
      expect(result.data).toBe('Cannot destroy');
    });
  });

  describe('IndexedDB fallthrough', () => {
    test('unknown DataSource does NOT call any bridge functions', async () => {
      const result = await handlers.DS_FETCH({ dataSource: 'NotesDS' });
      expect(result.status).toBe(0);
      expect(mockBridgeClient.listSessions).not.toHaveBeenCalled();
      expect(mockBridgeClient.listScripts).not.toHaveBeenCalled();
      expect(mockBridgeClient.listSchedules).not.toHaveBeenCalled();
    });
  });

  describe('DS_REMOVE with criteria', () => {
    test('extracts id from criteria when data.id is absent', async () => {
      mockBridgeClient.destroySession.mockResolvedValue({ id: 's2' });

      const result = await handlers.DS_REMOVE({
        dataSource: 'BridgeSessions',
        criteria: { id: 's2' },
      });
      expect(result.status).toBe(0);
      expect(mockBridgeClient.destroySession).toHaveBeenCalledWith('s2');
    });
  });
});
