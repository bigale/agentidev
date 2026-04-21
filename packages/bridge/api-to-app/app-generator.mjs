/**
 * App Generator — generates a SmartClient plugin config from an OpenAPI spec.
 *
 * This is the "App" in "API-to-App". Takes the analyzed spec and produces
 * a complete SmartClient UI config with:
 *   - DataSources bound to API endpoints via network_fetch
 *   - ListGrids for browsing collections
 *   - DynamicForms for creating/editing resources
 *   - Action buttons wired to handlers
 *
 * The generated config can be published as an agentidev plugin and rendered
 * in the SmartClient sandbox.
 */

import { loadSpec, extractEndpoints, resolveSchema } from './spec-analyzer.mjs';

/**
 * Generate a complete SmartClient plugin config from an OpenAPI spec.
 *
 * @param {string} specPath - Path to OpenAPI spec JSON
 * @param {object} options
 * @param {string} options.baseUrl - API base URL
 * @param {string} [options.entity='Pet'] - Primary entity name
 * @param {string[]} [options.operations] - Operation IDs to include
 * @returns {{ config: object, manifest: object, handlers: string }}
 */
export function generateApp(specPath, options = {}) {
  const { baseUrl, entity = 'Pet', operations } = options;
  const spec = loadSpec(specPath);
  const endpoints = extractEndpoints(spec);

  // Find relevant endpoints
  const entityLower = entity.toLowerCase();
  const relevant = operations
    ? endpoints.filter(ep => operations.includes(ep.operationId))
    : endpoints.filter(ep => ep.tags?.some(t => t.toLowerCase() === entityLower) || ep.path.includes('/' + entityLower));

  if (relevant.length === 0) {
    throw new Error(`No endpoints found for entity "${entity}". Available: ${endpoints.map(e => e.operationId).join(', ')}`);
  }

  // Classify endpoints by operation type
  const listOp = relevant.find(ep => ep.method === 'GET' && !ep.path.includes('{'));
  const getOp = relevant.find(ep => ep.method === 'GET' && ep.path.includes('{'));
  const createOp = relevant.find(ep => ep.method === 'POST' && !ep.path.includes('{'));
  const deleteOp = relevant.find(ep => ep.method === 'DELETE');

  // Resolve the entity schema
  const entitySchema = findEntitySchema(entity, spec);
  const fields = entitySchema ? schemaToFields(entitySchema, spec) : [];

  // Build the SmartClient config
  const config = {
    dataSources: [],
    layout: buildLayout(entity, fields, { listOp, getOp, createOp, deleteOp, baseUrl }),
  };

  // Build handler source code
  const handlers = buildHandlers(entity, { listOp, getOp, createOp, deleteOp, baseUrl, fields });

  // Build manifest
  const pluginId = entity.toLowerCase() + '-api';
  const manifest = {
    id: pluginId,
    name: entity + ' API Explorer',
    version: '0.1.0',
    description: `Auto-generated CRUD UI for ${entity} from ${spec.info?.title || 'OpenAPI spec'}`,
    modes: [pluginId],
    templates: { dashboard: '__storage__' },
    source: 'api-to-app',
  };

  return { config, manifest, handlers, pluginId, stats: {
    entity,
    endpoints: relevant.length,
    fields: fields.length,
    operations: { list: !!listOp, get: !!getOp, create: !!createOp, delete: !!deleteOp },
  }};
}

/**
 * Find the primary entity schema from the spec.
 */
function findEntitySchema(entity, spec) {
  // OpenAPI 3.0: components.schemas. Swagger 2.0: definitions
  const schemas = spec.components?.schemas || spec.definitions || {};
  return schemas[entity] || schemas[entity + 'Response'] || null;
}

/**
 * Convert a JSON Schema to SmartClient field descriptors.
 */
function schemaToFields(schema, spec) {
  const fields = [];
  const required = new Set(schema.required || []);

  for (const [name, prop] of Object.entries(schema.properties || {})) {
    const resolved = resolveSchema(prop, spec);
    const field = {
      name,
      title: name.charAt(0).toUpperCase() + name.slice(1),
      required: required.has(name),
    };

    if (resolved.type === 'integer' || resolved.type === 'number') {
      field.type = 'integer';
    } else if (resolved.type === 'boolean') {
      field.type = 'boolean';
    } else if (resolved.type === 'array') {
      field.type = 'text'; // Display as comma-separated
      field.isArray = true;
    } else if (resolved.properties) {
      // Nested object — flatten to "name.subfield" display
      field.type = 'text';
      field.isObject = true;
    } else {
      field.type = 'text';
    }

    if (resolved.enum) {
      field.valueMap = {};
      for (const v of resolved.enum) field.valueMap[v] = v;
    }

    if (name === 'id') {
      field.primaryKey = true;
      field.hidden = true;
    }

    fields.push(field);
  }

  return fields;
}

/**
 * Build the SmartClient layout config.
 */
function buildLayout(entity, fields, ops) {
  const { listOp, createOp, deleteOp, baseUrl } = ops;
  const members = [];

  // Title
  members.push({
    _type: 'Label',
    height: 35,
    contents: `<span style="font-size:18px;color:#a8b4ff;font-weight:600">${entity} API Explorer</span>`,
  });

  members.push({
    _type: 'Label',
    height: 20,
    contents: `<span style="font-size:11px;color:#888">Connected to ${baseUrl}</span>`,
  });

  // Search / Filter bar
  if (listOp) {
    const queryParam = listOp.parameters.find(p => p.in === 'query');
    if (queryParam) {
      const schema = queryParam.schema || queryParam.items || queryParam;
      const formFields = [];

      if (schema.enum) {
        formFields.push({
          name: queryParam.name,
          title: queryParam.name.charAt(0).toUpperCase() + queryParam.name.slice(1),
          type: 'select',
          defaultValue: schema.default || schema.enum[0],
          valueMap: Object.fromEntries(schema.enum.map(v => [v, v])),
        });
      } else {
        formFields.push({
          name: queryParam.name,
          title: queryParam.name.charAt(0).toUpperCase() + queryParam.name.slice(1),
          width: 200,
        });
      }

      members.push({
        _type: 'DynamicForm',
        ID: 'filterForm',
        height: 40,
        numCols: 4,
        fields: formFields,
      });
    }

    // Fetch button
    members.push({
      _type: 'HLayout',
      height: 35,
      membersMargin: 8,
      members: [
        {
          _type: 'Button',
          ID: 'btnFetch',
          title: 'Fetch ' + entity + 's',
          width: 120,
          _action: 'fetchAndLoadGrid',
          _messageType: entity.toUpperCase() + '_LIST',
          _payloadFrom: 'filterForm',
          _targetGrid: 'mainGrid',
          _statusCanvas: 'fetchStatus',
          _dynamicFields: true,
          _timeoutMs: 15000,
        },
        {
          _type: 'HTMLFlow',
          ID: 'fetchStatus',
          width: '*',
          height: 24,
          contents: '<span style="color:#888">Click Fetch to load data</span>',
        },
      ],
    });
  }

  // Main grid
  const gridFields = fields
    .filter(f => !f.hidden && !f.isObject)
    .map(f => ({
      name: f.name,
      title: f.title,
      width: f.name === 'name' ? '*' : (f.type === 'integer' ? 80 : 120),
      ...(f.valueMap ? { valueMap: f.valueMap } : {}),
    }));

  members.push({
    _type: 'ListGrid',
    ID: 'mainGrid',
    width: '100%',
    height: '*',
    canEdit: false,
    alternateRecordStyles: true,
    emptyMessage: 'No data loaded. Click Fetch to query the API.',
    fields: gridFields.length > 0 ? gridFields : undefined,
  });

  // Create form (if POST endpoint exists)
  if (createOp) {
    members.push({
      _type: 'Label',
      height: 25,
      contents: '<span style="font-size:13px;color:#aaa;font-weight:600">Create New ' + entity + '</span>',
    });

    const createFields = fields
      .filter(f => !f.hidden && !f.isArray && !f.isObject)
      .map(f => ({
        name: f.name,
        title: f.title,
        required: f.required,
        ...(f.valueMap ? { type: 'select', valueMap: f.valueMap } : {}),
      }));

    members.push({
      _type: 'DynamicForm',
      ID: 'createForm',
      height: 80,
      numCols: 4,
      fields: createFields,
    });

    members.push({
      _type: 'HLayout',
      height: 35,
      membersMargin: 8,
      members: [
        {
          _type: 'Button',
          ID: 'btnCreate',
          title: 'Create ' + entity,
          width: 120,
          _action: 'fetchAndLoadGrid',
          _messageType: entity.toUpperCase() + '_CREATE',
          _payloadFrom: 'createForm',
          _targetGrid: 'mainGrid',
          _statusCanvas: 'createStatus',
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

  return {
    _type: 'VLayout',
    width: '100%',
    height: '100%',
    padding: 12,
    membersMargin: 8,
    members,
  };
}

/**
 * Build handler source code for the plugin.
 */
function buildHandlers(entity, ops) {
  const { listOp, getOp, createOp, deleteOp, baseUrl, fields } = ops;
  const upper = entity.toUpperCase();
  const lines = [];

  lines.push(`// Auto-generated handlers for ${entity} API`);
  lines.push(`// Base URL: ${baseUrl}`);
  lines.push(`export function register(handlers) {`);

  if (listOp) {
    const queryParam = listOp.parameters.find(p => p.in === 'query');
    const qp = queryParam ? queryParam.name : null;
    lines.push(`  handlers['${upper}_LIST'] = async (msg) => {`);
    lines.push(`    const url = '${baseUrl}${listOp.path}' + ${qp ? `'?' + new URLSearchParams({${qp}: msg.${qp} || 'available'}).toString()` : "''"};`);
    lines.push(`    const resp = await handlers['HOST_NETWORK_FETCH']({ url, as: 'json' });`);
    lines.push(`    if (!resp.ok) return { success: false, error: 'API returned ' + resp.status };`);
    lines.push(`    const data = Array.isArray(resp.json) ? resp.json : [resp.json];`);
    // Flatten nested objects for grid display
    lines.push(`    const flat = data.map(item => ({`);
    for (const f of fields) {
      if (f.isObject) {
        lines.push(`      ${f.name}: item.${f.name} ? (item.${f.name}.name || JSON.stringify(item.${f.name})) : '',`);
      } else if (f.isArray) {
        lines.push(`      ${f.name}: Array.isArray(item.${f.name}) ? item.${f.name}.length + ' items' : '',`);
      } else {
        lines.push(`      ${f.name}: item.${f.name},`);
      }
    }
    lines.push(`    }));`);
    lines.push(`    return { success: true, data: flat, totalRows: flat.length };`);
    lines.push(`  };`);
  }

  if (createOp) {
    lines.push(`  handlers['${upper}_CREATE'] = async (msg) => {`);
    lines.push(`    const body = {};`);
    for (const f of fields) {
      if (!f.hidden && !f.isObject && !f.isArray) {
        lines.push(`    if (msg.${f.name} != null) body.${f.name} = msg.${f.name};`);
      }
    }
    lines.push(`    body.photoUrls = ['https://example.com/photo.jpg'];`);
    lines.push(`    const resp = await handlers['HOST_NETWORK_FETCH']({`);
    lines.push(`      url: '${baseUrl}${createOp.path}',`);
    lines.push(`      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },`);
    lines.push(`      as: 'json',`);
    lines.push(`    });`);
    lines.push(`    if (!resp.ok) return { success: false, error: 'Create failed: ' + resp.status };`);
    lines.push(`    return { success: true, data: [resp.json], totalRows: 1 };`);
    lines.push(`  };`);
  }

  lines.push(`}`);
  return lines.join('\n');
}
