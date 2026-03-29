/**
 * Tests for Agentiface project persistence and playground session binding.
 *
 * Since the actual modules use ESM imports and Chrome APIs (IndexedDB, chrome.runtime),
 * we replicate the core logic here and test the routing, state management, and
 * persistence patterns in CJS-compatible Jest.
 *
 * Covers:
 * - Project CRUD (IndexedDB layer)
 * - Bridge-backed project persistence (AF_PROJECT_* handlers)
 * - Playground session binding (create/load/reset project)
 * - Auto-save to project after generation
 * - System prompt context threading
 * - Backward compatibility (legacy apps still work)
 * - Promote app to project
 */

// --- Mock bridge client ---

const mockBridgeClient = {
  isConnected: jest.fn(() => true),
  afProjectSave: jest.fn(),
  afProjectLoad: jest.fn(),
  afProjectList: jest.fn(),
  afProjectDelete: jest.fn(),
  afAppSave: jest.fn(),
  afAppLoad: jest.fn(),
  afAppList: jest.fn(),
  afAppDelete: jest.fn(),
  generateSmartClientUI: jest.fn(),
};

// --- Mock IndexedDB project store ---

const projectStore = new Map();

function generateProjectId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `proj_${Date.now()}_${rand}`;
}

async function saveProject(record) {
  const now = new Date().toISOString();
  if (!record.id) {
    record.id = generateProjectId();
    record.createdAt = now;
  }
  record.updatedAt = now;
  projectStore.set(record.id, { ...record });
  return { ...record };
}

async function loadProject(id) {
  return projectStore.get(id) || null;
}

async function listProjects() {
  const records = [...projectStore.values()];
  records.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return records;
}

async function deleteProject(id) {
  if (!projectStore.has(id)) throw new Error(`Project not found: ${id}`);
  projectStore.delete(id);
}

// --- Mock app persistence ---

const appStore = new Map();

function generateAppId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `app_${Date.now()}_${rand}`;
}

async function saveApp(record) {
  const now = new Date().toISOString();
  if (!record.id) {
    record.id = generateAppId();
    record.createdAt = now;
  }
  record.updatedAt = now;
  appStore.set(record.id, { ...record });
  return { ...record };
}

// --- Replicate playground session state from smartclient-handlers.js ---

let playgroundSession;

function resetPlaygroundSession() {
  playgroundSession = {
    config: null,
    appId: null,
    appName: null,
    projectId: null,
    projectName: null,
    projectDescription: null,
    promptHistory: [],
    undoStack: [],
    status: 'idle',
    error: null,
    capabilities: { skinPicker: true },
    skin: 'Tahoe',
  };
}

function broadcastPlaygroundState() {
  return {
    type: 'AUTO_BROADCAST_SC_PLAYGROUND',
    status: playgroundSession.status,
    appName: playgroundSession.appName,
    appId: playgroundSession.appId,
    projectId: playgroundSession.projectId,
    projectName: playgroundSession.projectName,
    projectDescription: playgroundSession.projectDescription,
    hasConfig: !!playgroundSession.config,
    promptCount: playgroundSession.promptHistory.length,
    undoCount: playgroundSession.undoStack.length,
    error: playgroundSession.error,
    capabilities: playgroundSession.capabilities,
    skin: playgroundSession.skin,
  };
}

function deriveName(input) {
  if (!input) return 'Untitled App';
  try {
    const url = new URL(input);
    return url.hostname.replace(/^www\./, '');
  } catch {
    // Not a URL
  }
  const trimmed = input.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 40).replace(/\s+\S*$/, '') + '...';
}

function validateConfig(config) {
  if (!config.dataSources || !Array.isArray(config.dataSources)) {
    throw new Error('Config must have dataSources array');
  }
  if (!config.layout || !config.layout._type) {
    throw new Error('Config must have layout object with _type');
  }
  for (const ds of config.dataSources) {
    if (!ds.ID) throw new Error('Each dataSource must have an ID');
    if (!ds.fields || !Array.isArray(ds.fields)) {
      throw new Error(`DataSource ${ds.ID} must have fields array`);
    }
  }
}

// --- Replicate handler functions ---

async function handlePlaygroundCreateProject(message) {
  const { name, description, skin, capabilities } = message;
  if (!name || !name.trim()) {
    return { success: false, error: 'Project name is required' };
  }

  try {
    const project = await saveProject({
      name: name.trim(),
      description: (description || '').trim(),
      skin: skin || 'Tahoe',
      capabilities: capabilities || { skinPicker: true },
      config: null,
      prompt: null,
    });

    if (mockBridgeClient.isConnected()) {
      try {
        await mockBridgeClient.afProjectSave({
          id: project.id,
          name: project.name,
          description: project.description || '',
          skin: project.skin || 'Tahoe',
          capabilities: project.capabilities || {},
        });
      } catch (e) {
        // non-fatal
      }
    }

    playgroundSession.projectId = project.id;
    playgroundSession.projectName = project.name;
    playgroundSession.projectDescription = project.description || null;
    playgroundSession.config = null;
    playgroundSession.appId = null;
    playgroundSession.appName = null;
    playgroundSession.undoStack = [];
    playgroundSession.promptHistory = [];
    playgroundSession.status = 'idle';
    playgroundSession.error = null;
    playgroundSession.skin = project.skin || 'Tahoe';
    playgroundSession.capabilities = project.capabilities || { skinPicker: true };

    return { success: true, project };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handlePlaygroundLoadProject(message) {
  const { id } = message;
  if (!id) return { success: false, error: 'Project id is required' };

  let project = null;
  if (mockBridgeClient.isConnected()) {
    try {
      const result = await mockBridgeClient.afProjectLoad(id);
      if (result.success) project = result.project;
    } catch {
      // fall through
    }
  }

  if (!project) {
    project = await loadProject(id);
  }

  if (!project) return { success: false, error: `Project not found: ${id}` };

  playgroundSession.projectId = project.id;
  playgroundSession.projectName = project.name;
  playgroundSession.projectDescription = project.description || null;
  playgroundSession.config = project.config ? JSON.parse(JSON.stringify(project.config)) : null;
  playgroundSession.appId = null;
  playgroundSession.appName = null;
  playgroundSession.undoStack = [];
  playgroundSession.promptHistory = [];
  playgroundSession.status = 'idle';
  playgroundSession.error = null;
  playgroundSession.skin = project.skin || 'Tahoe';
  playgroundSession.capabilities = project.capabilities || { skinPicker: true };

  return { success: true, project };
}

async function handlePlaygroundGenerate(message) {
  const { prompt } = message;
  if (!prompt || !prompt.trim()) {
    return { success: false, error: 'Prompt is required' };
  }

  if (playgroundSession.config) {
    playgroundSession.undoStack.push(JSON.parse(JSON.stringify(playgroundSession.config)));
  }

  playgroundSession.status = 'generating';
  playgroundSession.error = null;

  try {
    if (!mockBridgeClient.isConnected()) {
      throw new Error('Bridge server not connected');
    }
    const result = await mockBridgeClient.generateSmartClientUI(
      prompt,
      playgroundSession.config || null,
      playgroundSession.projectDescription || null
    );

    if (!result.success) {
      if (playgroundSession.config) playgroundSession.undoStack.pop();
      playgroundSession.status = 'error';
      playgroundSession.error = result.error;
      return result;
    }

    validateConfig(result.config);

    playgroundSession.config = JSON.parse(JSON.stringify(result.config));
    playgroundSession.appName = playgroundSession.appName || deriveName(prompt);
    playgroundSession.promptHistory.push(prompt);
    playgroundSession.status = 'idle';
    playgroundSession.error = null;

    // Auto-save to project if bound
    if (playgroundSession.projectId) {
      await autoSaveToProject(prompt);
    }

    return { success: true, config: result.config };
  } catch (err) {
    if (playgroundSession.undoStack.length > 0 &&
        playgroundSession.undoStack[playgroundSession.undoStack.length - 1]) {
      playgroundSession.undoStack.pop();
    }
    playgroundSession.status = 'error';
    playgroundSession.error = err.message;
    return { success: false, error: err.message };
  }
}

async function autoSaveToProject(prompt) {
  const projId = playgroundSession.projectId;
  if (!projId || !playgroundSession.config) return { success: false };

  const configClone = JSON.parse(JSON.stringify(playgroundSession.config));

  await saveProject({
    id: projId,
    name: playgroundSession.projectName,
    description: playgroundSession.projectDescription || '',
    skin: playgroundSession.skin,
    capabilities: playgroundSession.capabilities,
    config: configClone,
    prompt: prompt || null,
  });

  if (mockBridgeClient.isConnected()) {
    await mockBridgeClient.afProjectSave({
      id: projId,
      name: playgroundSession.projectName,
      description: playgroundSession.projectDescription || '',
      skin: playgroundSession.skin,
      capabilities: playgroundSession.capabilities,
      config: configClone,
      prompt: prompt || null,
    });
  }

  return { success: true };
}

function handlePlaygroundReset() {
  resetPlaygroundSession();
  return { success: true };
}

async function handlePlaygroundSave() {
  if (!playgroundSession.config) {
    return { success: false, error: 'No config to save' };
  }
  if (!mockBridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }

  const lastPrompt = playgroundSession.promptHistory[playgroundSession.promptHistory.length - 1] || null;

  if (playgroundSession.projectId) {
    return autoSaveToProject(lastPrompt);
  }

  const result = await mockBridgeClient.afAppSave({
    id: playgroundSession.appId || undefined,
    name: playgroundSession.appName || 'Untitled App',
    type: 'generate',
    config: JSON.parse(JSON.stringify(playgroundSession.config)),
    prompt: lastPrompt,
  });

  if (result.success && result.app) {
    playgroundSession.appId = result.app.id;
    playgroundSession.appName = result.app.name;
  }
  return result;
}

async function handlePromoteAppToProject(message) {
  const { appId } = message;
  if (!appId) return { success: false, error: 'appId is required' };

  let app = null;
  if (mockBridgeClient.isConnected()) {
    try {
      const result = await mockBridgeClient.afAppLoad(appId);
      if (result.success) app = result.app;
    } catch { /* fall through */ }
  }
  if (!app) return { success: false, error: `App not found: ${appId}` };

  const project = await saveProject({
    name: app.name || 'Promoted App',
    description: '',
    skin: 'Tahoe',
    capabilities: { skinPicker: true },
    config: app.config || null,
    prompt: app.prompt || null,
  });

  if (mockBridgeClient.isConnected()) {
    await mockBridgeClient.afProjectSave({
      id: project.id,
      name: project.name,
      description: '',
      config: project.config,
      prompt: project.prompt,
    });
  }

  return { success: true, project };
}

// Bridge-backed project handlers
async function handleAfProjectList() {
  if (!mockBridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  return mockBridgeClient.afProjectList();
}

async function handleAfProjectLoad(message) {
  if (!mockBridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  return mockBridgeClient.afProjectLoad(message.id);
}

async function handleAfProjectDelete(message) {
  if (!mockBridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  return mockBridgeClient.afProjectDelete(message.id);
}

// --- Sample configs ---

const SAMPLE_CONFIG = {
  dataSources: [
    { ID: 'TaskDS', fields: [
      { name: 'id', type: 'integer', primaryKey: true, hidden: true },
      { name: 'title', type: 'text', required: true },
    ]},
  ],
  layout: { _type: 'VLayout', members: [] },
};

const SAMPLE_CONFIG_2 = {
  dataSources: [
    { ID: 'TaskDS', fields: [
      { name: 'id', type: 'integer', primaryKey: true, hidden: true },
      { name: 'title', type: 'text', required: true },
      { name: 'status', type: 'text' },
    ]},
  ],
  layout: { _type: 'VLayout', members: [{ _type: 'ForgeListGrid', dataSource: 'TaskDS' }] },
};

// --- Tests ---

beforeEach(() => {
  jest.clearAllMocks();
  projectStore.clear();
  appStore.clear();
  resetPlaygroundSession();
  mockBridgeClient.isConnected.mockReturnValue(true);
});

describe('Project Persistence (IndexedDB layer)', () => {

  test('saveProject creates new project with generated id', async () => {
    const project = await saveProject({
      name: 'My Project',
      description: 'A test project',
      skin: 'Obsidian',
    });

    expect(project.id).toMatch(/^proj_\d+_[a-z0-9]+$/);
    expect(project.name).toBe('My Project');
    expect(project.description).toBe('A test project');
    expect(project.skin).toBe('Obsidian');
    expect(project.createdAt).toBeDefined();
    expect(project.updatedAt).toBeDefined();
  });

  test('saveProject updates existing project', async () => {
    const original = await saveProject({ name: 'Original' });
    const updated = await saveProject({ id: original.id, name: 'Updated' });

    expect(updated.id).toBe(original.id);
    expect(updated.name).toBe('Updated');
    expect(projectStore.size).toBe(1);
  });

  test('loadProject returns project by id', async () => {
    const saved = await saveProject({ name: 'Findable' });
    const loaded = await loadProject(saved.id);

    expect(loaded).not.toBeNull();
    expect(loaded.name).toBe('Findable');
  });

  test('loadProject returns null for unknown id', async () => {
    const result = await loadProject('proj_nonexistent');
    expect(result).toBeNull();
  });

  test('listProjects returns sorted by updatedAt descending', async () => {
    await saveProject({ name: 'Alpha' });
    await new Promise(r => setTimeout(r, 5));
    await saveProject({ name: 'Beta' });

    const list = await listProjects();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('Beta');
    expect(list[1].name).toBe('Alpha');
  });

  test('deleteProject removes project', async () => {
    const proj = await saveProject({ name: 'Doomed' });
    await deleteProject(proj.id);
    expect(projectStore.size).toBe(0);
  });

  test('deleteProject throws for unknown id', async () => {
    await expect(deleteProject('proj_nope')).rejects.toThrow('Project not found');
  });

  test('project id uses proj_ prefix (not app_)', async () => {
    const project = await saveProject({ name: 'Prefix Test' });
    expect(project.id).toMatch(/^proj_/);
    expect(project.id).not.toMatch(/^app_/);
  });
});

describe('Playground Session - Create Project', () => {

  test('creates project and binds playground', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });

    const result = await handlePlaygroundCreateProject({
      name: 'Dashboard Project',
      description: 'Sales metrics dashboard',
      skin: 'Enterprise',
    });

    expect(result.success).toBe(true);
    expect(result.project.name).toBe('Dashboard Project');
    expect(result.project.description).toBe('Sales metrics dashboard');
    expect(result.project.id).toMatch(/^proj_/);

    // Playground should be bound
    expect(playgroundSession.projectId).toBe(result.project.id);
    expect(playgroundSession.projectName).toBe('Dashboard Project');
    expect(playgroundSession.projectDescription).toBe('Sales metrics dashboard');
    expect(playgroundSession.skin).toBe('Enterprise');
    expect(playgroundSession.config).toBeNull();
    expect(playgroundSession.appId).toBeNull();
  });

  test('saves to bridge disk on create', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });

    const result = await handlePlaygroundCreateProject({
      name: 'Bridge Test',
    });

    expect(mockBridgeClient.afProjectSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.project.id,
        name: 'Bridge Test',
      })
    );
  });

  test('rejects empty project name', async () => {
    const result = await handlePlaygroundCreateProject({ name: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('name is required');
  });

  test('rejects whitespace-only project name', async () => {
    const result = await handlePlaygroundCreateProject({ name: '   ' });
    expect(result.success).toBe(false);
  });

  test('trims name and description', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });

    const result = await handlePlaygroundCreateProject({
      name: '  Trimmed  ',
      description: '  desc  ',
    });

    expect(result.project.name).toBe('Trimmed');
    expect(result.project.description).toBe('desc');
  });

  test('defaults skin to Tahoe', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });

    const result = await handlePlaygroundCreateProject({ name: 'Default Skin' });
    expect(playgroundSession.skin).toBe('Tahoe');
  });

  test('clears previous playground state on create', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });

    // Set up some state
    playgroundSession.appId = 'app_old';
    playgroundSession.appName = 'Old App';
    playgroundSession.config = SAMPLE_CONFIG;
    playgroundSession.promptHistory = ['old prompt'];

    await handlePlaygroundCreateProject({ name: 'Fresh Start' });

    expect(playgroundSession.appId).toBeNull();
    expect(playgroundSession.appName).toBeNull();
    expect(playgroundSession.config).toBeNull();
    expect(playgroundSession.promptHistory).toHaveLength(0);
  });
});

describe('Playground Session - Load Project', () => {

  test('loads project from bridge (primary)', async () => {
    const proj = await saveProject({
      name: 'Bridge Project',
      description: 'From disk',
      config: SAMPLE_CONFIG,
      skin: 'Graphite',
    });

    mockBridgeClient.afProjectLoad.mockResolvedValue({
      success: true,
      project: { ...proj, description: 'From disk (updated)' },
    });

    const result = await handlePlaygroundLoadProject({ id: proj.id });

    expect(result.success).toBe(true);
    expect(playgroundSession.projectId).toBe(proj.id);
    expect(playgroundSession.projectDescription).toBe('From disk (updated)');
    expect(playgroundSession.config).toEqual(SAMPLE_CONFIG);
    expect(playgroundSession.skin).toBe('Graphite');
  });

  test('falls back to IndexedDB when bridge fails', async () => {
    const proj = await saveProject({
      name: 'IDB Project',
      description: 'IndexedDB fallback',
      config: SAMPLE_CONFIG,
    });

    mockBridgeClient.afProjectLoad.mockRejectedValue(new Error('Bridge down'));

    const result = await handlePlaygroundLoadProject({ id: proj.id });

    expect(result.success).toBe(true);
    expect(playgroundSession.projectName).toBe('IDB Project');
  });

  test('returns error for unknown project', async () => {
    mockBridgeClient.afProjectLoad.mockResolvedValue({ success: false });

    const result = await handlePlaygroundLoadProject({ id: 'proj_nonexistent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('requires id parameter', async () => {
    const result = await handlePlaygroundLoadProject({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('id is required');
  });

  test('clears undo stack and prompt history on load', async () => {
    playgroundSession.undoStack = [SAMPLE_CONFIG];
    playgroundSession.promptHistory = ['old prompt'];

    const proj = await saveProject({ name: 'Clean Load', config: SAMPLE_CONFIG });
    mockBridgeClient.afProjectLoad.mockResolvedValue({ success: true, project: proj });

    await handlePlaygroundLoadProject({ id: proj.id });

    expect(playgroundSession.undoStack).toHaveLength(0);
    expect(playgroundSession.promptHistory).toHaveLength(0);
  });

  test('loads project with null config', async () => {
    const proj = await saveProject({ name: 'Empty Project', config: null });
    mockBridgeClient.afProjectLoad.mockResolvedValue({ success: true, project: proj });

    const result = await handlePlaygroundLoadProject({ id: proj.id });

    expect(result.success).toBe(true);
    expect(playgroundSession.config).toBeNull();
  });
});

describe('Playground Session - Generate with Project Binding', () => {

  test('threads projectDescription to generateSmartClientUI', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });
    mockBridgeClient.generateSmartClientUI.mockResolvedValue({
      success: true,
      config: SAMPLE_CONFIG,
    });

    // Create project with description
    await handlePlaygroundCreateProject({
      name: 'Context Test',
      description: 'A CRM for managing customer contacts',
    });

    // Generate should pass description
    await handlePlaygroundGenerate({ prompt: 'Add a phone field' });

    expect(mockBridgeClient.generateSmartClientUI).toHaveBeenCalledWith(
      'Add a phone field',
      null, // no current config yet (first gen)
      'A CRM for managing customer contacts'
    );
  });

  test('auto-saves config to project after generation', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });
    mockBridgeClient.generateSmartClientUI.mockResolvedValue({
      success: true,
      config: SAMPLE_CONFIG,
    });

    await handlePlaygroundCreateProject({ name: 'Auto-save Test' });
    const projId = playgroundSession.projectId;

    await handlePlaygroundGenerate({ prompt: 'Create a task list' });

    // Bridge save should be called for project (create + auto-save after gen)
    expect(mockBridgeClient.afProjectSave).toHaveBeenCalledTimes(2);
    const autoSaveCall = mockBridgeClient.afProjectSave.mock.calls[1][0];
    expect(autoSaveCall.id).toBe(projId);
    expect(autoSaveCall.config).toEqual(SAMPLE_CONFIG);
    expect(autoSaveCall.prompt).toBe('Create a task list');

    // IndexedDB should also be updated
    const stored = await loadProject(projId);
    expect(stored.config).toEqual(SAMPLE_CONFIG);
  });

  test('passes current config on subsequent generations', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });
    mockBridgeClient.generateSmartClientUI
      .mockResolvedValueOnce({ success: true, config: SAMPLE_CONFIG })
      .mockResolvedValueOnce({ success: true, config: SAMPLE_CONFIG_2 });

    await handlePlaygroundCreateProject({ name: 'Multi-gen Test' });

    // First gen
    await handlePlaygroundGenerate({ prompt: 'Create tasks' });
    expect(mockBridgeClient.generateSmartClientUI).toHaveBeenLastCalledWith(
      'Create tasks', null, null
    );

    // Second gen — should pass current config
    await handlePlaygroundGenerate({ prompt: 'Add status field' });
    expect(mockBridgeClient.generateSmartClientUI).toHaveBeenLastCalledWith(
      'Add status field', SAMPLE_CONFIG, null
    );
  });

  test('does NOT auto-save when no project bound', async () => {
    mockBridgeClient.generateSmartClientUI.mockResolvedValue({
      success: true,
      config: SAMPLE_CONFIG,
    });

    // No project created — just generate
    await handlePlaygroundGenerate({ prompt: 'Standalone gen' });

    expect(mockBridgeClient.afProjectSave).not.toHaveBeenCalled();
  });
});

describe('Playground Session - Save', () => {

  test('save routes to project when bound', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });
    mockBridgeClient.generateSmartClientUI.mockResolvedValue({
      success: true,
      config: SAMPLE_CONFIG,
    });

    await handlePlaygroundCreateProject({ name: 'Save Project Test' });
    await handlePlaygroundGenerate({ prompt: 'Initial UI' });

    // Explicit save
    const result = await handlePlaygroundSave();
    expect(result.success).toBe(true);

    // Should call afProjectSave (create + auto-save + explicit save = 3 times)
    expect(mockBridgeClient.afProjectSave).toHaveBeenCalledTimes(3);
    // Should NOT call afAppSave
    expect(mockBridgeClient.afAppSave).not.toHaveBeenCalled();
  });

  test('save routes to flat app when no project bound', async () => {
    mockBridgeClient.afAppSave.mockResolvedValue({
      success: true,
      app: { id: 'app_123', name: 'Flat App' },
    });
    mockBridgeClient.generateSmartClientUI.mockResolvedValue({
      success: true,
      config: SAMPLE_CONFIG,
    });

    // Generate without project
    await handlePlaygroundGenerate({ prompt: 'Standalone' });

    const result = await handlePlaygroundSave();
    expect(result.success).toBe(true);
    expect(mockBridgeClient.afAppSave).toHaveBeenCalledTimes(1);
    expect(mockBridgeClient.afProjectSave).not.toHaveBeenCalled();
  });

  test('save fails with no config', async () => {
    const result = await handlePlaygroundSave();
    expect(result.success).toBe(false);
    expect(result.error).toContain('No config');
  });

  test('save fails when bridge disconnected', async () => {
    playgroundSession.config = SAMPLE_CONFIG;
    mockBridgeClient.isConnected.mockReturnValue(false);

    const result = await handlePlaygroundSave();
    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });
});

describe('Playground Session - Reset', () => {

  test('reset clears project binding', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });
    await handlePlaygroundCreateProject({ name: 'To Reset' });

    expect(playgroundSession.projectId).not.toBeNull();

    handlePlaygroundReset();

    expect(playgroundSession.projectId).toBeNull();
    expect(playgroundSession.projectName).toBeNull();
    expect(playgroundSession.projectDescription).toBeNull();
    expect(playgroundSession.config).toBeNull();
    expect(playgroundSession.status).toBe('idle');
  });
});

describe('Broadcast State', () => {

  test('broadcast includes project fields', async () => {
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });
    await handlePlaygroundCreateProject({
      name: 'Broadcast Test',
      description: 'Testing broadcast',
    });

    const state = broadcastPlaygroundState();
    expect(state.projectId).toMatch(/^proj_/);
    expect(state.projectName).toBe('Broadcast Test');
    expect(state.projectDescription).toBe('Testing broadcast');
    expect(state.type).toBe('AUTO_BROADCAST_SC_PLAYGROUND');
  });

  test('broadcast has null project fields when unbound', () => {
    const state = broadcastPlaygroundState();
    expect(state.projectId).toBeNull();
    expect(state.projectName).toBeNull();
    expect(state.projectDescription).toBeNull();
  });
});

describe('Bridge-backed Project Handlers', () => {

  test('AF_PROJECT_LIST returns projects from bridge', async () => {
    mockBridgeClient.afProjectList.mockResolvedValue({
      success: true,
      projects: [
        { id: 'proj_1', name: 'Proj A', componentCount: 2 },
        { id: 'proj_2', name: 'Proj B', componentCount: 0 },
      ],
    });

    const result = await handleAfProjectList();
    expect(result.success).toBe(true);
    expect(result.projects).toHaveLength(2);
  });

  test('AF_PROJECT_LIST fails when bridge disconnected', async () => {
    mockBridgeClient.isConnected.mockReturnValue(false);

    const result = await handleAfProjectList();
    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  test('AF_PROJECT_LOAD loads project from bridge', async () => {
    mockBridgeClient.afProjectLoad.mockResolvedValue({
      success: true,
      project: { id: 'proj_1', name: 'Loaded', config: SAMPLE_CONFIG },
    });

    const result = await handleAfProjectLoad({ id: 'proj_1' });
    expect(result.success).toBe(true);
    expect(result.project.name).toBe('Loaded');
  });

  test('AF_PROJECT_DELETE deletes from bridge', async () => {
    mockBridgeClient.afProjectDelete.mockResolvedValue({ success: true });

    const result = await handleAfProjectDelete({ id: 'proj_1' });
    expect(result.success).toBe(true);
    expect(mockBridgeClient.afProjectDelete).toHaveBeenCalledWith('proj_1');
  });
});

describe('Promote App to Project', () => {

  test('creates project from legacy app', async () => {
    mockBridgeClient.afAppLoad.mockResolvedValue({
      success: true,
      app: { id: 'app_old', name: 'Legacy App', config: SAMPLE_CONFIG, prompt: 'original prompt' },
    });
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });

    const result = await handlePromoteAppToProject({ appId: 'app_old' });

    expect(result.success).toBe(true);
    expect(result.project.id).toMatch(/^proj_/);
    expect(result.project.name).toBe('Legacy App');
    expect(result.project.config).toEqual(SAMPLE_CONFIG);
    expect(result.project.prompt).toBe('original prompt');
  });

  test('fails when app not found', async () => {
    mockBridgeClient.afAppLoad.mockResolvedValue({ success: false });

    const result = await handlePromoteAppToProject({ appId: 'app_gone' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('requires appId', async () => {
    const result = await handlePromoteAppToProject({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('appId is required');
  });

  test('saves promoted project to bridge disk', async () => {
    mockBridgeClient.afAppLoad.mockResolvedValue({
      success: true,
      app: { id: 'app_x', name: 'Promote Me', config: SAMPLE_CONFIG },
    });
    mockBridgeClient.afProjectSave.mockResolvedValue({ success: true });

    const result = await handlePromoteAppToProject({ appId: 'app_x' });

    expect(mockBridgeClient.afProjectSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.project.id,
        name: 'Promote Me',
        config: SAMPLE_CONFIG,
      })
    );
  });
});

describe('Config Validation', () => {

  test('rejects config without dataSources', () => {
    expect(() => validateConfig({ layout: { _type: 'VLayout' } }))
      .toThrow('dataSources array');
  });

  test('rejects config without layout', () => {
    expect(() => validateConfig({ dataSources: [] }))
      .toThrow('layout object');
  });

  test('rejects dataSource without ID', () => {
    expect(() => validateConfig({
      dataSources: [{ fields: [] }],
      layout: { _type: 'VLayout' },
    })).toThrow('must have an ID');
  });

  test('rejects dataSource without fields', () => {
    expect(() => validateConfig({
      dataSources: [{ ID: 'TestDS' }],
      layout: { _type: 'VLayout' },
    })).toThrow('must have fields array');
  });

  test('accepts valid config', () => {
    expect(() => validateConfig(SAMPLE_CONFIG)).not.toThrow();
  });
});

describe('deriveName', () => {

  test('extracts hostname from URL', () => {
    expect(deriveName('https://www.example.com/page')).toBe('example.com');
  });

  test('returns short prompt as-is', () => {
    expect(deriveName('Task manager')).toBe('Task manager');
  });

  test('truncates long prompt at word boundary', () => {
    const long = 'Create a comprehensive dashboard with multiple widgets and filters';
    const name = deriveName(long);
    expect(name.length).toBeLessThanOrEqual(44); // 40 + "..."
    expect(name).toContain('...');
  });

  test('returns Untitled App for null input', () => {
    expect(deriveName(null)).toBe('Untitled App');
  });
});

describe('Backward Compatibility', () => {

  test('legacy app load still works (SC_PLAYGROUND_LOAD_APP pattern)', async () => {
    // Simulate loading a legacy app (no project binding)
    playgroundSession.config = SAMPLE_CONFIG;
    playgroundSession.appId = 'app_legacy';
    playgroundSession.appName = 'Legacy';

    expect(playgroundSession.projectId).toBeNull();

    // Save should go to flat app, not project
    mockBridgeClient.afAppSave.mockResolvedValue({
      success: true,
      app: { id: 'app_legacy', name: 'Legacy' },
    });

    const result = await handlePlaygroundSave();
    expect(result.success).toBe(true);
    expect(mockBridgeClient.afAppSave).toHaveBeenCalled();
    expect(mockBridgeClient.afProjectSave).not.toHaveBeenCalled();
  });

  test('generate without project does not call afProjectSave', async () => {
    mockBridgeClient.generateSmartClientUI.mockResolvedValue({
      success: true,
      config: SAMPLE_CONFIG,
    });

    await handlePlaygroundGenerate({ prompt: 'No project context' });

    expect(mockBridgeClient.afProjectSave).not.toHaveBeenCalled();
  });
});
