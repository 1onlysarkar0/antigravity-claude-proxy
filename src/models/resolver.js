/**
 * Dynamic Model Resolver
 *
 * Implements 100% dynamic model discovery, fuzzy prefix matching, and fail-open routing
 * directly from live upstream Google Cloud Code models without hardcoded model tables.
 */

import { getLiveAvailableModelIds } from '../cloudcode/model-api.js';

/**
 * Detect model family from model name dynamically.
 * @param {string} modelName
 * @returns {'claude' | 'gemini' | 'openai' | 'custom'}
 */
export function getModelFamily(modelName) {
    if (!modelName) return 'custom';
    const lower = modelName.toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gemini')) return 'gemini';
    if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) return 'openai';
    return 'custom';
}

/**
 * Check if a model dynamically supports thinking/reasoning.
 * @param {string} modelName
 * @returns {boolean}
 */
export function supportsThinking(modelName) {
    if (!modelName) return false;
    const lower = modelName.toLowerCase();
    // Claude models and explicit thinking models support reasoning
    if (lower.includes('claude')) return true;
    if (lower.includes('thinking')) return true;
    return false;
}

/**
 * Dynamically resolve a client-requested model to an active upstream model ID.
 *
 * @param {string} requestedModel - The model requested by the client (e.g. "claude-3-7-sonnet", "gemini-3.7-flash")
 * @param {Set<string> | string[]} [activeUpstreamModels] - Set of model IDs currently returned by Cloud Code API
 * @param {Object} [userMapping] - Optional user configured model mapping
 * @returns {string} The resolved upstream model ID
 */
export function resolveTargetModel(requestedModel, activeUpstreamModels = null, userMapping = {}) {
    if (!requestedModel) return 'claude-sonnet-4-6';

    // 1. User configured explicit mapping takes highest precedence
    if (userMapping && userMapping[requestedModel] && userMapping[requestedModel].mapping) {
        return userMapping[requestedModel].mapping;
    }

    const availableSet = activeUpstreamModels
        ? (activeUpstreamModels instanceof Set ? activeUpstreamModels : new Set(activeUpstreamModels))
        : getLiveAvailableModelIds();

    // 2. If the model is directly available upstream, pass through unchanged
    if (availableSet && availableSet.has(requestedModel)) {
        return requestedModel;
    }

    const lower = requestedModel.toLowerCase();

    // 3. Dynamic upstream resolution by matching keywords / family
    if (availableSet && availableSet.size > 0) {
        const liveList = Array.from(availableSet);

        // Claude family matching
        if (lower.includes('claude')) {
            if (lower.includes('opus')) {
                const opus = liveList.find(m => m.toLowerCase().includes('opus'));
                if (opus) return opus;
            }
            // Prefer sonnet
            const sonnet = liveList.find(m => m.toLowerCase().includes('sonnet'));
            if (sonnet) return sonnet;

            const anyClaude = liveList.find(m => m.toLowerCase().includes('claude'));
            if (anyClaude) return anyClaude;
        }

        // Gemini Flash family matching
        if (lower.includes('flash')) {
            if (lower.includes('low') || lower.includes('lite') || lower.includes('extra-low')) {
                const lowFlash = liveList.find(m => m.toLowerCase().includes('flash') && (m.includes('low') || m.includes('lite')));
                if (lowFlash) return lowFlash;
            }
            // Prefer high / tiered flash
            const highFlash = liveList.find(m => m.toLowerCase().includes('flash') && (m.includes('high') || m.includes('tiered')));
            if (highFlash) return highFlash;

            const anyFlash = liveList.find(m => m.toLowerCase().includes('flash'));
            if (anyFlash) return anyFlash;
        }

        // Gemini Pro family matching
        if (lower.includes('pro')) {
            if (lower.includes('low')) {
                const lowPro = liveList.find(m => m.toLowerCase().includes('pro') && m.includes('low'));
                if (lowPro) return lowPro;
            }
            const highPro = liveList.find(m => m.toLowerCase().includes('pro') && (m.includes('agent') || m.includes('high') || m.includes('2.5')));
            if (highPro) return highPro;

            const anyPro = liveList.find(m => m.toLowerCase().includes('pro'));
            if (anyPro) return anyPro;
        }
    }

    // 4. Fail-open: pass through requested model ID directly
    return requestedModel;
}

/**
 * Dynamically cap thinking budget based on model type
 * @param {string} modelId
 * @param {number} budget
 * @returns {number}
 */
export function capThinkingBudget(modelId, budget) {
    if (typeof budget !== 'number' || isNaN(budget) || budget <= 0) return 0;
    const lower = (modelId || '').toLowerCase();
    // Non-thinking Flash models do not accept thinking budget
    if (lower.includes('flash') && !lower.includes('thinking')) {
        return 0;
    }
    // Claude / Pro thinking models allow up to 64000
    return Math.min(budget, 64000);
}

/**
 * Dynamically cap maxOutputTokens
 * @param {string} modelId
 * @param {number} requested
 * @returns {number}
 */
export function capMaxOutputTokens(modelId, requested) {
    if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
        return Math.min(requested, 65536);
    }
    return 65536;
}
