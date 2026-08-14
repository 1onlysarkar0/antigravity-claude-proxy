/**
 * Hybrid Strategy (Aliased to OmniRoute Priority Fill-First)
 *
 * Provides backward compatibility for the 'hybrid' strategy name while
 * utilizing the deterministic, zero-artificial-delay Priority architecture.
 */

import { PriorityStrategy } from './priority-strategy.js';

export class HybridStrategy extends PriorityStrategy {
    /**
     * Create a new HybridStrategy (powered by PriorityStrategy)
     * @param {Object} config - Strategy configuration
     */
    constructor(config = {}) {
        super(config);
    }
}
