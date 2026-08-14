/**
 * Priority Strategy (OmniRoute Fill-First Architecture)
 *
 * Deterministic account selection based on account priority ordering:
 * 1. Accounts are ordered by priority (1 = highest priority, 2 = secondary, etc.).
 * 2. Always routes to the highest-priority eligible account (Fill-First).
 * 3. Never switches away from the top-priority account while it is healthy and available.
 * 4. When the top-priority account hits a rate limit (429) or error, it instantly falls over
 *    to the next highest priority available account.
 * 5. Automatically recovers back to the highest-priority account as soon as its cooldown expires.
 * 6. Zero artificial token-bucket delays or throttling jitter.
 */

import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class PriorityStrategy extends BaseStrategy {
    #sessionPins = new Map(); // sessionId -> email

    /**
     * Create a new PriorityStrategy
     * @param {Object} config - Strategy configuration
     */
    constructor(config = {}) {
        super(config);
    }

    /**
     * Get candidate accounts sorted by priority
     *
     * @param {Array} accounts - All configured accounts
     * @param {string} modelId - Model ID
     * @returns {Array<{account: Object, index: number, priority: number}>}
     */
    #getPrioritizedCandidates(accounts, modelId) {
        const now = Date.now();
        const eligible = [];

        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];

            // Filter out invalid or disabled accounts
            if (acc.isInvalid || acc.enabled === false) {
                continue;
            }

            // Filter out rate-limited accounts for this model
            if (modelId && acc.modelRateLimits && acc.modelRateLimits[modelId]) {
                const limit = acc.modelRateLimits[modelId];
                if (limit.isRateLimited && limit.resetTime > now) {
                    continue;
                }
            }

            // Filter out cooling down accounts
            if (acc.coolingDownUntil && acc.coolingDownUntil > now) {
                continue;
            }

            // Determine priority: explicit account.priority > index+1 > 999
            const priority = (typeof acc.priority === 'number' && acc.priority > 0)
                ? acc.priority
                : (i + 1);

            eligible.push({
                account: acc,
                index: i,
                priority
            });
        }

        // Sort by priority ascending (1 is highest priority)
        // Secondary sort: original array index (preserves deterministic order)
        eligible.sort((a, b) => {
            if (a.priority !== b.priority) {
                return a.priority - b.priority;
            }
            return a.index - b.index;
        });

        return eligible;
    }

    /**
     * Select an account based on OmniRoute Priority (Fill-First) ordering
     *
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID for the request
     * @param {Object} options - Additional options (e.g. sessionId, onSave)
     * @returns {{account: Object|null, index: number, waitMs: number}}
     */
    selectAccount(accounts, modelId, options = {}) {
        const { sessionId, onSave } = options;

        if (!accounts || accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        const candidates = this.#getPrioritizedCandidates(accounts, modelId);

        if (candidates.length === 0) {
            // All accounts are rate-limited or disabled
            // Find shortest wait time across accounts for this model
            let minWaitMs = 0;
            const now = Date.now();

            for (const acc of accounts) {
                if (acc.enabled === false || acc.isInvalid) continue;
                if (modelId && acc.modelRateLimits && acc.modelRateLimits[modelId]) {
                    const limit = acc.modelRateLimits[modelId];
                    if (limit.isRateLimited && limit.resetTime > now) {
                        const wait = limit.resetTime - now;
                        if (minWaitMs === 0 || wait < minWaitMs) {
                            minWaitMs = wait;
                        }
                    }
                }
            }

            logger.warn(`[PriorityStrategy] All eligible accounts are rate-limited for ${modelId}. Min wait: ${minWaitMs}ms`);
            return { account: null, index: 0, waitMs: minWaitMs };
        }

        // If session affinity is active and the pinned account is still valid in candidate list, prefer it
        let selectedCandidate = null;
        if (sessionId && this.#sessionPins.has(sessionId)) {
            const pinnedEmail = this.#sessionPins.get(sessionId);
            const pinnedCandidate = candidates.find(c => c.account.email === pinnedEmail);
            if (pinnedCandidate) {
                selectedCandidate = pinnedCandidate;
            }
        }

        // Otherwise, always select the top-priority available candidate (Fill-First)
        if (!selectedCandidate) {
            selectedCandidate = candidates[0];
            if (sessionId) {
                this.#sessionPins.set(sessionId, selectedCandidate.account.email);
            }
        }

        selectedCandidate.account.lastUsed = Date.now();
        if (onSave) onSave();

        logger.debug(`[PriorityStrategy] Selected ${selectedCandidate.account.email} (Priority: ${selectedCandidate.priority}) for ${modelId || 'any'}`);

        return {
            account: selectedCandidate.account,
            index: selectedCandidate.index,
            waitMs: 0 // Zero artificial delay
        };
    }

    /**
     * Handle request success
     * @param {Object} account - Account used
     * @param {string} modelId - Model ID
     */
    onSuccess(account, modelId) {
        // Priority strategy remains stickily with the top priority account
    }

    /**
     * Handle rate limit event
     * @param {Object} account - Rate-limited account
     * @param {string} modelId - Model ID
     */
    onRateLimit(account, modelId) {
        logger.info(`[PriorityStrategy] Account ${account?.email} rate-limited on ${modelId}. Failing over to next priority candidate.`);
        if (account?.email) {
            for (const [sId, email] of this.#sessionPins.entries()) {
                if (email === account.email) {
                    this.#sessionPins.delete(sId);
                }
            }
        }
    }

    /**
     * Handle general failure event
     * @param {Object} account - Failed account
     * @param {string} modelId - Model ID
     */
    onFailure(account, modelId) {
        logger.warn(`[PriorityStrategy] Request failed on ${account?.email} for ${modelId}.`);
    }

    /**
     * Clear session pin
     * @param {string} sessionId - Session ID to unpin
     */
    clearSessionPin(sessionId) {
        this.#sessionPins.delete(sessionId);
    }
}
