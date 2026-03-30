/**
 * inspector.js — Config tree walker + immutable mutation functions.
 *
 * Pure logic module (no SC dependency, no UI).
 * Operates on the shared {dataSources, layout} config JSON.
 *
 * Every mutation returns a NEW config object (immutable pattern).
 */

// ---- Helpers ----

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Parse a nodePath string into an array of path segments.
 * "layout.members[0].members[1]" → ["layout", "members", 0, "members", 1]
 */
function parsePath(nodePath) {
  var parts = [];
  var segments = nodePath.split('.');
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    var bracketIdx = seg.indexOf('[');
    if (bracketIdx === -1) {
      parts.push(seg);
    } else {
      parts.push(seg.substring(0, bracketIdx));
      var rest = seg.substring(bracketIdx);
      var matches = rest.match(/\[(\d+)\]/g);
      if (matches) {
        for (var j = 0; j < matches.length; j++) {
          parts.push(parseInt(matches[j].slice(1, -1), 10));
        }
      }
    }
  }
  return parts;
}

/**
 * Resolve a parsed path array against an object.
 */
function resolvePathParts(obj, parts) {
  var current = obj;
  for (var i = 0; i < parts.length; i++) {
    if (current == null) return undefined;
    current = current[parts[i]];
  }
  return current;
}

/**
 * Set a value at a parsed path array on a (cloned) object.
 */
function setAtPathParts(obj, parts, value) {
  var current = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

// ---- Public API ----

/**
 * Build a flat tree array from config for use with SC TreeGrid.
 * Returns [{id, parentId, title, type, nodePath, isFolder}]
 */
function buildTreeFromConfig(config) {
  if (!config || !config.layout) return [];
  var nodes = [];
  var nextId = 1;

  function walk(node, parentId, path) {
    if (!node || typeof node !== 'object') return;

    var type = node._type || node.type || 'Unknown';
    var label = node.ID ? type + ' (' + node.ID + ')' : type;
    var childArrays = ['members', 'tabs', 'panes', 'items', 'portlets', 'sections', 'controls'];
    var hasChildren = false;

    for (var i = 0; i < childArrays.length; i++) {
      if (Array.isArray(node[childArrays[i]]) && node[childArrays[i]].length > 0) {
        hasChildren = true;
        break;
      }
    }

    var id = nextId++;
    var entry = {
      id: id,
      title: label,
      type: type,
      nodePath: path,
      isFolder: hasChildren,
    };
    if (parentId != null) entry.parentId = parentId;
    nodes.push(entry);

    for (var ci = 0; ci < childArrays.length; ci++) {
      var arr = node[childArrays[ci]];
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        walk(arr[j], id, path + '.' + childArrays[ci] + '[' + j + ']');
      }
    }
  }

  walk(config.layout, null, 'layout');
  return nodes;
}

/**
 * Get the node object at a given path.
 * nodePath: "layout" | "layout.members[0]" | "layout.members[0].members[1]"
 */
function getNodeAtPath(config, nodePath) {
  if (!config || !nodePath) return undefined;
  var parts = parsePath(nodePath);
  return resolvePathParts(config, parts);
}

/**
 * Get property descriptors for a node at the given path.
 * Returns [{name, value, type, editable}]
 */
function getPropertiesForNode(config, nodePath) {
  var node = getNodeAtPath(config, nodePath);
  if (!node || typeof node !== 'object') return [];

  var skipKeys = {
    members: true, tabs: true, panes: true, items: true,
    portlets: true, sections: true, controls: true, fields: true,
  };

  var props = [];
  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (skipKeys[key]) continue;
    var val = node[key];
    if (typeof val === 'function') continue;
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') continue;

    var propType = 'text';
    if (typeof val === 'boolean') propType = 'boolean';
    else if (typeof val === 'number') propType = 'integer';

    props.push({
      name: key,
      value: val,
      type: propType,
      editable: key !== '_type' && key !== 'type',
    });
  }
  return props;
}

/**
 * Immutably set a property on a node. Returns new config.
 */
function setPropertyOnConfig(config, nodePath, propName, value) {
  var clone = deepClone(config);
  var parts = parsePath(nodePath);
  var node = resolvePathParts(clone, parts);
  if (!node || typeof node !== 'object') return config;
  node[propName] = value;
  return clone;
}

/**
 * Immutably add a child node. Returns new config.
 * parentPath: path to parent node
 * newNode: component config to insert
 * position: index to insert at (default: end), or 'end'
 * childKey: which child array to use (default: 'members')
 */
function addNodeToConfig(config, parentPath, newNode, position, childKey) {
  var clone = deepClone(config);
  var parts = parsePath(parentPath);
  var parent = resolvePathParts(clone, parts);
  if (!parent || typeof parent !== 'object') return config;

  var key = childKey || 'members';
  if (!Array.isArray(parent[key])) parent[key] = [];

  var arr = parent[key];
  var idx = (position == null || position === 'end') ? arr.length : position;
  idx = Math.max(0, Math.min(idx, arr.length));
  arr.splice(idx, 0, deepClone(newNode));
  return clone;
}

/**
 * Immutably remove a node. Returns new config.
 */
function removeNodeFromConfig(config, nodePath) {
  if (nodePath === 'layout') return config; // can't remove root

  var clone = deepClone(config);
  var parts = parsePath(nodePath);
  if (parts.length < 2) return config;

  // Last part is the index into the parent array
  var parentParts = parts.slice(0, -1);
  var idx = parts[parts.length - 1];
  var parentArr = resolvePathParts(clone, parentParts);

  if (Array.isArray(parentArr) && typeof idx === 'number') {
    parentArr.splice(idx, 1);
    return clone;
  }
  return config;
}

/**
 * Immutably move a node from one location to another. Returns new config.
 * fromPath: current nodePath of the node
 * toParentPath: nodePath of the new parent
 * position: index in the new parent's children (default: end)
 * childKey: which child array to target (default: 'members')
 */
function moveNodeInConfig(config, fromPath, toParentPath, position, childKey) {
  var node = getNodeAtPath(config, fromPath);
  if (!node) return config;

  var nodeCopy = deepClone(node);
  var withoutNode = removeNodeFromConfig(config, fromPath);
  return addNodeToConfig(withoutNode, toParentPath, nodeCopy, position, childKey);
}

// ---- Exports ----

if (typeof window !== 'undefined') {
  window.ConfigInspector = {
    buildTreeFromConfig: buildTreeFromConfig,
    getNodeAtPath: getNodeAtPath,
    getPropertiesForNode: getPropertiesForNode,
    setPropertyOnConfig: setPropertyOnConfig,
    addNodeToConfig: addNodeToConfig,
    removeNodeFromConfig: removeNodeFromConfig,
    moveNodeInConfig: moveNodeInConfig,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildTreeFromConfig: buildTreeFromConfig,
    getNodeAtPath: getNodeAtPath,
    getPropertiesForNode: getPropertiesForNode,
    setPropertyOnConfig: setPropertyOnConfig,
    addNodeToConfig: addNodeToConfig,
    removeNodeFromConfig: removeNodeFromConfig,
    moveNodeInConfig: moveNodeInConfig,
  };
}
