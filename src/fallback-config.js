/**
 * Dynamic Model Fallback Engine
 *
 * Computes graceful degradation paths dynamically based on live upstream models,
 * capabilities, and user configuration without hardcoded fallbacks.
 * Modeled after OmniRoute's extensible fallback architecture.
 */

import { config } from './config.js';
import { getLiveAvailableModelIds } from './cloudcode/model-api.js';
import { getModelFamily } from './models/resolver.js';

/**
 * Upstream-level bounded fallback chains for specific models (matching OmniRoute)
 */
export const UPSTREAM_MODEL_FALLBACK_CHAINS = {
    'gemini-3.1-pro-low': ['gemini-3.1-pro-low', 'gemini-3-pro-low']
};

/**
 * Get dynamic fallback model for a given model ID.
 *
 * @param {string} model - Primary model ID
 * @param {Set<string>|Array<string>} [availableModels] - Optional set of currently available models
 * @param {Function} [isModelAvailable] - Optional callback (modelId) => boolean to check if model has quota
 * @returns {string|null} Fallback model ID or null if no suitable fallback exists
 */
export function getFallbackModel(model, availableModels = null, isModelAvailable = null) {
    if (!model) return null;

    // 1. User-configured explicit fallback mapping in config.json
    const userFallbacks = config.modelFallbacks || {};
    if (userFallbacks[model]) {
        return userFallbacks[model];
    }

    // 2. Upstream bounded fallback chain
    if (UPSTREAM_MODEL_FALLBACK_CHAINS[model]) {
        const chain = UPSTREAM_MODEL_FALLBACK_CHAINS[model];
        for (const candidate of chain) {
            if (candidate !== model) {
                if (!isModelAvailable || isModelAvailable(candidate)) {
                    return candidate;
                }
            }
        }
    }

    // 3. Dynamic resolution against live upstream models
    const liveModels = availableModels
        ? (availableModels instanceof Set ? availableModels : new Set(availableModels))
        : getLiveAvailableModelIds();

    if (!liveModels || liveModels.size === 0) {
        return null;
    }

    const family = getModelFamily(model);
    const lower = model.toLowerCase();

    // Try finding an alternative model within the same family/tier
    const candidates = Array.from(liveModels).filter(m => m !== model);

    // Same family candidates
    const sameFamily = candidates.filter(m => getModelFamily(m) === family);
    for (const candidate of sameFamily) {
        if (!isModelAvailable || isModelAvailable(candidate)) {
            return candidate;
        }
    }

    // Cross-family dynamic tiering
    // If Claude exhausted -> try Pro -> try Flash
    if (family === 'claude') {
        const proCandidates = candidates.filter(m => m.toLowerCase().includes('pro'));
        for (const c of proCandidates) {
            if (!isModelAvailable || isModelAvailable(c)) return c;
        }
        const flashCandidates = candidates.filter(m => m.toLowerCase().includes('flash'));
        for (const c of flashCandidates) {
            if (!isModelAvailable || isModelAvailable(c)) return c;
        }
    }

    // If Gemini Pro exhausted -> try Flash
    if (lower.includes('pro')) {
        const flashCandidates = candidates.filter(m => m.toLowerCase().includes('flash'));
        for (const c of flashCandidates) {
            if (!isModelAvailable || isModelAvailable(c)) return c;
        }
    }

    // If Gemini Flash exhausted -> try other Flash tiers (prioritize high-quota tiered/3.7 flash)
    if (lower.includes('flash')) {
        const tieredFlash = candidates.filter(m => m.toLowerCase().includes('flash') && (m.includes('tiered') || m.includes('3.7')));
        for (const c of tieredFlash) {
            if (!isModelAvailable || isModelAvailable(c)) return c;
        }
        const otherFlash = candidates.filter(m => m.toLowerCase().includes('flash'));
        for (const c of otherFlash) {
            if (!isModelAvailable || isModelAvailable(c)) return c;
        }
    }

    return null;
}

/**
 * Check if a model has a dynamic or configured fallback
 * @param {string} model - Model ID to check
 * @returns {boolean} True if fallback is possible
 */
export function hasFallback(model) {
    return getFallbackModel(model) !== null;
}
