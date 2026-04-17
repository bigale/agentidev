const log = document.getElementById('log');
function print(text, cls = '') {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text + '\n';
  log.appendChild(span);
}

async function runTests() {
  print('=== Agent Module Tests ===\n', 'info');

  // 1. TypeBox
  try {
    const { Type, getModel, Agent } = await import('../../lib/vendor/pi-bundle.js');
    const schema = Type.Object({ test: Type.String() });
    print('1. TypeBox: ' + (schema.type === 'object' ? 'PASS' : 'FAIL'), schema.type === 'object' ? 'pass' : 'fail');
  } catch (e) {
    print('1. TypeBox: FAIL - ' + e.message, 'fail');
  }

  // 2. pi-ai
  try {
    const { getModel } = await import('../../lib/vendor/pi-bundle.js');
    print('2. pi-ai getModel: ' + (typeof getModel === 'function' ? 'PASS' : 'FAIL'), typeof getModel === 'function' ? 'pass' : 'fail');
  } catch (e) {
    print('2. pi-ai: FAIL - ' + e.message, 'fail');
  }

  // 3. pi-agent-core
  try {
    const { Agent } = await import('../../lib/vendor/pi-bundle.js');
    print('3. pi-agent-core Agent: ' + (typeof Agent === 'function' ? 'PASS' : 'FAIL'), typeof Agent === 'function' ? 'pass' : 'fail');
  } catch (e) {
    print('3. pi-agent-core: FAIL - ' + e.message, 'fail');
  }

  // 4. Agent tools
  try {
    const { createTools } = await import('./agent-tools.js');
    const tools = await createTools();
    print('4. Agent tools: ' + tools.length + ' tools - ' + (tools.length > 10 ? 'PASS' : 'FAIL'), tools.length > 10 ? 'pass' : 'fail');
  } catch (e) {
    print('4. Agent tools: FAIL - ' + e.message, 'fail');
  }

  // 5. WebLLM provider module
  try {
    const { isWebGPUAvailable, WEBLLM_MODELS } = await import('./webllm-provider.js');
    print('5. WebLLM provider: PASS (WebGPU=' + isWebGPUAvailable() + ')', 'pass');
  } catch (e) {
    print('5. WebLLM provider: FAIL - ' + e.message, 'fail');
  }

  // 6. Agent provider
  try {
    const { initProvider } = await import('./agent-provider.js');
    const { model, status } = await initProvider();
    print('6. Agent provider: ' + (status.ready ? 'READY (' + status.provider + ': ' + status.model + ')' : 'NO PROVIDER - ' + (status.error || 'install Ollama or enable WebLLM')), status.ready ? 'pass' : 'info');
  } catch (e) {
    print('6. Agent provider: FAIL - ' + e.message, 'fail');
  }

  // 7. SW handler call (PLUGIN_LIST)
  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'PLUGIN_LIST' }, (r) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(r);
      });
    });
    const plugins = Array.isArray(resp) ? resp.map(p => p.id) : [];
    print('7. SW PLUGIN_LIST: ' + (plugins.length > 0 ? 'PASS' : 'FAIL') + ' - ' + plugins.join(', '), plugins.length > 0 ? 'pass' : 'fail');
  } catch (e) {
    print('7. SW handler: FAIL - ' + e.message, 'fail');
  }

  // 8. Full agent init
  try {
    const { initAgent } = await import('./agent-setup.js');
    const { agent, status } = await initAgent();
    if (status.ready) {
      print('8. Agent init: PASS - ' + status.toolCount + ' tools', 'pass');
    } else {
      print('8. Agent init: NO PROVIDER (expected without Ollama/WebGPU)', 'info');
    }
  } catch (e) {
    print('8. Agent init: FAIL - ' + e.message, 'fail');
  }

  print('\n=== Tests Complete ===', 'info');
}

runTests().catch(e => print('FATAL: ' + e.message + '\n' + e.stack, 'fail'));
