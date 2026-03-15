/**
 * SmartClient AI handlers — generate UI configs from natural language prompts.
 * Uses Chrome Prompt API (Gemini Nano) to produce SmartClient JSON configs
 * that renderer.js instantiates without eval.
 */
import { generateText, checkAvailability, initSession } from '../chrome-prompt-api.js';
import { state } from '../init-state.js';

const SYSTEM_PROMPT = `You are a SmartClient UI generator. Given a user description, output ONLY a JSON object with this structure:

{"dataSources":[...],"layout":{...}}

Rules:
- dataSources: array of {ID, fields:[{name,type,primaryKey,hidden,title,required,length,valueMap,canEdit}]}
  - ID must end with DS, always include {name:"id",type:"integer",primaryKey:true,hidden:true}
  - Field types: text, integer, float, date, datetime, boolean
  - For dropdowns use valueMap as an array of strings
- layout: component tree with _type and members[]
  - Allowed _type values: VLayout, HLayout, ListGrid, DynamicForm, Button, Label, TabSet, Tab, DetailViewer, SectionStack, HTMLFlow, Window, ToolStrip, ToolStripButton
  - ListGrid: set dataSource, autoFetchData:true, fields array with name and width
  - DynamicForm: set dataSource, fields with name and optionally editorType (TextItem, TextAreaItem, SelectItem, DateItem, CheckboxItem, SpinnerItem)
  - Button: use _action for behavior: "new","save","delete". Set _targetForm and _targetGrid to reference component IDs
  - ListGrid recordClick: set _action:"select" and _targetForm to auto-wire
  - Give components an ID string so buttons can reference them

Example for a task tracker:
{"dataSources":[{"ID":"TaskDS","fields":[{"name":"id","type":"integer","primaryKey":true,"hidden":true},{"name":"title","type":"text","required":true,"title":"Title","length":200},{"name":"status","type":"text","title":"Status","valueMap":["Todo","In Progress","Done"]},{"name":"dueDate","type":"date","title":"Due Date"}]}],"layout":{"_type":"VLayout","width":"100%","height":"100%","membersMargin":8,"layoutMargin":12,"members":[{"_type":"ListGrid","ID":"taskGrid","width":"100%","height":"*","dataSource":"TaskDS","autoFetchData":true,"canEdit":false,"selectionType":"single","_action":"select","_targetForm":"taskForm","fields":[{"name":"title","width":"*"},{"name":"status","width":120},{"name":"dueDate","width":120}]},{"_type":"DynamicForm","ID":"taskForm","width":"100%","dataSource":"TaskDS","numCols":2,"colWidths":[120,"*"],"fields":[{"name":"title","editorType":"TextItem"},{"name":"status","editorType":"SelectItem"},{"name":"dueDate","editorType":"DateItem"}]},{"_type":"HLayout","height":30,"membersMargin":8,"members":[{"_type":"Button","title":"New","width":80,"_action":"new","_targetForm":"taskForm"},{"_type":"Button","title":"Save","width":80,"_action":"save","_targetForm":"taskForm","_targetGrid":"taskGrid"},{"_type":"Button","title":"Delete","width":80,"_action":"delete","_targetGrid":"taskGrid"}]}]}}

Output ONLY the JSON object. No explanation, no markdown fences.`;

function parseJSONFromResponse(text) {
  // Strip markdown fences if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  // Match outermost { ... }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('No JSON object found in response');
  }

  return JSON.parse(match[0]);
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

async function ensureLLM() {
  if (state.llmReady) return true;
  console.log('[SmartClient AI] Gemini Nano not ready, attempting init...');
  try {
    const available = await checkAvailability();
    if (available) state.llmReady = await initSession();
  } catch (err) {
    console.error('[SmartClient AI] Init error:', err);
  }
  return state.llmReady;
}

async function handleGenerateUI(message) {
  const { prompt } = message;
  if (!prompt || !prompt.trim()) {
    return { success: false, error: 'Prompt is required' };
  }

  if (!await ensureLLM()) {
    return { success: false, error: 'Gemini Nano not available. Requires Chrome 138+ with flag enabled.' };
  }

  try {
    console.log('[SmartClient AI] Generating UI for:', prompt);
    const fullPrompt = SYSTEM_PROMPT + '\n\nUser request: ' + prompt.trim();
    const result = await generateText(fullPrompt);
    console.log('[SmartClient AI] Raw response length:', result.length);

    const config = parseJSONFromResponse(result);
    validateConfig(config);

    console.log('[SmartClient AI] Valid config:', config.dataSources.length, 'dataSources,', config.layout._type, 'layout');
    return { success: true, config };
  } catch (err) {
    console.error('[SmartClient AI] Generation failed:', err);
    return { success: false, error: err.message };
  }
}

export function register(handlers) {
  handlers['SC_GENERATE_UI'] = (msg) => handleGenerateUI(msg);
}
