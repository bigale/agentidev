/**
 * Diagnostic Helper for Chrome Prompt API
 *
 * Helps diagnose why Gemini Nano might not be available
 */

export async function runDiagnostics() {
  console.log('='.repeat(60));
  console.log('Chrome Prompt API Diagnostics');
  console.log('='.repeat(60));

  // 1. Check Chrome version
  const userAgent = navigator.userAgent;
  const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
  const chromeVersion = chromeMatch ? parseInt(chromeMatch[1]) : 0;

  console.log('\n1. Chrome Version');
  console.log('   User Agent:', userAgent);
  console.log('   Chrome Version:', chromeVersion);
  console.log('   ✓ Required:', chromeVersion >= 138 ? 'YES' : 'NO (need 138+)');

  // 2. Check LanguageModel API
  console.log('\n2. LanguageModel API Availability');

  let hasLanguageModel = false;
  let languageModelScope = 'none';

  // Service workers don't have 'window', so we check only valid scopes
  try {
    if (typeof LanguageModel !== 'undefined') {
      hasLanguageModel = true;
      languageModelScope = 'global';
    }
  } catch (e) {}

  try {
    if (typeof self.LanguageModel !== 'undefined') {
      hasLanguageModel = true;
      languageModelScope = 'self';
    }
  } catch (e) {}

  try {
    if (typeof globalThis.LanguageModel !== 'undefined') {
      hasLanguageModel = true;
      languageModelScope = 'globalThis';
    }
  } catch (e) {}

  console.log('   LanguageModel defined:', hasLanguageModel ? 'YES ✓' : 'NO ✗');
  if (hasLanguageModel) {
    console.log('   LanguageModel scope:', languageModelScope);
  }

  if (!hasLanguageModel) {
    console.log('   ❌ PROBLEM: LanguageModel is not defined');
    console.log('   📋 SOLUTIONS:');
    console.log('      1. Go to chrome://flags/#prompt-api-for-gemini-nano');
    console.log('      2. Set to "Enabled" or "Enabled multilingual"');
    console.log('      3. Restart Chrome completely');
    console.log('      4. Reload this extension');
    console.log('='.repeat(60));
    return {
      available: false,
      reason: 'LanguageModel API not found - flag not enabled'
    };
  }

  // 3. Check availability status
  console.log('\n3. Model Availability Status');
  try {
    const LM = LanguageModel || self.LanguageModel || globalThis.LanguageModel;
    const availability = await LM.availability();

    console.log('   Status:', availability);

    if (availability === 'available' || availability === 'readily') {
      console.log('   ✓ Model is available and ready to use!');
      console.log('='.repeat(60));
      return { available: true, status: 'ready' };
    } else if (availability === 'downloadable' || availability === 'after-download') {
      console.log('   ⏳ Model needs to be downloaded');
      console.log('   📊 Size: ~5GB');
      console.log('   ⏱️  Time: 1-3 minutes');
      console.log('   📋 Monitor at: chrome://on-device-internals/');
      console.log('='.repeat(60));
      return { available: true, status: 'downloadable' };
    } else if (availability === 'no') {
      console.log('   ❌ Model not available on this system');
      console.log('   📋 POSSIBLE REASONS:');
      console.log('      1. Insufficient disk space (need 22GB free)');
      console.log('      2. Insufficient VRAM (need 4GB+)');
      console.log('      3. Unsupported OS/platform');
      console.log('      4. Model download failed');
      console.log('   📋 CHECK:');
      console.log('      - chrome://on-device-internals/');
      console.log('      - chrome://components/ (Optimization Guide)');
      console.log('='.repeat(60));
      return { available: false, reason: 'Model not available on system' };
    } else {
      console.log('   ⚠️  Unknown status:', availability);
      console.log('='.repeat(60));
      return { available: false, reason: `Unknown status: ${availability}` };
    }
  } catch (error) {
    console.log('   ❌ Error checking availability:', error.message);
    console.log('='.repeat(60));
    return { available: false, reason: error.message };
  }
}
