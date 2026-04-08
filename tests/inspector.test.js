/**
 * Tests for inspector.js — Config tree walker + immutable mutations.
 */

const {
  buildTreeFromConfig,
  getNodeAtPath,
  getPropertiesForNode,
  setPropertyOnConfig,
  addNodeToConfig,
  removeNodeFromConfig,
  moveNodeInConfig,
} = require('../extension/smartclient-app/inspector.js');

// --- Test fixtures ---

function makeConfig() {
  return {
    dataSources: [
      { ID: 'TaskDS', fields: [{ name: 'id', type: 'integer', primaryKey: true }, { name: 'title', type: 'text' }] },
    ],
    layout: {
      _type: 'VLayout',
      width: '100%',
      height: '100%',
      members: [
        {
          _type: 'ForgeListGrid',
          ID: 'taskGrid',
          dataSource: 'TaskDS',
          autoFetchData: true,
          fields: [{ name: 'title', width: '*' }],
        },
        {
          _type: 'DynamicForm',
          ID: 'taskForm',
          dataSource: 'TaskDS',
          numCols: 2,
        },
        {
          _type: 'HLayout',
          height: 30,
          members: [
            { _type: 'Button', ID: 'newBtn', title: 'New', _action: 'new' },
            { _type: 'Button', ID: 'saveBtn', title: 'Save', _action: 'save' },
          ],
        },
      ],
    },
  };
}

function makeNestedConfig() {
  return {
    dataSources: [],
    layout: {
      _type: 'VLayout',
      members: [
        {
          _type: 'TabSet',
          ID: 'mainTabs',
          tabs: [
            { _type: 'Tab', title: 'Tab 1', pane: { _type: 'Label', contents: 'Hello' } },
            { _type: 'Tab', title: 'Tab 2', pane: { _type: 'VLayout', members: [{ _type: 'Button', title: 'Click' }] } },
          ],
        },
      ],
    },
  };
}

// --- buildTreeFromConfig ---

describe('buildTreeFromConfig', () => {
  test('returns empty array for null/undefined config', () => {
    expect(buildTreeFromConfig(null)).toEqual([]);
    expect(buildTreeFromConfig(undefined)).toEqual([]);
    expect(buildTreeFromConfig({})).toEqual([]);
  });

  test('builds flat tree from simple config', () => {
    const config = makeConfig();
    const tree = buildTreeFromConfig(config);

    expect(tree.length).toBe(6); // VLayout, ForgeListGrid, DynamicForm, HLayout, Button x2

    // Root node
    expect(tree[0]).toMatchObject({
      id: 1,
      title: 'VLayout',
      type: 'VLayout',
      nodePath: 'layout',
      isFolder: true,
    });
    expect(tree[0].parentId).toBeUndefined();

    // First child
    expect(tree[1]).toMatchObject({
      parentId: 1,
      title: 'ForgeListGrid (taskGrid)',
      type: 'ForgeListGrid',
      nodePath: 'layout.members[0]',
    });

    // Form
    expect(tree[2]).toMatchObject({
      parentId: 1,
      title: 'DynamicForm (taskForm)',
      type: 'DynamicForm',
      nodePath: 'layout.members[1]',
    });

    // HLayout (folder with children)
    expect(tree[3]).toMatchObject({
      parentId: 1,
      type: 'HLayout',
      isFolder: true,
      nodePath: 'layout.members[2]',
    });

    // Buttons inside HLayout
    expect(tree[4]).toMatchObject({
      parentId: tree[3].id,
      type: 'Button',
      title: 'Button (newBtn)',
      nodePath: 'layout.members[2].members[0]',
    });
    expect(tree[5]).toMatchObject({
      parentId: tree[3].id,
      type: 'Button',
      title: 'Button (saveBtn)',
      nodePath: 'layout.members[2].members[1]',
    });
  });

  test('handles TabSet with tabs child array', () => {
    const config = makeNestedConfig();
    const tree = buildTreeFromConfig(config);

    // VLayout > TabSet > Tab1, Tab2
    expect(tree.length).toBeGreaterThanOrEqual(3);
    const tabSet = tree.find(n => n.type === 'TabSet');
    expect(tabSet).toBeDefined();
    expect(tabSet.isFolder).toBe(true);

    const tabs = tree.filter(n => n.type === 'Tab');
    expect(tabs.length).toBe(2);
    expect(tabs[0].parentId).toBe(tabSet.id);
  });

  test('assigns unique IDs to all nodes', () => {
    const tree = buildTreeFromConfig(makeConfig());
    const ids = tree.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// --- getNodeAtPath ---

describe('getNodeAtPath', () => {
  test('returns root layout', () => {
    const config = makeConfig();
    const node = getNodeAtPath(config, 'layout');
    expect(node._type).toBe('VLayout');
    expect(node.members.length).toBe(3);
  });

  test('returns nested child', () => {
    const config = makeConfig();
    const node = getNodeAtPath(config, 'layout.members[0]');
    expect(node._type).toBe('ForgeListGrid');
    expect(node.ID).toBe('taskGrid');
  });

  test('returns deeply nested child', () => {
    const config = makeConfig();
    const node = getNodeAtPath(config, 'layout.members[2].members[1]');
    expect(node._type).toBe('Button');
    expect(node.ID).toBe('saveBtn');
  });

  test('returns undefined for invalid path', () => {
    const config = makeConfig();
    expect(getNodeAtPath(config, 'layout.members[99]')).toBeUndefined();
    expect(getNodeAtPath(config, 'nonexistent')).toBeUndefined();
    expect(getNodeAtPath(null, 'layout')).toBeUndefined();
    expect(getNodeAtPath(config, null)).toBeUndefined();
  });
});

// --- getPropertiesForNode ---

describe('getPropertiesForNode', () => {
  test('returns property descriptors for a component', () => {
    const config = makeConfig();
    const props = getPropertiesForNode(config, 'layout.members[0]');

    expect(props.length).toBeGreaterThan(0);

    const typeProp = props.find(p => p.name === '_type');
    expect(typeProp).toMatchObject({ value: 'ForgeListGrid', editable: false });

    const idProp = props.find(p => p.name === 'ID');
    expect(idProp).toMatchObject({ value: 'taskGrid', editable: true });

    const autoFetch = props.find(p => p.name === 'autoFetchData');
    expect(autoFetch).toMatchObject({ value: true, type: 'boolean', editable: true });
  });

  test('skips child arrays and function values', () => {
    const config = makeConfig();
    const props = getPropertiesForNode(config, 'layout');
    const names = props.map(p => p.name);
    expect(names).not.toContain('members');
  });

  test('skips fields array (array of objects)', () => {
    const config = makeConfig();
    const props = getPropertiesForNode(config, 'layout.members[0]');
    const names = props.map(p => p.name);
    expect(names).not.toContain('fields');
  });

  test('returns empty for invalid path', () => {
    expect(getPropertiesForNode(makeConfig(), 'layout.members[99]')).toEqual([]);
  });
});

// --- setPropertyOnConfig ---

describe('setPropertyOnConfig', () => {
  test('sets a simple property immutably', () => {
    const original = makeConfig();
    const updated = setPropertyOnConfig(original, 'layout.members[0]', 'autoFetchData', false);

    // Original unchanged
    expect(original.layout.members[0].autoFetchData).toBe(true);
    // New config updated
    expect(updated.layout.members[0].autoFetchData).toBe(false);
  });

  test('sets string property', () => {
    const original = makeConfig();
    const updated = setPropertyOnConfig(original, 'layout.members[2].members[0]', 'title', 'Create');
    expect(updated.layout.members[2].members[0].title).toBe('Create');
    expect(original.layout.members[2].members[0].title).toBe('New');
  });

  test('adds new property', () => {
    const original = makeConfig();
    const updated = setPropertyOnConfig(original, 'layout.members[0]', 'canEdit', true);
    expect(updated.layout.members[0].canEdit).toBe(true);
    expect(original.layout.members[0].canEdit).toBeUndefined();
  });

  test('returns original config for invalid path', () => {
    const original = makeConfig();
    const result = setPropertyOnConfig(original, 'layout.members[99]', 'foo', 'bar');
    expect(result).toBe(original);
  });
});

// --- addNodeToConfig ---

describe('addNodeToConfig', () => {
  test('adds node at end of members', () => {
    const original = makeConfig();
    const newNode = { _type: 'Label', contents: 'Footer' };
    const updated = addNodeToConfig(original, 'layout', newNode);

    expect(updated.layout.members.length).toBe(4);
    expect(updated.layout.members[3]._type).toBe('Label');
    // Original unchanged
    expect(original.layout.members.length).toBe(3);
  });

  test('adds node at specific position', () => {
    const original = makeConfig();
    const newNode = { _type: 'Label', contents: 'Header' };
    const updated = addNodeToConfig(original, 'layout', newNode, 0);

    expect(updated.layout.members.length).toBe(4);
    expect(updated.layout.members[0]._type).toBe('Label');
    expect(updated.layout.members[1]._type).toBe('ForgeListGrid');
  });

  test('adds node to empty parent (creates members array)', () => {
    const config = {
      dataSources: [],
      layout: { _type: 'VLayout' },
    };
    const updated = addNodeToConfig(config, 'layout', { _type: 'Button', title: 'Click' });
    expect(updated.layout.members.length).toBe(1);
    expect(updated.layout.members[0]._type).toBe('Button');
  });

  test('adds node using custom child key', () => {
    const config = makeNestedConfig();
    const newTab = { _type: 'Tab', title: 'Tab 3' };
    const updated = addNodeToConfig(config, 'layout.members[0]', newTab, 'end', 'tabs');
    expect(updated.layout.members[0].tabs.length).toBe(3);
    expect(updated.layout.members[0].tabs[2].title).toBe('Tab 3');
  });

  test('returns original for invalid parent path', () => {
    const original = makeConfig();
    const result = addNodeToConfig(original, 'layout.members[99]', { _type: 'Label' });
    expect(result).toBe(original);
  });
});

// --- removeNodeFromConfig ---

describe('removeNodeFromConfig', () => {
  test('removes a child node', () => {
    const original = makeConfig();
    const updated = removeNodeFromConfig(original, 'layout.members[1]');

    expect(updated.layout.members.length).toBe(2);
    expect(updated.layout.members[0]._type).toBe('ForgeListGrid');
    expect(updated.layout.members[1]._type).toBe('HLayout');
    // Original unchanged
    expect(original.layout.members.length).toBe(3);
  });

  test('removes deeply nested node', () => {
    const original = makeConfig();
    const updated = removeNodeFromConfig(original, 'layout.members[2].members[0]');

    expect(updated.layout.members[2].members.length).toBe(1);
    expect(updated.layout.members[2].members[0].ID).toBe('saveBtn');
  });

  test('cannot remove root layout', () => {
    const original = makeConfig();
    const result = removeNodeFromConfig(original, 'layout');
    expect(result).toBe(original);
  });
});

// --- moveNodeInConfig ---

describe('moveNodeInConfig', () => {
  test('moves a node within same parent (reorder)', () => {
    const original = makeConfig();
    // Move the HLayout (index 2) to position 0
    const updated = moveNodeInConfig(original, 'layout.members[2]', 'layout', 0);

    expect(updated.layout.members.length).toBe(3);
    expect(updated.layout.members[0]._type).toBe('HLayout');
    expect(updated.layout.members[1]._type).toBe('ForgeListGrid');
    expect(updated.layout.members[2]._type).toBe('DynamicForm');
  });

  test('moves a node to different parent', () => {
    const original = makeConfig();
    // Move a Button from HLayout (index 2) into root layout
    // This avoids index-shift since the source is deeper than the target
    const updated = moveNodeInConfig(original, 'layout.members[2].members[0]', 'layout', 1);

    // Root should now have 4 children (grid, newBtn, form, hlayout)
    expect(updated.layout.members.length).toBe(4);
    expect(updated.layout.members[1]._type).toBe('Button');
    expect(updated.layout.members[1].ID).toBe('newBtn');
    // HLayout should have 1 child left (saveBtn)
    expect(updated.layout.members[3]._type).toBe('HLayout');
    expect(updated.layout.members[3].members.length).toBe(1);
  });

  test('returns original for invalid from path', () => {
    const original = makeConfig();
    const result = moveNodeInConfig(original, 'layout.members[99]', 'layout');
    expect(result).toBe(original);
  });
});

// --- Immutability guarantees ---

describe('immutability', () => {
  test('setPropertyOnConfig does not mutate original', () => {
    const original = makeConfig();
    const originalJson = JSON.stringify(original);
    setPropertyOnConfig(original, 'layout.members[0]', 'autoFetchData', false);
    expect(JSON.stringify(original)).toBe(originalJson);
  });

  test('addNodeToConfig does not mutate original', () => {
    const original = makeConfig();
    const originalJson = JSON.stringify(original);
    addNodeToConfig(original, 'layout', { _type: 'Label' });
    expect(JSON.stringify(original)).toBe(originalJson);
  });

  test('removeNodeFromConfig does not mutate original', () => {
    const original = makeConfig();
    const originalJson = JSON.stringify(original);
    removeNodeFromConfig(original, 'layout.members[1]');
    expect(JSON.stringify(original)).toBe(originalJson);
  });

  test('moveNodeInConfig does not mutate original', () => {
    const original = makeConfig();
    const originalJson = JSON.stringify(original);
    moveNodeInConfig(original, 'layout.members[2]', 'layout', 0);
    expect(JSON.stringify(original)).toBe(originalJson);
  });
});
