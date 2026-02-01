/**
 * Chrome Prompt API (Gemini Nano) Wrapper
 *
 * Provides access to Chrome's built-in Gemini Nano model for text generation.
 * Available in Chrome 138+ for extensions without origin trial.
 *
 * Capabilities:
 * - Instruction following
 * - Question answering
 * - JSON generation (structured output)
 * - 6,000 token context window
 * - ~5GB model (auto-downloaded by Chrome)
 */

console.log('[Chrome Prompt API] Module loaded');

let session = null;
let isAvailable = false;
let availabilityChecked = false;

/**
 * Check if Chrome Prompt API is available
 * @returns {Promise<boolean>} True if available
 */
export async function checkAvailability() {
  if (availabilityChecked) {
    return isAvailable;
  }

  try {
    // Check if LanguageModel API exists (in service worker global scope)
    const LM = typeof LanguageModel !== 'undefined' ? LanguageModel :
               typeof self.LanguageModel !== 'undefined' ? self.LanguageModel :
               typeof globalThis.LanguageModel !== 'undefined' ? globalThis.LanguageModel :
               null;

    if (!LM) {
      console.log('[Chrome Prompt API] Not available - LanguageModel undefined');
      console.log('[Chrome Prompt API] Requires Chrome 138+ with chrome://flags/#prompt-api-for-gemini-nano enabled');
      isAvailable = false;
      availabilityChecked = true;
      return false;
    }

    // Check availability status
    const availability = await LM.availability();
    console.log('[Chrome Prompt API] Availability status:', availability);

    // Possible values: 'readily', 'downloadable' (Chrome 144+), 'after-download' (older), 'no'
    isAvailable = (availability === 'readily' || availability === 'downloadable' || availability === 'after-download');
    availabilityChecked = true;

    if (availability === 'downloadable' || availability === 'after-download') {
      console.log('[Chrome Prompt API] Model will download on first use (~5GB)');
    } else if (availability === 'no') {
      console.log('[Chrome Prompt API] Model not available on this system');
    }

    return isAvailable;

  } catch (error) {
    console.error('[Chrome Prompt API] Failed to check availability:', error);
    isAvailable = false;
    availabilityChecked = true;
    return false;
  }
}

/**
 * Initialize Chrome Prompt API session
 * @param {Object} options - Session options
 * @returns {Promise<boolean>} True if initialized successfully
 */
export async function initSession(options = {}) {
  if (session) {
    console.log('[Chrome Prompt API] Session already exists');
    return true;
  }

  try {
    // Check availability first
    const available = await checkAvailability();
    if (!available) {
      console.error('[Chrome Prompt API] Not available on this system');
      return false;
    }

    console.log('[Chrome Prompt API] Creating session...');
    console.log('[Chrome Prompt API] First use may take 1-3 minutes to download model (~5GB)');

    // Get the LanguageModel reference
    const LM = typeof LanguageModel !== 'undefined' ? LanguageModel :
               typeof self.LanguageModel !== 'undefined' ? self.LanguageModel :
               typeof globalThis.LanguageModel !== 'undefined' ? globalThis.LanguageModel :
               null;

    if (!LM) {
      console.error('[Chrome Prompt API] LanguageModel not found during session creation');
      return false;
    }

    // Create session with optional configuration
    const sessionOptions = {
      temperature: options.temperature || 0.3,
      topK: options.topK || 40,
      ...options
    };

    session = await LM.create(sessionOptions);
    console.log('[Chrome Prompt API] Session created successfully');
    console.log('[Chrome Prompt API] Model: Gemini Nano | Context: 6000 tokens');

    return true;

  } catch (error) {
    console.error('[Chrome Prompt API] Failed to create session:', error);
    session = null;
    return false;
  }
}

/**
 * Generate text using Chrome Prompt API
 * @param {string} prompt - Input prompt
 * @param {Object} options - Generation options
 * @returns {Promise<string>} Generated text
 */
export async function generateText(prompt, options = {}) {
  try {
    // Auto-initialize if needed
    if (!session) {
      const success = await initSession(options);
      if (!success) {
        throw new Error('Failed to initialize Chrome Prompt API');
      }
    }

    console.log(`[Chrome Prompt API] Generating (prompt length: ${prompt.length} chars)...`);
    const startTime = Date.now();

    // Generate text
    const result = await session.prompt(prompt);

    const elapsed = Date.now() - startTime;
    console.log(`[Chrome Prompt API] Generated in ${elapsed}ms`);
    console.log(`[Chrome Prompt API] Result length: ${result.length} chars`);

    return result;

  } catch (error) {
    console.error('[Chrome Prompt API] Generation failed:', error);
    throw error;
  }
}

/**
 * Generate text with streaming (for longer responses)
 * @param {string} prompt - Input prompt
 * @param {Function} onChunk - Callback for each chunk
 * @param {Object} options - Generation options
 * @returns {Promise<string>} Complete generated text
 */
export async function generateTextStreaming(prompt, onChunk, options = {}) {
  try {
    // Auto-initialize if needed
    if (!session) {
      const success = await initSession(options);
      if (!success) {
        throw new Error('Failed to initialize Chrome Prompt API');
      }
    }

    console.log(`[Chrome Prompt API] Generating (streaming, prompt length: ${prompt.length} chars)...`);
    const startTime = Date.now();

    let fullText = '';
    const stream = await session.promptStreaming(prompt);

    for await (const chunk of stream) {
      fullText = chunk; // Gemini Nano returns cumulative text, not deltas
      if (onChunk) {
        onChunk(chunk);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Chrome Prompt API] Generated in ${elapsed}ms (streaming)`);
    console.log(`[Chrome Prompt API] Result length: ${fullText.length} chars`);

    return fullText;

  } catch (error) {
    console.error('[Chrome Prompt API] Streaming generation failed:', error);
    throw error;
  }
}

/**
 * Generate structured JSON output
 * @param {string} prompt - Input prompt
 * @param {Object} schema - JSON schema for output validation
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Parsed JSON object
 */
export async function generateJSON(prompt, schema = null, options = {}) {
  try {
    // Generate text (Chrome 137+ supports structured output via prompting)
    const result = await generateText(prompt, options);

    // Extract JSON from response
    let jsonText = result.trim();

    // Look for JSON object {...}
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    // Parse JSON
    const parsed = JSON.parse(jsonText);

    // TODO: Add schema validation if schema provided
    // Chrome 137+ has native structured output support we could use

    return parsed;

  } catch (error) {
    console.error('[Chrome Prompt API] JSON generation failed:', error);
    throw error;
  }
}

/**
 * Destroy current session
 */
export async function destroySession() {
  if (session) {
    try {
      await session.destroy();
      console.log('[Chrome Prompt API] Session destroyed');
    } catch (error) {
      console.error('[Chrome Prompt API] Failed to destroy session:', error);
    }
    session = null;
  }
}

/**
 * Get current session status
 * @returns {Object} Status information
 */
export function getStatus() {
  return {
    available: isAvailable,
    sessionActive: session !== null,
    model: 'Gemini Nano',
    contextWindow: 6000,
    apiVersion: 'Chrome Prompt API (Chrome 138+)'
  };
}

/**
 * Estimate token count (simple heuristic)
 * Gemini uses SentencePiece tokenizer, roughly 1 token per 4 characters
 * @param {string} text - Input text
 * @returns {number} Estimated token count
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

console.log('[Chrome Prompt API] Module loaded');
