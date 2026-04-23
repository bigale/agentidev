/**
 * App from PICT — generates a SmartClient plugin from PICT models + spec.
 *
 * Unlike the generic app-generator.mjs, this module reads the actual PICT
 * models to extract validated parameter values, and uses PICT TSV output
 * to infer column shapes. The result is a tighter app that matches what
 * the API tests already proved works.
 *
 * The generated plugin is auto-published via SC_PUBLISH_PLUGIN.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { loadSpec, extractEndpoints, resolveSchema } from './spec-analyzer.mjs';

/**
 * Parse a .pict model file and extract parameter names + valid values.
 * Strips comments, constraints, and ~ negative values.
 *
 * @param {string} modelText - Raw .pict file content
 * @returns {Map<string, string[]>} param name → valid values (no ~ prefix)
 */
export function parsePictParams(modelText) {
  const params = new Map();
  for (const line of modelText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('IF ')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const name = trimmed.substring(0, colonIdx).trim();
    const values = trimmed.substring(colonIdx + 1).split(',')
      .map(v => v.trim())
      .filter(v => !v.startsWith('~') && v !== 'omit');
    if (values.length > 0) params.set(name, values);
  }
  return params;
}

/**
 * Parse a TSV file to extract column names and sample data.
 *
 * @param {string} tsvContent
 * @returns {{ columns: string[], sampleRow: object }}
 */
export function parseTsvColumns(tsvContent) {
  const lines = tsvContent.trim().split('\n');
  if (lines.length < 2) return { columns: [], sampleRow: {} };
  const columns = lines[0].split('\t');
  const values = lines[1].split('\t');
  const sampleRow = {};
  columns.forEach((col, i) => { sampleRow[col] = values[i] || ''; });
  return { columns, sampleRow };
}

/**
 * Generate a SmartClient plugin config from PICT models + OpenAPI spec.
 *
 * @param {object} options
 * @param {string} options.specPath - Path to OpenAPI spec JSON
 * @param {string} options.modelsDir - Directory containing .pict and .tsv files
 * @param {string} options.baseUrl - API base URL
 * @param {string} options.entity - Primary entity name (e.g. "Pet")
 * @returns {{ config: object, handlers: string, pluginId: string, manifest: object }}
 */
export function generateAppFromPict(options) {
  const { specPath, modelsDir, baseUrl, entity = 'Pet' } = options;
  const spec = loadSpec(specPath);
  const endpoints = extractEndpoints(spec);
  const entityLower = entity.toLowerCase();
  const pluginId = entityLower + '-app';

  // Load PICT models for relevant endpoints
  const models = {};
  const tsvData = {};
  const entityEndpoints = endpoints.filter(ep =>
    ep.tags?.some(t => t.toLowerCase() === entityLower) ||
    ep.path.toLowerCase().includes('/' + entityLower)
  );

  for (const ep of entityEndpoints) {
    const modelPath = resolve(modelsDir, ep.operationId + '.pict');
    const tsvPath = resolve(modelsDir, ep.operationId + '.tsv');
    if (existsSync(modelPath)) {
      models[ep.operationId] = parsePictParams(readFileSync(modelPath, 'utf-8'));
    }
    if (existsSync(tsvPath)) {
      tsvData[ep.operationId] = parseTsvColumns(readFileSync(tsvPath, 'utf-8'));
    }
  }

  // Classify endpoints
  const listOp = entityEndpoints.find(ep => ep.method === 'GET' && !ep.path.includes('{'));
  const getOp = entityEndpoints.find(ep => ep.method === 'GET' && ep.path.includes('{'));
  const createOp = entityEndpoints.find(ep => ep.method === 'POST' && !ep.path.includes('{'));
  const updateOp = entityEndpoints.find(ep => ep.method === 'PUT');
  const deleteOp = entityEndpoints.find(ep => ep.method === 'DELETE');

  // Resolve entity schema
  const schemas = spec.components?.schemas || spec.definitions || {};
  const entitySchema = schemas[entity] || {};
  const requiredFields = new Set(entitySchema.required || []);
  const properties = entitySchema.properties || {};

  // Build layout members
  const members = [];

  // Title
  members.push({
    _type: 'Label',
    height: 35,
    contents: '<span style="font-size:18px;color:#a8b4ff;font-weight:600">' + entity + ' Explorer</span>',
  });
  members.push({
    _type: 'Label',
    height: 18,
    contents: '<span style="font-size:11px;color:#666">API: ' + baseUrl + ' | PICT-tested endpoints</span>',
  });

  // Filter form — values from PICT model
  if (listOp) {
    const listParams = models[listOp.operationId];
    const queryParam = listOp.parameters.find(p => p.in === 'query');
    if (queryParam && listParams) {
      const validValues = listParams.get(queryParam.name) || [];
      const valueMap = {};
      validValues.forEach(v => { valueMap[v] = v; });

      members.push({
        _type: 'DynamicForm',
        ID: 'filterForm',
        height: 35,
        numCols: 4,
        fields: [{
          name: queryParam.name,
          title: queryParam.name.charAt(0).toUpperCase() + queryParam.name.slice(1),
          type: 'select',
          defaultValue: validValues[0] || 'available',
          valueMap,
        }],
      });
    }

    // Fetch button
    members.push({
      _type: 'HLayout',
      height: 30,
      membersMargin: 8,
      members: [
        {
          _type: 'Button',
          ID: 'btnFetch',
          title: 'Fetch ' + entity + 's',
          width: 120,
          _action: 'fetchUrlAndLoadGrid',
          _fetchUrl: baseUrl + listOp.path,
          _payloadFrom: 'filterForm',
          _targetGrid: 'mainGrid',
          _statusCanvas: 'fetchStatus',
          _dynamicFields: true,
          _flattenObjects: true,
          _timeoutMs: 15000,
        },
        {
          _type: 'HTMLFlow',
          ID: 'fetchStatus',
          width: '*',
          height: 24,
          contents: '<span style="color:#888;font-size:11px">Click Fetch to load data</span>',
        },
      ],
    });
  }

  // Main grid — columns from TSV data or schema
  const gridColumns = buildGridColumns(entity, listOp, tsvData, properties);
  members.push({
    _type: 'ListGrid',
    ID: 'mainGrid',
    width: '100%',
    height: '*',
    canEdit: false,
    alternateRecordStyles: true,
    emptyMessage: 'Click Fetch to load ' + entityLower + 's',
    fields: gridColumns,
  });

  // Create form — fields from PICT body params
  if (createOp) {
    const createParams = models[createOp.operationId];
    members.push({
      _type: 'Label',
      height: 25,
      contents: '<span style="font-size:13px;color:#aaa;font-weight:600">Create ' + entity + '</span>',
    });

    const formFields = buildCreateFormFields(entity, createParams, properties, requiredFields);
    members.push({
      _type: 'DynamicForm',
      ID: 'createForm',
      height: 60,
      numCols: 4,
      fields: formFields,
    });

    members.push({
      _type: 'HLayout',
      height: 30,
      membersMargin: 8,
      members: [
        {
          _type: 'Button',
          ID: 'btnCreate',
          title: 'Create',
          width: 80,
          _action: 'fetchUrlAndLoadGrid',
          _fetchUrl: baseUrl + createOp.path,
          _fetchMethod: 'POST',
          _payloadFrom: 'createForm',
          _targetGrid: 'mainGrid',
          _statusCanvas: 'createStatus',
          _dynamicFields: true,
          _flattenObjects: true,
          _timeoutMs: 15000,
        },
        {
          _type: 'HTMLFlow',
          ID: 'createStatus',
          width: '*',
          height: 24,
        },
      ],
    });
  }

  const config = {
    dataSources: [],
    layout: {
      _type: 'VLayout',
      width: '100%',
      height: '100%',
      padding: 12,
      membersMargin: 6,
      members,
    },
  };

  // Build handlers
  const handlers = buildHandlers(entity, { listOp, createOp, baseUrl, properties });

  const manifest = {
    id: pluginId,
    name: entity + ' Explorer',
    version: '0.1.0',
    description: 'PICT-tested ' + entity + ' CRUD from ' + (spec.info?.title || 'API'),
    modes: [pluginId],
    templates: { dashboard: '__storage__' },
    source: 'api-to-app',
  };

  return { config, handlers, pluginId, manifest };
}

/**
 * Generate a multi-entity app with a TabSet (one tab per entity).
 *
 * @param {object} options
 * @param {string} options.specPath
 * @param {string} options.modelsDir
 * @param {string} options.baseUrl
 * @param {string[]} options.entities - e.g. ['Pet', 'Order']
 * @returns {{ config: object, handlers: string, pluginId: string, manifest: object }}
 */
export function generateMultiEntityApp(options) {
  const { specPath, modelsDir, baseUrl, entities } = options;
  const spec = loadSpec(specPath);
  const allEndpoints = extractEndpoints(spec);
  const pluginId = entities.map(e => e.toLowerCase()).join('-') + '-app';

  const tabs = [];
  const allHandlers = [];

  for (const entity of entities) {
    const entityLower = entity.toLowerCase();
    const prefix = entityLower; // Prefix for unique component IDs

    const entityEndpoints = allEndpoints.filter(ep =>
      ep.tags?.some(t => t.toLowerCase() === entityLower) ||
      ep.path.toLowerCase().includes('/' + entityLower)
    );

    // Load PICT models
    const models = {};
    for (const ep of entityEndpoints) {
      const modelPath = resolve(modelsDir, ep.operationId + '.pict');
      if (existsSync(modelPath)) {
        models[ep.operationId] = parsePictParams(readFileSync(modelPath, 'utf-8'));
      }
    }

    // Classify endpoints
    const listOp = entityEndpoints.find(ep => ep.method === 'GET' && !ep.path.includes('{'));
    const createOp = entityEndpoints.find(ep => ep.method === 'POST' && !ep.path.includes('{'));

    // Schema
    const schemas = spec.components?.schemas || spec.definitions || {};
    const entitySchema = schemas[entity] || {};
    const requiredFields = new Set(entitySchema.required || []);
    const properties = entitySchema.properties || {};

    // Build tab content
    const tabMembers = [];

    // Filter form
    if (listOp) {
      const listParams = models[listOp.operationId];
      const queryParam = listOp.parameters.find(p => p.in === 'query');
      if (queryParam && listParams) {
        const validValues = listParams.get(queryParam.name) || [];
        const valueMap = {};
        validValues.forEach(v => { valueMap[v] = v; });
        tabMembers.push({
          _type: 'DynamicForm',
          ID: prefix + 'FilterForm',
          height: 35,
          numCols: 4,
          fields: [{ name: queryParam.name, title: queryParam.name.charAt(0).toUpperCase() + queryParam.name.slice(1), type: 'select', defaultValue: validValues[0], valueMap }],
        });
      }

      tabMembers.push({
        _type: 'HLayout',
        height: 30,
        membersMargin: 8,
        members: [
          {
            _type: 'Button',
            ID: prefix + 'BtnFetch',
            title: 'Fetch ' + entity + 's',
            width: 120,
            _action: 'fetchUrlAndLoadGrid',
            _fetchUrl: baseUrl + listOp.path,
            _payloadFrom: prefix + 'FilterForm',
            _targetGrid: prefix + 'Grid',
            _statusCanvas: prefix + 'Status',
            _dynamicFields: true,
            _flattenObjects: true,
            _timeoutMs: 15000,
          },
          { _type: 'HTMLFlow', ID: prefix + 'Status', width: '*', height: 24, contents: '<span style="color:#888;font-size:11px">Click Fetch</span>' },
        ],
      });
    }

    // Grid
    const gridFields = [];
    for (const [name, prop] of Object.entries(properties)) {
      if (name === 'id') continue;
      const field = { name, title: name.charAt(0).toUpperCase() + name.slice(1) };
      field.width = name === 'name' ? '*' : 90;
      if (prop.enum) { field.valueMap = {}; prop.enum.forEach(v => { field.valueMap[v] = v; }); }
      gridFields.push(field);
    }
    tabMembers.push({
      _type: 'ListGrid',
      ID: prefix + 'Grid',
      width: '100%',
      height: '*',
      canEdit: false,
      alternateRecordStyles: true,
      emptyMessage: 'Click Fetch to load ' + entityLower + 's',
      fields: gridFields.length > 0 ? gridFields : undefined,
    });

    // Create form
    if (createOp) {
      const createParams = models[createOp.operationId];
      tabMembers.push({ _type: 'Label', height: 22, contents: '<span style="font-size:12px;color:#aaa;font-weight:600">Create ' + entity + '</span>' });
      const formFields = buildCreateFormFields(entity, createParams, properties, requiredFields);
      tabMembers.push({ _type: 'DynamicForm', ID: prefix + 'CreateForm', height: 50, numCols: 4, fields: formFields });
      tabMembers.push({
        _type: 'HLayout', height: 28, membersMargin: 8,
        members: [
          {
            _type: 'Button', ID: prefix + 'BtnCreate', title: 'Create', width: 80,
            _action: 'fetchUrlAndLoadGrid', _fetchUrl: baseUrl + createOp.path, _fetchMethod: 'POST',
            _payloadFrom: prefix + 'CreateForm', _targetGrid: prefix + 'Grid', _statusCanvas: prefix + 'CreateStatus',
            _dynamicFields: true, _flattenObjects: true, _timeoutMs: 15000,
          },
          { _type: 'HTMLFlow', ID: prefix + 'CreateStatus', width: '*', height: 24 },
        ],
      });
    }

    tabs.push({
      title: entity,
      pane: {
        _type: 'VLayout',
        width: '100%',
        height: '100%',
        padding: 8,
        membersMargin: 6,
        members: tabMembers,
      },
    });

    // Handlers (for reference — not loaded for storage-backed plugins)
    allHandlers.push('// --- ' + entity + ' handlers ---');
    allHandlers.push(buildHandlers(entity, { listOp, createOp, baseUrl, properties }));
  }

  const config = {
    dataSources: [],
    layout: {
      _type: 'VLayout',
      width: '100%',
      height: '100%',
      members: [
        {
          _type: 'Label',
          height: 35,
          contents: '<span style="font-size:18px;color:#a8b4ff;font-weight:600">' + entities.join(' + ') + ' Explorer</span>',
        },
        {
          _type: 'Label',
          height: 18,
          contents: '<span style="font-size:11px;color:#666">API: ' + baseUrl + ' | ' + entities.length + ' entities | PICT-tested</span>',
        },
        {
          _type: 'TabSet',
          ID: 'entityTabs',
          width: '100%',
          height: '*',
          tabs,
        },
      ],
    },
  };

  const manifest = {
    id: pluginId,
    name: entities.join(' + ') + ' Explorer',
    version: '0.1.0',
    description: 'Multi-entity PICT-tested CRUD from ' + (spec.info?.title || 'API'),
    modes: [pluginId],
    templates: { dashboard: '__storage__' },
    source: 'api-to-app',
  };

  return { config, handlers: allHandlers.join('\n\n'), pluginId, manifest };
}

function buildGridColumns(entity, listOp, tsvData, properties) {
  // Prefer columns from TSV data (actual API response shape)
  if (listOp && tsvData[listOp.operationId]) {
    const { columns } = tsvData[listOp.operationId];
    // TSV columns are PICT params (status, Accept, Auth), not API response fields.
    // Use schema properties instead for grid columns.
  }

  // Fall back to schema properties
  const fields = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (name === 'id') continue; // Skip ID — usually auto-generated
    const resolved = prop.$ref ? {} : prop; // Skip unresolved refs
    const field = { name, title: name.charAt(0).toUpperCase() + name.slice(1) };

    if (resolved.type === 'array' || resolved.properties) {
      field.width = 100;
    } else if (name === 'name') {
      field.width = '*';
    } else {
      field.width = 90;
    }

    if (resolved.enum) {
      field.valueMap = {};
      resolved.enum.forEach(v => { field.valueMap[v] = v; });
    }

    fields.push(field);
  }
  return fields;
}

function buildCreateFormFields(entity, createParams, properties, requiredFields) {
  const fields = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (name === 'id') continue;
    if (prop.$ref || prop.properties || prop.type === 'array') continue; // Skip complex fields

    const field = {
      name,
      title: name.charAt(0).toUpperCase() + name.slice(1),
      required: requiredFields.has(name),
    };

    // Use PICT values as hints
    const pictKey = 'body_' + name;
    if (createParams && createParams.has(pictKey)) {
      const validValues = createParams.get(pictKey);
      if (prop.enum || validValues.length <= 5) {
        field.type = 'select';
        field.valueMap = {};
        validValues.forEach(v => { field.valueMap[v] = v; });
      }
    }

    fields.push(field);
  }
  return fields;
}

function buildHandlers(entity, ops) {
  const { listOp, createOp, baseUrl, properties } = ops;
  const upper = entity.toUpperCase();
  const lines = [];

  lines.push('// Auto-generated handlers for ' + entity + ' API (PICT-informed)');
  lines.push('export function register(handlers) {');

  if (listOp) {
    const qp = listOp.parameters.find(p => p.in === 'query');
    lines.push('  handlers[\'' + upper + '_LIST\'] = async (msg) => {');
    if (qp) {
      lines.push('    const url = \'' + baseUrl + listOp.path + '?\' + new URLSearchParams({' + qp.name + ': msg.' + qp.name + ' || \'available\'}).toString();');
    } else {
      lines.push('    const url = \'' + baseUrl + listOp.path + '\';');
    }
    lines.push('    const resp = await handlers[\'HOST_NETWORK_FETCH\']({ url, as: \'json\' });');
    lines.push('    if (!resp.ok) return { success: false, error: \'API returned \' + resp.status };');
    lines.push('    const data = Array.isArray(resp.json) ? resp.json : [resp.json];');
    // Flatten nested objects
    lines.push('    const flat = data.map(item => {');
    lines.push('      const row = {};');
    for (const [name, prop] of Object.entries(properties)) {
      if (prop.$ref || prop.properties) {
        lines.push('      row.' + name + ' = item.' + name + ' ? (item.' + name + '.name || JSON.stringify(item.' + name + ')) : \'\';');
      } else if (prop.type === 'array') {
        lines.push('      row.' + name + ' = Array.isArray(item.' + name + ') ? item.' + name + '.length + \' items\' : \'\';');
      } else {
        lines.push('      row.' + name + ' = item.' + name + ';');
      }
    }
    lines.push('      return row;');
    lines.push('    });');
    lines.push('    return { success: true, data: flat, totalRows: flat.length };');
    lines.push('  };');
  }

  if (createOp) {
    lines.push('  handlers[\'' + upper + '_CREATE\'] = async (msg) => {');
    lines.push('    const body = {};');
    for (const [name, prop] of Object.entries(properties)) {
      if (name === 'id') continue;
      if (prop.$ref || prop.properties || prop.type === 'array') continue;
      lines.push('    if (msg.' + name + ' != null) body.' + name + ' = msg.' + name + ';');
    }
    lines.push('    body.photoUrls = [\'https://example.com/photo.jpg\'];');
    lines.push('    const resp = await handlers[\'HOST_NETWORK_FETCH\']({');
    lines.push('      url: \'' + baseUrl + createOp.path + '\',');
    lines.push('      init: { method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify(body) },');
    lines.push('      as: \'json\',');
    lines.push('    });');
    lines.push('    if (!resp.ok) return { success: false, error: \'Create failed: \' + resp.status };');
    lines.push('    return { success: true, data: [resp.json], totalRows: 1 };');
    lines.push('  };');
  }

  lines.push('}');
  return lines.join('\n');
}
