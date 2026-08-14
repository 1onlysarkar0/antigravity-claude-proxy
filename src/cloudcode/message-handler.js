/**
 * Message Handler for Cloud Code
 *
 * Handles non-streaming message requests with multi-account support,
 * retry logic, and endpoint failover.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    DEFAULT_COOLDOWN_MS,
    SWITCH_ACCOUNT_DELAY_MS,
    MAX_CONSECUTIVE_FAILURES,
    EXTENDED_COOLDOWN_MS,
    CAPACITY_BACKOFF_TIERS_MS,
    MAX_CAPACITY_RETRIES,
    BACKOFF_BY_ERROR_TYPE,
    isThinkingModel
} from '../constants.js';
import { convertGoogleToAnthropic } from '../format/index.js';
import { isRateLimitError, isAuthError, isAccountForbiddenError, AccountForbiddenError } from '../errors.js';
import { formatDuration, sleep, isNetworkError, throttledFetch } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { parseThinkingSSEResponse } from './sse-parser.js';
import { getFallbackModel } from '../fallback-config.js';
import { classify429, decide429 } from './antigravity-429-engine.js';
import {
    getRateLimitBackoff,
    clearRateLimitState,
    isPermanentAuthFailure,
    isModelCapacityExhausted,
    isValidationRequired,
    extractVerificationUrl,
    isAccountBanned,
    calculateSmartBackoff
} from './rate-limit-state.js';

/**
 * Send a non-streaming request to Cloud Code with multi-account support
 * Uses SSE endpoint for thinking models (non-streaming doesn't return thinking blocks)
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {Object} anthropicRequest.model - Model name to use
 * @param {Array} anthropicRequest.messages - Array of message objects
 * @param {number} [anthropicRequest.max_tokens] - Maximum tokens to generate
 * @param {Object} [anthropicRequest.thinking] - Thinking configuration
 * @param {import('../account-manager/index.js').default} accountManager - The account manager instance
 * @returns {Promise<Object>} Anthropic-format response object
 * @throws {Error} If max retries exceeded or no accounts available
 */
export async function sendMessage(anthropicRequest, accountManager, fallbackEnabled = false) {
    const model = anthropicRequest.model;
    const isThinking = isThinkingModel(model);

    // Retry loop with account failover
    // Ensure we try at least as many times as there are accounts to cycle through everyone
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Clear any expired rate limits before picking
        accountManager.clearExpiredLimits();

        // Get available accounts for this model
        const availableAccounts = accountManager.getAvailableAccounts(model);

        // If no accounts available, check if we should wait or throw error
        if (availableAccounts.length === 0) {
            // All accounts invalid? Fail immediately — they need user intervention (WebUI FIX button)
            // Invalid accounts won't self-recover, so waiting would be an infinite loop
            if (accountManager.isAllAccountsInvalid()) {
                const invalidAccounts = accountManager.getInvalidAccounts();
                const reasons = [...new Set(invalidAccounts.map(a => a.invalidReason).filter(Boolean))];
                throw new Error(
                    `All accounts are invalid: ${reasons.join('; ') || 'unknown reason'}. Visit the WebUI to fix them.`
                );
            }

            if (accountManager.isAllRateLimited(model)) {
                // 1. Try immediate dynamic fallback if an available fallback model exists with quota
                if (fallbackEnabled) {
                    const fallbackModel = getFallbackModel(model, null, (m) => !accountManager.isAllRateLimited(m));
                    if (fallbackModel) {
                        logger.warn(`[CloudCode] All accounts rate-limited for ${model}. Immediate dynamic fallback to ${fallbackModel}`);
                        const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                        return await sendMessage(fallbackRequest, accountManager, false);
                    }
                }

                const minWaitMs = accountManager.getMinWaitTimeMs(model);
                const resetTime = new Date(Date.now() + minWaitMs).toISOString();

                // 2. If wait time is too long (> 2 minutes), throw error
                if (minWaitMs > MAX_WAIT_BEFORE_ERROR_MS) {
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited on ${model}. Quota will reset after ${formatDuration(minWaitMs)}. Next available: ${resetTime}`
                    );
                }

                // 3. Otherwise wait for shortest reset time
                const accountCount = accountManager.getAccountCount();
                logger.warn(`[CloudCode] All ${accountCount} account(s) rate-limited on ${model}. Waiting ${formatDuration(minWaitMs)}...`);
                await sleep(minWaitMs + 500); // Add 500ms buffer
                accountManager.clearExpiredLimits();

                // CRITICAL FIX: Don't count waiting for rate limits as a failed attempt
                attempt--;
                continue; // Retry the loop
            }

            // No accounts available and not rate-limited (shouldn't happen normally)
            throw new Error('No accounts available');
        }

        // Select account using configured strategy
        const { account, waitMs } = accountManager.selectAccount(model);

        // If strategy returns a wait time without an account, sleep and retry
        if (!account && waitMs > 0) {
            logger.info(`[CloudCode] Waiting ${formatDuration(waitMs)} for account...`);
            await sleep(waitMs + 500);
            attempt--; // CRITICAL FIX: Don't count strategy wait as failure
            continue;
        }

        // If strategy returns an account with throttle wait (fallback mode), apply delay
        // This prevents overwhelming the API when using emergency/lastResort fallbacks
        if (account && waitMs > 0) {
            logger.debug(`[CloudCode] Throttling request (${waitMs}ms) - fallback mode active`);
            await sleep(waitMs);
        }

        if (!account) {
            logger.warn(`[CloudCode] Strategy returned no account for ${model} (attempt ${attempt + 1}/${maxAttempts})`);
            continue;
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project, account.email);

            logger.debug(`[CloudCode] Sending request for model: ${model}`);

            // Try each endpoint with index-based loop for capacity retry support
            let lastError = null;
            let capacityRetryCount = 0;
            let endpointIndex = 0;

            while (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length) {
                const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex];
                try {
                    const url = isThinking
                        ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
                        : `${endpoint}/v1internal:generateContent`;

                    const response = await throttledFetch(url, {
                        method: 'POST',
                        headers: buildHeaders(token, model, isThinking ? 'text/event-stream' : 'application/json', payload.request.sessionId),
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.warn(`[CloudCode] Error at ${endpoint}: ${response.status} - ${errorText}`);

                        if (response.status === 401) {
                            // Check for permanent auth failures
                            if (isPermanentAuthFailure(errorText)) {
                                logger.error(`[CloudCode] Permanent auth failure for ${account.email}: ${errorText.substring(0, 100)}`);
                                accountManager.markInvalid(account.email, 'Token revoked - re-authentication required');
                                throw new Error(`AUTH_INVALID_PERMANENT: ${errorText}`);
                            }

                            // Transient auth error - clear caches and retry with fresh token
                            logger.warn('[CloudCode] Transient auth error, refreshing token...');
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            endpointIndex++;
                            continue;
                        }

                        if (response.status === 429) {
                            const category = classify429(errorText);
                            const resetMs = parseResetTime(response, errorText);
                            const decision = decide429(category, resetMs);
                            const enabledAccounts = (accountManager.accounts || []).filter(a => a.enabled !== false && !a.isInvalid);
                            const isSingleAccount = enabledAccounts.length <= 1;

                            logger.info(`[CloudCode] 429 (${category} -> ${decision.kind}): ${decision.reason} (${account.email})`);

                            // Single account active: soft retry in-place
                            if (isSingleAccount) {
                                if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                    const waitMs = Math.min((capacityRetryCount + 1) * 2000, 8000);
                                    capacityRetryCount++;
                                    logger.info(`[CloudCode] Rate limit on ${account.email} (single-account mode), retrying ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`);
                                    await sleep(waitMs);
                                    continue;
                                }
                                accountManager.markRateLimited(account.email, decision.retryAfterMs, model);
                                throw new Error(`RATE_LIMIT: ${decision.reason}. Resumes in ${formatDuration(decision.retryAfterMs)}.`);
                            }

                            if (decision.kind === 'instant_retry_same_auth') {
                                logger.info(`[CloudCode] Instant retry on same account after ${decision.retryAfterMs}ms...`);
                                await sleep(decision.retryAfterMs);
                                continue;
                            }

                            if (decision.kind === 'soft_retry') {
                                if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                    capacityRetryCount++;
                                    const waitMs = Math.min(decision.retryAfterMs, 5000);
                                    logger.info(`[CloudCode] Soft retry on ${account.email} (${capacityRetryCount}/${MAX_CAPACITY_RETRIES}), waiting ${formatDuration(waitMs)}...`);
                                    await sleep(waitMs);
                                    continue;
                                }
                            }

                            // For short_cooldown_switch_auth or full_quota_exhausted or exceeded soft retries:
                            accountManager.markRateLimited(account.email, decision.retryAfterMs, model);
                            throw new Error(`QUOTA_EXHAUSTED: ${errorText}`);
                        }

                        if (response.status >= 400) {
                            // Check for 503/529 MODEL_CAPACITY_EXHAUSTED - use progressive backoff like 429 capacity
                            // 529 = Site Overloaded (same treatment as 503)
                            if ((response.status === 503 || response.status === 529) && isModelCapacityExhausted(errorText)) {
                                if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                    // Progressive capacity backoff tiers (same as 429 capacity handling)
                                    const tierIndex = Math.min(capacityRetryCount, CAPACITY_BACKOFF_TIERS_MS.length - 1);
                                    const waitMs = CAPACITY_BACKOFF_TIERS_MS[tierIndex];
                                    capacityRetryCount++;
                                    accountManager.incrementConsecutiveFailures(account.email);
                                    logger.info(`[CloudCode] ${response.status} Model capacity exhausted, retry ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`);
                                    await sleep(waitMs);
                                    // Don't increment endpointIndex - retry same endpoint
                                    continue;
                                }
                                // Max capacity retries exceeded - switch account
                                logger.warn(`[CloudCode] Max capacity retries (${MAX_CAPACITY_RETRIES}) exceeded on ${response.status}, switching account`);
                                accountManager.markRateLimited(account.email, BACKOFF_BY_ERROR_TYPE.MODEL_CAPACITY_EXHAUSTED, model);
                                throw new Error(`CAPACITY_EXHAUSTED: ${errorText}`);
                            }

                            // 400 errors are client errors - fail immediately, don't retry or switch accounts
                            // Examples: token limit exceeded, invalid schema, malformed request
                            if (response.status === 400) {
                                logger.error(`[CloudCode] Invalid request (400): ${errorText.substring(0, 200)}`);
                                throw new Error(`invalid_request_error: ${errorText}`);
                            }

                            // 403 with VALIDATION_REQUIRED or PERMISSION_DENIED is an account-level error
                            // The account needs validation (captcha, terms, etc.) - trying different endpoints won't help
                            // Mark account as invalid (requires user intervention) and rotate (fixes #248)
                            if (response.status === 403 && isValidationRequired(errorText)) {
                                const verifyUrl = extractVerificationUrl(errorText);
                                const lower = (errorText || '').toLowerCase();
                                const reason = (lower.includes('restricted_age') || lower.includes('not eligible'))
                                    ? 'Account not eligible (18+ age verification required by Google)'
                                    : 'Account requires verification';
                                logger.warn(`[CloudCode] 403 for ${account.email}: ${reason}, marking invalid and rotating account...`);
                                accountManager.markInvalid(account.email, reason, verifyUrl);
                                throw new AccountForbiddenError(errorText, account.email);
                            }

                            // 403 with permanent ToS ban — account is permanently disabled by Google
                            // Unlike VALIDATION_REQUIRED, this cannot be resolved by verification
                            if (response.status === 403 && isAccountBanned(errorText)) {
                                logger.warn(`[CloudCode] 403 ToS BANNED for ${account.email}, marking invalid permanently...`);
                                accountManager.markInvalid(account.email, 'Account banned — Gemini disabled for Terms of Service violation');
                                throw new AccountForbiddenError(errorText, account.email);
                            }

                            lastError = new Error(`API error ${response.status}: ${errorText}`);
                            // Try next endpoint for 403/404/5xx errors (matches opencode-antigravity-auth behavior)
                            if (response.status === 403 || response.status === 404) {
                                logger.warn(`[CloudCode] ${response.status} at ${endpoint}...`);
                            } else if (response.status >= 500) {
                                logger.warn(`[CloudCode] ${response.status} error, waiting 1s before retry...`);
                                await sleep(1000);
                            }
                            endpointIndex++;
                            continue;
                        }
                    }

                    // For thinking models, parse SSE and accumulate all parts
                    if (isThinking) {
                        const result = await parseThinkingSSEResponse(response, anthropicRequest.model);
                        // Clear rate limit state on success
                        clearRateLimitState(account.email, model);
                        accountManager.notifySuccess(account, model);
                        return result;
                    }

                    // Non-thinking models use regular JSON
                    const data = await response.json();
                    logger.debug('[CloudCode] Response received');
                    // Clear rate limit state on success
                    clearRateLimitState(account.email, model);
                    accountManager.notifySuccess(account, model);
                    return convertGoogleToAnthropic(data, anthropicRequest.model);

                } catch (endpointError) {
                    if (isRateLimitError(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    // 403 account-level errors - re-throw to trigger account rotation
                    if (isAccountForbiddenError(endpointError)) {
                        throw endpointError;
                    }
                    // 400 errors are client errors - re-throw immediately, don't retry
                    if (endpointError.message?.includes('400')) {
                        throw endpointError;
                    }
                    logger.warn(`[CloudCode] Error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                    endpointIndex++;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                if (lastError.is429) {
                    logger.warn(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs, model);
                    throw new Error(`Rate limited: ${lastError.errorText}`);
                }
                throw lastError;
            }

        } catch (error) {
            if (isRateLimitError(error)) {
                // Rate limited - already marked, notify strategy and continue to next account
                accountManager.notifyRateLimit(account, model);
                logger.info(`[CloudCode] Account ${account.email} rate-limited, trying next...`);

                // CRITICAL FIX: Account switching on rate limits must not burn client retry budget
                attempt--;
                continue;
            }
            if (isAuthError(error)) {
                // Auth invalid - already marked, continue to next account
                logger.warn(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            if (isAccountForbiddenError(error)) {
                // 403 VALIDATION_REQUIRED / PERMISSION_DENIED - account-level error
                // Already marked with cooldown, notify strategy and rotate to next account
                accountManager.notifyFailure(account, model);
                logger.warn(`[CloudCode] Account ${account.email} forbidden (403 VALIDATION_REQUIRED), trying next...`);
                continue;
            }
            // Handle 5xx errors
            if (error.message.includes('API error 5') || error.message.includes('500') || error.message.includes('503')) {
                accountManager.notifyFailure(account, model);

                // Track 5xx errors for extended cooldown
                // Note: markRateLimited already increments consecutiveFailures internally
                const currentFailures = accountManager.getConsecutiveFailures(account.email);
                if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${currentFailures + 1} consecutive failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    accountManager.incrementConsecutiveFailures(account.email);
                    logger.warn(`[CloudCode] Account ${account.email} failed with 5xx error (${currentFailures + 1}/${MAX_CONSECUTIVE_FAILURES}), trying next...`);
                }
                continue;
            }

            if (isNetworkError(error)) {
                accountManager.notifyFailure(account, model);

                // Track network errors for extended cooldown
                // Note: markRateLimited already increments consecutiveFailures internally
                const currentFailures = accountManager.getConsecutiveFailures(account.email);
                if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${currentFailures + 1} consecutive network failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    accountManager.incrementConsecutiveFailures(account.email);
                    logger.warn(`[CloudCode] Network error for ${account.email} (${currentFailures + 1}/${MAX_CONSECUTIVE_FAILURES}), trying next account... (${error.message})`);
                }
                await sleep(1000);
                continue;
            }

            throw error;
        }
    }

    // All retries exhausted - try fallback model if enabled
    if (fallbackEnabled) {
        const fallbackModel = getFallbackModel(model, null, (m) => !accountManager.isAllRateLimited(m));
        if (fallbackModel) {
            logger.warn(`[CloudCode] All retries exhausted for ${model}. Attempting dynamic fallback to ${fallbackModel}`);
            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
            return await sendMessage(fallbackRequest, accountManager, false);
        }
    }

    throw new Error('Max retries exceeded');
}
