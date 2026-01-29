/**
 * Recursive Extractor Engine
 *
 * Intelligent web scraper with recursive decomposition and token budget management.
 * Automatically handles pagination, schema inference, and multi-page extraction.
 */

import { TokenBudgetManager } from './token-budget.js';
import {
  inferSchema,
  extractWithSchema,
  inferAndExtract,
  itemsToCSV,
  estimateSchemaInferenceTokens,
  estimateExtractionTokens
} from './schema-inference.js';

export class RecursiveExtractor {
  /**
   * Create a new recursive extractor
   * @param {Object} llm - LLM interface with generate() function
   * @param {number} totalTokenBudget - Total tokens available
   */
  constructor(llm, totalTokenBudget = 3500) {
    this.llm = llm;
    this.tokenBudget = new TokenBudgetManager(totalTokenBudget, 500);
    this.maxDepth = 3;
    this.maxPages = 10;
  }

  /**
   * Extract data from current page or multiple pages
   * @param {number} tabId - Chrome tab ID
   * @param {string} extractionPrompt - What to extract
   * @param {Object} options - Extraction options
   * @returns {Promise<Object>} Extraction results
   */
  async extract(tabId, extractionPrompt, options = {}) {
    console.log('[Extractor] Starting extraction');
    console.log('[Extractor] Prompt:', extractionPrompt);
    console.log('[Extractor] Options:', options);

    const {
      followPagination = false,
      maxPages = 10,
      followLinks = false
    } = options;

    this.maxPages = maxPages;

    try {
      // Get current page content
      const pageContent = await this.fetchPageContent(tabId);

      if (!followPagination) {
        // Single page extraction
        return await this.extractSinglePage(pageContent, extractionPrompt);
      } else {
        // Multi-page extraction
        return await this.extractMultiPage(tabId, pageContent, extractionPrompt);
      }

    } catch (error) {
      console.error('[Extractor] Extraction failed:', error);
      return {
        success: false,
        error: error.message,
        items: [],
        pagesProcessed: 0
      };
    }
  }

  /**
   * Extract from a single page
   * @param {Object} pageContent - Page content object
   * @param {string} extractionPrompt - What to extract
   * @returns {Promise<Object>} Extraction results
   */
  async extractSinglePage(pageContent, extractionPrompt) {
    console.log('[Extractor] Single page extraction');

    // Check token budget
    const estimatedTokens = estimateSchemaInferenceTokens(pageContent.html, extractionPrompt) + 500;
    if (!this.tokenBudget.canAfford(estimatedTokens)) {
      throw new Error('Insufficient token budget for extraction');
    }

    // Infer schema and extract in one step
    const result = await inferAndExtract(
      pageContent.html,
      extractionPrompt,
      (prompt, options) => this.llm.generate(prompt, options)
    );

    // Record token usage
    const tokensUsed = estimateSchemaInferenceTokens(pageContent.html, extractionPrompt);
    this.tokenBudget.recordUsage(tokensUsed);

    return {
      success: true,
      items: result.items,
      schema: result.schema,
      pagesProcessed: 1,
      tokensUsed: this.tokenBudget.used,
      tokenBudget: this.tokenBudget.getSummary(),
      url: pageContent.url
    };
  }

  /**
   * Extract from multiple pages with pagination
   * @param {number} tabId - Chrome tab ID
   * @param {Object} initialPageContent - First page content
   * @param {string} extractionPrompt - What to extract
   * @returns {Promise<Object>} Extraction results
   */
  async extractMultiPage(tabId, initialPageContent, extractionPrompt) {
    console.log('[Extractor] Multi-page extraction');

    const allItems = [];
    const visitedUrls = new Set();
    let schema = null;
    let currentUrl = initialPageContent.url;
    let pageCount = 0;

    // Process first page (infer schema)
    console.log(`[Extractor] Processing page ${pageCount + 1}: ${currentUrl}`);

    const firstPageResult = await inferAndExtract(
      initialPageContent.html,
      extractionPrompt,
      (prompt, options) => this.llm.generate(prompt, options)
    );

    schema = firstPageResult.schema;
    allItems.push(...firstPageResult.items);
    visitedUrls.add(currentUrl);
    pageCount++;

    const firstPageTokens = estimateSchemaInferenceTokens(initialPageContent.html, extractionPrompt);
    this.tokenBudget.recordUsage(firstPageTokens);

    console.log(`[Extractor] Page 1: Found ${firstPageResult.items.length} items`);
    console.log(`[Extractor] Schema: ${JSON.stringify(schema)}`);

    // Find next page link
    let nextUrl = await this.findNextPageLink(initialPageContent.html, currentUrl);

    // Process remaining pages
    while (nextUrl && pageCount < this.maxPages && !visitedUrls.has(nextUrl)) {
      // Check token budget
      const estimatedTokens = estimateExtractionTokens(initialPageContent.html, schema);
      if (!this.tokenBudget.canAfford(estimatedTokens)) {
        console.warn('[Extractor] Token budget exhausted, stopping pagination');
        break;
      }

      try {
        // Navigate to next page
        await this.navigateToUrl(tabId, nextUrl);
        await this.waitForPageLoad(1000);

        // Get page content
        const pageContent = await this.fetchPageContent(tabId);
        currentUrl = pageContent.url;
        visitedUrls.add(currentUrl);
        pageCount++;

        console.log(`[Extractor] Processing page ${pageCount}: ${currentUrl}`);

        // Extract using existing schema
        const items = await extractWithSchema(
          pageContent.html,
          schema,
          (prompt, options) => this.llm.generate(prompt, options)
        );

        allItems.push(...items);

        const pageTokens = estimateExtractionTokens(pageContent.html, schema);
        this.tokenBudget.recordUsage(pageTokens);

        console.log(`[Extractor] Page ${pageCount}: Found ${items.length} items`);

        // Find next page
        nextUrl = await this.findNextPageLink(pageContent.html, currentUrl);

      } catch (error) {
        console.error(`[Extractor] Failed to process page ${pageCount}:`, error);
        break;
      }
    }

    console.log(`[Extractor] Extraction complete: ${allItems.length} items from ${pageCount} pages`);

    return {
      success: true,
      items: allItems,
      schema: schema,
      pagesProcessed: pageCount,
      tokensUsed: this.tokenBudget.used,
      tokenBudget: this.tokenBudget.getSummary(),
      urls: Array.from(visitedUrls)
    };
  }

  /**
   * Find the URL for the next page
   * @param {string} html - Current page HTML
   * @param {string} currentUrl - Current page URL
   * @returns {Promise<string|null>} Next page URL or null
   */
  async findNextPageLink(html, currentUrl) {
    console.log('[Extractor] Finding next page link...');

    // Truncate HTML to save tokens
    const truncatedHTML = html.substring(0, 2000);

    const prompt = `Find the URL for the next page in this HTML.

Current URL: ${currentUrl}

HTML (truncated):
${truncatedHTML}

Look for pagination links like:
- "Next" button or link
- "→" or "›" symbols
- Page numbers (current page + 1)
- "Load more" buttons

If found, return ONLY the full URL (must start with http:// or https://).
If not found or this is the last page, return: NONE

Response (URL or NONE):`;

    try {
      const response = await this.llm.generate(prompt, {
        max_tokens: 100,
        temperature: 0.1
      });

      const nextUrl = response.trim();

      // Record token usage
      this.tokenBudget.recordUsage(Math.ceil((prompt.length + 100) / 4));

      if (nextUrl === 'NONE' || !nextUrl.startsWith('http')) {
        console.log('[Extractor] No next page found');
        return null;
      }

      console.log('[Extractor] Next page:', nextUrl);
      return nextUrl;

    } catch (error) {
      console.error('[Extractor] Failed to find next page:', error);
      return null;
    }
  }

  /**
   * Fetch page content from tab
   * @param {number} tabId - Chrome tab ID
   * @returns {Promise<Object>} Page content
   */
  async fetchPageContent(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'GET_PAGE_CONTENT'
      });

      if (!response || !response.html) {
        throw new Error('Failed to get page content from tab');
      }

      return response;

    } catch (error) {
      console.error('[Extractor] Failed to fetch page content:', error);
      throw error;
    }
  }

  /**
   * Navigate to URL in tab
   * @param {number} tabId - Chrome tab ID
   * @param {string} url - URL to navigate to
   */
  async navigateToUrl(tabId, url) {
    await chrome.tabs.update(tabId, { url });
  }

  /**
   * Wait for page to load
   * @param {number} ms - Milliseconds to wait
   */
  async waitForPageLoad(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Export extraction results to JSON
   * @param {Object} results - Extraction results
   * @returns {string} JSON string
   */
  static exportToJSON(results) {
    return JSON.stringify(results.items, null, 2);
  }

  /**
   * Export extraction results to CSV
   * @param {Object} results - Extraction results
   * @returns {string} CSV string
   */
  static exportToCSV(results) {
    if (!results.schema || !results.items || results.items.length === 0) {
      return '';
    }

    return itemsToCSV(results.items, results.schema);
  }

  /**
   * Get extraction statistics
   * @param {Object} results - Extraction results
   * @returns {Object} Statistics
   */
  static getStats(results) {
    return {
      itemCount: results.items?.length || 0,
      pagesProcessed: results.pagesProcessed || 0,
      tokensUsed: results.tokensUsed || 0,
      tokensAvailable: results.tokenBudget?.total || 0,
      percentUsed: results.tokenBudget?.percentUsed || 0,
      success: results.success || false
    };
  }
}
