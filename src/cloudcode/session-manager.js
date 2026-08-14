/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching and concurrency isolation.
 * Subagents and distinct conversations get isolated session IDs to prevent
 * session collision and 429 lockouts in Cloud Code PA.
 */

import crypto from 'crypto';

// Runtime storage for session IDs (keyed by conversation seed + accountEmail)
const conversationSessionStore = new Map();

/**
 * Get or create a session ID for a conversation.
 * Scoped by conversation fingerprint to ensure subagents run in isolated sessions.
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} accountEmail - The account email
 * @returns {string} A stable session ID string
 */
export function deriveSessionId(anthropicRequest, accountEmail) {
    try {
        let seed = '';
        const messages = anthropicRequest?.messages || [];
        const firstUserMsg = messages.find(m => m.role === 'user');

        if (firstUserMsg) {
            if (typeof firstUserMsg.content === 'string') {
                seed = firstUserMsg.content.substring(0, 300);
            } else if (Array.isArray(firstUserMsg.content)) {
                const textBlock = firstUserMsg.content.find(b => b.type === 'text');
                if (textBlock && textBlock.text) {
                    seed = textBlock.text.substring(0, 300);
                }
            }
        }

        // Include system prompt to distinguish specialized agents (e.g. database-agent vs research-agent)
        if (anthropicRequest?.system) {
            const sysText = typeof anthropicRequest.system === 'string'
                ? anthropicRequest.system
                : (Array.isArray(anthropicRequest.system) ? (anthropicRequest.system[0]?.text || '') : '');
            seed = sysText.substring(0, 200) + '::' + seed;
        }

        if (seed) {
            const key = `${accountEmail || 'default'}:${crypto.createHash('md5').update(seed).digest('hex')}`;
            if (conversationSessionStore.has(key)) {
                return conversationSessionStore.get(key);
            }
            const newId = crypto.randomUUID() + Date.now().toString();
            conversationSessionStore.set(key, newId);
            return newId;
        }
    } catch {
        // Ignore seed generation errors
    }

    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all stored session IDs
 */
export function clearSessionStore() {
    conversationSessionStore.clear();
}
