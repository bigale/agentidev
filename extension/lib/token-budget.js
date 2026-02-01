/**
 * Token Budget Manager for LLM Context Window Management
 *
 * Manages token allocation within limited context windows.
 * Supports hierarchical budget allocation for recursive queries (Phase 1.5).
 */

export class TokenBudgetManager {
  /**
   * Create a new token budget manager
   * @param {number} totalBudget - Total tokens available (default 4096 for Phi-3-mini)
   * @param {number} reservedForAnswer - Tokens reserved for LLM answer generation
   */
  constructor(totalBudget = 4096, reservedForAnswer = 512) {
    this.total = totalBudget;
    this.used = 0;
    this.reserved = reservedForAnswer;
    this.systemPromptTokens = 200; // Estimated system prompt overhead
  }

  /**
   * Get available tokens for context
   * @returns {number} Available tokens
   */
  getAvailableForContext() {
    return this.total - this.used - this.reserved - this.systemPromptTokens;
  }

  /**
   * Check if we can afford to use this many tokens
   * @param {number} tokens - Token count to check
   * @returns {boolean} True if budget allows
   */
  canAfford(tokens) {
    return this.getAvailableForContext() >= tokens;
  }

  /**
   * Record token usage
   * @param {number} tokens - Tokens used
   */
  recordUsage(tokens) {
    this.used += tokens;
    console.log(`[TokenBudget] Used ${this.used}/${this.total} tokens (${this.getAvailableForContext()} remaining)`);
  }

  /**
   * Calculate maximum number of chunks that fit in budget
   * @param {number} tokensPerChunk - Estimated tokens per chunk (default 500)
   * @returns {number} Maximum chunks
   */
  getMaxChunks(tokensPerChunk = 500) {
    const available = this.getAvailableForContext();
    return Math.max(1, Math.floor(available / tokensPerChunk));
  }

  /**
   * Allocate budget for sub-queries (Phase 1.5 recursive queries)
   * Uses exponential decay: deeper queries get less budget
   * @param {number} numSubQueries - Number of sub-queries
   * @param {number} depth - Current recursion depth (default 0)
   * @returns {number} Budget allocated per sub-query
   */
  allocateForSubQueries(numSubQueries, depth = 0) {
    if (numSubQueries <= 0) return 0;

    // Exponential decay: 0.6^depth
    // depth 0: 100% of available
    // depth 1: 60% of available
    // depth 2: 36% of available
    const depthPenalty = Math.pow(0.6, depth);
    const available = this.getAvailableForContext();
    const budgetPerSub = Math.floor((available * depthPenalty) / numSubQueries);

    console.log(`[TokenBudget] Allocating ${budgetPerSub} tokens per sub-query (depth ${depth}, ${numSubQueries} subs)`);
    return budgetPerSub;
  }

  /**
   * Create a sub-budget for recursive calls (Phase 1.5)
   * @param {number} allocatedTokens - Tokens allocated to this sub-query
   * @returns {TokenBudgetManager} New budget manager
   */
  createSubBudget(allocatedTokens) {
    // Reserve 20% of allocated tokens for answer in sub-query
    const subReserved = Math.floor(allocatedTokens * 0.2);
    return new TokenBudgetManager(allocatedTokens, subReserved);
  }

  /**
   * Reset token usage counter
   */
  reset() {
    this.used = 0;
  }

  /**
   * Get budget summary for debugging/display
   * @returns {object} Budget summary
   */
  getSummary() {
    return {
      total: this.total,
      used: this.used,
      available: this.getAvailableForContext(),
      reserved: this.reserved,
      percentUsed: Math.round((this.used / this.total) * 100)
    };
  }

  /**
   * Check if budget is nearly exhausted
   * @param {number} threshold - Percentage threshold (default 80)
   * @returns {boolean} True if usage >= threshold%
   */
  isNearlyExhausted(threshold = 80) {
    const percentUsed = (this.used / this.total) * 100;
    return percentUsed >= threshold;
  }

  /**
   * Get recommended max_tokens for LLM generation based on remaining budget
   * @returns {number} Recommended max_tokens (capped at reserved amount)
   */
  getRecommendedMaxTokens() {
    const available = this.getAvailableForContext();
    // Use up to reserved amount, but not more than available
    return Math.min(this.reserved, Math.max(50, available));
  }
}
