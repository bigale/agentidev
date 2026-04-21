/**
 * OpenAPI Spec Analyzer — reads an OpenAPI 3.0 / Swagger 2.0 spec and
 * extracts endpoint metadata for PICT model generation.
 *
 * For each endpoint, generates a PICT model that covers:
 *   - Query/path/header parameters with valid + negative (~) values
 *   - Request body fields (flattened from $ref schemas)
 *   - Content-type and auth variations
 *   - Constraints between parameters
 */

import { readFileSync } from 'fs';

/**
 * Load an OpenAPI spec from a local file path.
 * @param {string} path - Path to JSON or YAML spec file
 * @returns {object} Parsed spec object
 */
export function loadSpec(path) {
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('YAML specs not yet supported — convert to JSON first');
  }
}

/**
 * Extract all endpoints from a parsed OpenAPI spec.
 * @param {object} spec - Parsed OpenAPI spec
 * @returns {Array<object>} Endpoint descriptors
 */
export function extractEndpoints(spec) {
  const endpoints = [];
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
      const op = pathItem[method];
      if (!op) continue;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId || `${method}_${path.replace(/[/{}]/g, '_')}`,
        parameters: [...(pathItem.parameters || []), ...(op.parameters || [])],
        requestBody: op.requestBody || null,
        consumes: op.consumes || spec.consumes || ['application/json'],
        responses: op.responses || {},
        security: op.security || spec.security || [],
        tags: op.tags || [],
        summary: op.summary || '',
      });
    }
  }
  return endpoints;
}

/**
 * Resolve a $ref in the spec (handles nested refs).
 */
export function resolveSchema(schema, spec) {
  if (!schema) return { type: 'string' };
  if (schema.$ref) {
    const refPath = schema.$ref.replace('#/', '').split('/');
    let resolved = spec;
    for (const segment of refPath) resolved = resolved?.[segment];
    return resolved ? resolveSchema(resolved, spec) : { type: 'string' };
  }
  return schema;
}

/**
 * Generate a PICT model for a single endpoint.
 * @param {object} endpoint - From extractEndpoints()
 * @param {object} spec - Full spec (for resolving $ref)
 * @returns {{ model: string, paramMeta: object, bodySchema: object|null }}
 */
export function generatePictModel(endpoint, spec) {
  const lines = [];
  const paramMeta = {};
  let bodySchema = null;

  lines.push(`# PICT model for ${endpoint.method} ${endpoint.path}`);
  lines.push(`# Generated from OpenAPI spec: ${spec.info?.title || 'unknown'}`);
  lines.push('');

  // ---- Query / Path / Header parameters ----
  for (const param of endpoint.parameters) {
    if (param.in === 'body') continue; // Handled below as body schema
    const schema = param.schema
      ? resolveSchema(param.schema, spec)
      : param.items
        ? resolveSchema(param.items, spec)
        : { type: param.type, enum: param.enum, format: param.format };
    const name = sanitizePictName(param.name);
    const values = generateValues(schema, param.required);

    paramMeta[name] = {
      originalName: param.name,
      in: param.in,
      required: param.required || false,
      schema,
      values,
    };
    lines.push(`${name}: ${values.join(', ')}`);
  }

  // ---- Request body (Swagger 2.0: in=body param, OpenAPI 3.0: requestBody) ----
  const bodyParam = endpoint.parameters.find(p => p.in === 'body');
  const bodyRef = bodyParam?.schema || endpoint.requestBody?.content?.['application/json']?.schema;
  if (bodyRef) {
    bodySchema = resolveSchema(bodyRef, spec);
    const requiredFields = new Set(bodySchema.required || []);

    // Flatten body properties into PICT parameters prefixed with "body_"
    for (const [fieldName, fieldSchema] of Object.entries(bodySchema.properties || {})) {
      const resolved = resolveSchema(fieldSchema, spec);
      const pictName = 'body_' + sanitizePictName(fieldName);
      const isRequired = requiredFields.has(fieldName);

      if (resolved.properties) {
        // Nested object (e.g., category) — flatten one level with shape variants
        const shapeName = pictName + '_shape';
        const shapes = ['valid', 'id_only', 'name_only', '~malformed', 'omit'];
        if (isRequired) shapes.splice(shapes.indexOf('omit'), 1);
        paramMeta[shapeName] = {
          originalName: fieldName,
          in: 'body',
          required: isRequired,
          schema: resolved,
          values: shapes,
          isNestedObject: true,
          nestedProperties: resolved.properties,
        };
        lines.push(`${shapeName}: ${shapes.join(', ')}`);
      } else if (resolved.type === 'array') {
        // Array field — count variants
        const values = ['one_item', 'multiple_items'];
        if (!isRequired) values.push('omit');
        values.push('~empty_array');
        paramMeta[pictName] = {
          originalName: fieldName,
          in: 'body',
          required: isRequired,
          schema: resolved,
          values,
          isArray: true,
          itemSchema: resolved.items ? resolveSchema(resolved.items, spec) : { type: 'string' },
        };
        lines.push(`${pictName}: ${values.join(', ')}`);
      } else {
        // Scalar field
        const values = generateValues(resolved, isRequired);
        if (!isRequired && !values.includes('omit')) values.push('omit');
        paramMeta[pictName] = {
          originalName: fieldName,
          in: 'body',
          required: isRequired,
          schema: resolved,
          values,
        };
        lines.push(`${pictName}: ${values.join(', ')}`);
      }
    }
  }

  // ---- Content-Type (for POST/PUT with body) ----
  if (bodyRef && (endpoint.method === 'POST' || endpoint.method === 'PUT')) {
    const ctValues = endpoint.consumes.map(ct => ct.replace(/\//g, '_'));
    ctValues.push('~text_plain');
    paramMeta['ContentType'] = {
      originalName: 'Content-Type',
      in: 'header',
      required: false,
      values: ctValues,
    };
    lines.push(`ContentType: ${ctValues.join(', ')}`);
  }

  // ---- Accept header ----
  const produces = endpoint.responses?.['200']?.content
    ? Object.keys(endpoint.responses['200'].content)
    : spec.produces || ['application/json'];
  if (produces.length > 0) {
    const acceptValues = produces.map(ct => ct.replace(/\//g, '_'));
    acceptValues.push('~text_plain');
    paramMeta['Accept'] = {
      originalName: 'Accept',
      in: 'header',
      required: false,
      values: acceptValues,
    };
    lines.push(`Accept: ${acceptValues.join(', ')}`);
  }

  // ---- Auth ----
  if (endpoint.security?.length > 0) {
    const authValues = ['valid_auth', '~no_auth', '~invalid_auth'];
    paramMeta['Auth'] = {
      originalName: 'Authorization',
      in: 'header',
      required: false,
      values: authValues,
    };
    lines.push(`Auth: ${authValues.join(', ')}`);
  }

  // ---- Constraints ----
  const constraints = [];
  // If body has required name field, constrain it away from omit
  for (const [pName, meta] of Object.entries(paramMeta)) {
    if (meta.in === 'body' && meta.required && meta.values.includes('omit')) {
      // Remove omit from required fields — already handled above
    }
  }
  if (constraints.length > 0) {
    lines.push('');
    lines.push(...constraints);
  }

  return {
    model: lines.join('\n'),
    paramMeta,
    bodySchema,
    endpoint,
  };
}

/**
 * Generate PICT values for a schema, including ~negative values.
 */
function generateValues(schema, required = false) {
  const values = [];

  if (schema.enum) {
    values.push(...schema.enum);
    values.push('~unknown_enum');
  } else if (schema.type === 'integer' || schema.type === 'number') {
    values.push('1', '100', '9999');
    values.push('~-1', '~abc');
  } else if (schema.type === 'boolean') {
    values.push('true', 'false');
  } else if (schema.type === 'array') {
    values.push('one_item', 'multiple_items');
    values.push('~empty_array');
  } else {
    // Default string
    values.push('doggie', 'cat_42');
    values.push('~empty_string');
    if (!required) values.push('~null');
  }

  return [...new Set(values)];
}

/**
 * Sanitize a parameter name for PICT.
 */
function sanitizePictName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}
