/**
 * Antigravity 429 Classification and Retry Decision Engine
 *
 * Implements OmniRoute's 4-category classification and nuanced retry decisions:
 *
 * Categories:
 *   - soft_rate_limit:  Temporary burst limit, instant retry
 *   - rate_limited:     Per-minute rate limit, short backoff + same auth retry
 *   - quota_exhausted:  Daily/plan quota gone, switch auth or long cooldown
 *   - unknown:          Generic 429, exponential backoff
 *
 * Decisions:
 *   - instant_retry_same_auth:       Retry immediately on same auth
 *   - soft_retry:                    Wait briefly, retry same auth
 *   - short_cooldown_switch_auth:    5min cooldown, try next account
 *   - full_quota_exhausted:          24h cooldown (or API reset time), skip this account
 */

export const SHORT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
export const INSTANT_RETRY_THRESHOLD_MS = 3 * 1000; // 3 seconds
export const FULL_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

const QUOTA_EXHAUSTED_KEYWORDS = [
    'quota_exhausted',
    'quota exhausted',
    'individual quota reached',
    'quota reached',
    'enable overages',
    'individual quota',
    'free tier',
    'daily limit',
    'exhausted your capacity',
    'daily quota',
    'monthly quota',
];

// IMPORTANT: Google Cloud Code uses RESOURCE_EXHAUSTED for BURST/SESSION limits
// (resets in 2-30 seconds), NOT daily quota. It must NOT trigger 24h lockout.
// Only treat resource_exhausted as quota if combined with daily/quota keywords above.
const BURST_ONLY_KEYWORDS = [
    'resource_exhausted',
    'resource has been exhausted',
];

const CREDITS_EXHAUSTED_KEYWORDS = [
    'google_one_ai',
    'insufficient credit',
    'insufficient credits',
    'not enough credit',
    'not enough credits',
    'credit exhausted',
    'credits exhausted',
    'credit balance',
    'minimumcreditamountforusage',
    'minimum credit amount for usage',
    'minimum credit',
    'insufficient_g1_credits_balance',
    'g1_credits'
];

/**
 * Classify a 429 error message into one of 4 categories (matching OmniRoute)
 * @param {string} errorMessage
 * @returns {'unknown' | 'rate_limited' | 'quota_exhausted' | 'soft_rate_limit'}
 */
export function classify429(errorMessage) {
    const lower = (errorMessage || '').toLowerCase();

    // Cloud Code may report an exhausted-capacity message with a zero reset window for a burst throttle.
    // Explicit zero reset is stronger evidence than generic wording, so retry briefly instead of applying durable cooldown.
    if (/\breset\s+(?:after|in)\s+0s\b/.test(lower)) {
        return 'rate_limited';
    }

    // 1. Quota exhaustion keywords (genuine daily/plan limits)
    for (const kw of QUOTA_EXHAUSTED_KEYWORDS) {
        if (lower.includes(kw)) return 'quota_exhausted';
    }

    // 2. Google One Credits exhaustion
    for (const kw of CREDITS_EXHAUSTED_KEYWORDS) {
        if (lower.includes(kw)) return 'quota_exhausted';
    }

    // 3. Google Cloud Code RESOURCE_EXHAUSTED = BURST/SESSION limit (NOT daily quota!)
    //    These reset in 2-30 seconds and must NOT trigger the 24h lockout.
    //    Treat them the same as rate_limited (short cooldown, switch account).
    for (const kw of BURST_ONLY_KEYWORDS) {
        if (lower.includes(kw)) return 'rate_limited';
    }

    // 4. Rate limit / RPM / per-minute
    if (
        lower.includes('per minute') ||
        lower.includes('rpm') ||
        lower.includes('rate limit') ||
        lower.includes('rate_limit') ||
        lower.includes('too many requests')
    ) {
        return 'rate_limited';
    }

    // 5. Soft / burst limits
    if (lower.includes('try again') || lower.includes('temporarily') || lower.includes('high traffic')) {
        return 'soft_rate_limit';
    }

    return 'unknown';
}

/**
 * Make a decision on how to handle the 429 error
 *
 * @param {'unknown' | 'rate_limited' | 'quota_exhausted' | 'soft_rate_limit'} category
 * @param {number|null} retryAfterMs
 * @returns {{kind: 'instant_retry_same_auth' | 'soft_retry' | 'short_cooldown_switch_auth' | 'full_quota_exhausted', retryAfterMs: number, reason: string}}
 */
export function decide429(category, retryAfterMs) {
    switch (category) {
        case 'soft_rate_limit':
            return {
                kind: (retryAfterMs && retryAfterMs <= INSTANT_RETRY_THRESHOLD_MS)
                    ? 'instant_retry_same_auth'
                    : 'soft_retry',
                retryAfterMs: retryAfterMs ?? 2000,
                reason: 'Soft rate limit — brief backoff'
            };

        case 'rate_limited':
            return {
                kind: (retryAfterMs && retryAfterMs <= SHORT_COOLDOWN_MS)
                    ? 'soft_retry'
                    : 'short_cooldown_switch_auth',
                retryAfterMs: retryAfterMs ?? 60000,
                reason: 'RPM rate limit — switch account if cooldown is long'
            };

        case 'quota_exhausted':
            return {
                kind: 'full_quota_exhausted',
                // Cap at 30 minutes even for real quota exhaustion.
                // If it IS a daily limit, the next request will 429 again and we re-lock.
                // This prevents false-positive 24h lockouts from misclassified burst limits.
                retryAfterMs: retryAfterMs ?? (30 * 60 * 1000), // 30 min default (not 24h)
                reason: 'Quota exhausted — switch account or wait for reset'
            };

        default:
            return {
                kind: 'soft_retry',
                retryAfterMs: retryAfterMs ?? 5000,
                reason: 'Generic 429 backoff'
            };
    }
}
