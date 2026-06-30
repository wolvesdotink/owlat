/**
 * Phase index — re-exports every phase and the composed main pipeline.
 *
 * The handler imports `mainPipeline` only; individual phase files are
 * imported here exclusively. Reordering a phase in this file is a
 * TypeScript error if it violates the ctx-chain (e.g., placing
 * `selectIpPhase` before `resolvePoolPhase` because `selectIpPhase`
 * consumes `pool` and `dedicatedIp` from `CtxWithPool`).
 */

import { compose } from '../pipeline.js';
import { contentScreeningPhase } from './contentScreening.js';
import { suppressionPhase } from './suppression.js';
import { circuitBreakerPhase } from './circuitBreaker.js';
import { orgLimitPhase } from './orgLimit.js';
import { smtpIntelPhase } from './smtpIntel.js';
import { domainBackoffPhase } from './domainBackoff.js';
import { resolvePoolPhase } from './resolvePool.js';
import { selectIpPhase } from './selectIp.js';
import { acquireSlotPhase } from './acquireSlot.js';
import { warmingCapPhase } from './warmingCap.js';

export {
	contentScreeningPhase,
	suppressionPhase,
	circuitBreakerPhase,
	orgLimitPhase,
	smtpIntelPhase,
	domainBackoffPhase,
	resolvePoolPhase,
	selectIpPhase,
	acquireSlotPhase,
	warmingCapPhase,
};

/**
 * The main dispatch pipeline composed in the order the pre-deepening
 * handler ran its check blocks. Type-checking enforces the chain:
 * `resolvePoolPhase` must precede `selectIpPhase`, which must precede
 * `acquireSlotPhase` and `warmingCapPhase`.
 */
export const mainPipeline = compose(
	contentScreeningPhase,
	suppressionPhase,
	circuitBreakerPhase,
	orgLimitPhase,
	smtpIntelPhase,
	domainBackoffPhase,
	resolvePoolPhase,
	selectIpPhase,
	acquireSlotPhase,
	warmingCapPhase,
);
