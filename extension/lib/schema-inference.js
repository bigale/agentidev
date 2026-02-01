/**
 * Schema Inference Module
 *
 * Uses LLM to infer data extraction schemas from HTML examples.
 * Optimized for low token usage through schema reuse.
 */

/**
 * Infer extraction schema from sample HTML content
 * @param {string} html - Sample HTML content
 * @param {string} userPrompt - User's extraction request
 * @param {Function} llmGenerate - LLM generation function
 * @returns {Promise<Object>} Inferred schema
 */
export async function inferSchema(html, userPrompt, llmGenerate) {
  console.log('[Schema] Inferring schema from HTML...');

  // Truncate HTML to save tokens (use first 3000 chars)
  const truncatedHTML = html.substring(0, 3000);

  const prompt = `Analyze this HTML and create a JSON schema for data extraction.

User wants to extract: "${userPrompt}"

Sample HTML:
${truncatedHTML}

Create a JSON schema with field names and types. Use descriptive field names.
Include only fields that match the user's request.

Supported types: string, number, boolean, array

Example schema:
{
  "fields": [
    {"name": "title", "type": "string"},
    {"name": "price", "type": "number"},
    {"name": "rating", "type": "number"}
  ]
}

Schema (JSON only, no explanation):`;

  try {
    const response = await llmGenerate(prompt, {
      max_tokens: 400,
      temperature: 0.1 // Low temp for consistent structure
    });

    // Parse JSON response
    const schema = JSON.parse(response.trim());

    // Validate schema
    if (!schema.fields || !Array.isArray(schema.fields)) {
      throw new Error('Invalid schema: missing fields array');
    }

    console.log('[Schema] Inferred schema:', schema);
    return schema;

  } catch (error) {
    console.error('[Schema] Failed to infer schema:', error);
    throw error;
  }
}

/**
 * Extract data from HTML using a schema
 * @param {string} html - HTML content to extract from
 * @param {Object} schema - Extraction schema
 * @param {Function} llmGenerate - LLM generation function
 * @returns {Promise<Array>} Extracted data items
 */
export async function extractWithSchema(html, schema, llmGenerate) {
  console.log('[Schema] Extracting data with schema...');

  // Truncate HTML to save tokens
  const truncatedHTML = html.substring(0, 4000);

  // Build field descriptions for prompt
  const fieldList = schema.fields
    .map(f => `  - ${f.name} (${f.type})`)
    .join('\n');

  const prompt = `Extract data from this HTML using the schema below.

Schema fields:
${fieldList}

HTML:
${truncatedHTML}

Extract ALL items that match the schema. Return as JSON array.
Each object should have the fields listed above.
If a field is missing, use null.

Response (JSON array only):`;

  try {
    const response = await llmGenerate(prompt, {
      max_tokens: 800,
      temperature: 0.1
    });

    // Parse JSON response
    const data = JSON.parse(response.trim());

    // Ensure it's an array
    const items = Array.isArray(data) ? data : [data];

    // Validate items against schema
    const validatedItems = items.map(item => validateItem(item, schema));

    console.log(`[Schema] Extracted ${validatedItems.length} items`);
    return validatedItems;

  } catch (error) {
    console.error('[Schema] Failed to extract data:', error);
    return [];
  }
}

/**
 * Validate and type-cast extracted item against schema
 * @param {Object} item - Extracted item
 * @param {Object} schema - Schema to validate against
 * @returns {Object} Validated and type-cast item
 */
function validateItem(item, schema) {
  const validated = {};

  for (const field of schema.fields) {
    const value = item[field.name];

    // Type casting
    switch (field.type) {
      case 'number':
        validated[field.name] = value !== null && value !== undefined
          ? parseFloat(value)
          : null;
        break;

      case 'boolean':
        validated[field.name] = value === true || value === 'true' || value === 1;
        break;

      case 'array':
        validated[field.name] = Array.isArray(value) ? value : [];
        break;

      case 'string':
      default:
        validated[field.name] = value !== null && value !== undefined
          ? String(value)
          : null;
    }
  }

  return validated;
}

/**
 * Infer and extract in one step (for single page)
 * @param {string} html - HTML content
 * @param {string} userPrompt - User's extraction request
 * @param {Function} llmGenerate - LLM generation function
 * @returns {Promise<Object>} Result with schema and items
 */
export async function inferAndExtract(html, userPrompt, llmGenerate) {
  console.log('[Schema] Inferring schema and extracting data...');

  // Truncate HTML
  const truncatedHTML = html.substring(0, 4000);

  const prompt = `You are a data extraction assistant. Extract structured data from HTML and return valid JSON.

Task: ${userPrompt}

HTML to analyze:
${truncatedHTML}

Instructions:
1. Determine what fields to extract based on the task
2. Extract ALL matching items from the HTML
3. Return ONLY a valid JSON object (no other text)

Required JSON format:
{
  "schema": [{"name": "field1", "type": "string"}, {"name": "field2", "type": "number"}],
  "items": [{...extracted data...}, {...}, ...]
}

Supported types: string, number, boolean, array

JSON output:`;

  try {
    const response = await llmGenerate(prompt, {
      max_tokens: 1000,
      temperature: 0.1
    });

    console.log('[Schema] LLM response:', response.substring(0, 200));

    // Try to extract JSON from response (Gemini Nano should return clean JSON)
    let jsonText = response.trim();

    // Remove common prefixes if present
    if (jsonText.startsWith('JSON output:')) {
      jsonText = jsonText.substring(12).trim();
    }
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.substring(7).trim();
    }
    if (jsonText.endsWith('```')) {
      jsonText = jsonText.substring(0, jsonText.length - 3).trim();
    }

    // Look for JSON object {...}
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    const result = JSON.parse(jsonText);

    if (!result.schema || !result.items) {
      throw new Error('Invalid response: missing schema or items');
    }

    console.log(`[Schema] Inferred schema with ${result.schema.fields?.length || result.schema.length} fields`);
    console.log(`[Schema] Extracted ${result.items.length} items`);

    // Normalize schema format
    const schema = {
      fields: Array.isArray(result.schema)
        ? result.schema
        : (result.schema.fields || [])
    };

    return {
      schema,
      items: result.items
    };

  } catch (error) {
    console.error('[Schema] Failed to infer and extract:', error);

    // Return empty result with helpful error
    return {
      schema: { fields: [] },
      items: [],
      error: `LLM failed to generate valid JSON: ${error.message}. The model may not support structured extraction.`
    };
  }
}

/**
 * Convert schema to CSV header
 * @param {Object} schema - Schema object
 * @returns {string} CSV header row
 */
export function schemaToCSVHeader(schema) {
  return schema.fields.map(f => f.name).join(',');
}

/**
 * Convert extracted items to CSV
 * @param {Array} items - Extracted items
 * @param {Object} schema - Schema object
 * @returns {string} CSV string
 */
export function itemsToCSV(items, schema) {
  if (items.length === 0) return '';

  const header = schemaToCSVHeader(schema);
  const rows = items.map(item => {
    return schema.fields.map(field => {
      const value = item[field.name];

      // Escape CSV values
      if (value === null || value === undefined) return '';

      const stringValue = String(value);

      // Quote if contains comma, quote, or newline
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }

      return stringValue;
    }).join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Estimate token cost for schema inference
 * @param {string} html - HTML content
 * @param {string} userPrompt - User prompt
 * @returns {number} Estimated tokens
 */
export function estimateSchemaInferenceTokens(html, userPrompt) {
  const truncatedHTML = html.substring(0, 3000);
  const promptLength = 150; // Approximate system prompt
  const totalChars = promptLength + userPrompt.length + truncatedHTML.length;
  return Math.ceil(totalChars / 4); // 1 token ≈ 4 chars
}

/**
 * Estimate token cost for extraction with schema
 * @param {string} html - HTML content
 * @param {Object} schema - Schema object
 * @returns {number} Estimated tokens
 */
export function estimateExtractionTokens(html, schema) {
  const truncatedHTML = html.substring(0, 4000);
  const schemaChars = JSON.stringify(schema).length;
  const promptLength = 100;
  const totalChars = promptLength + schemaChars + truncatedHTML.length;
  return Math.ceil(totalChars / 4);
}
