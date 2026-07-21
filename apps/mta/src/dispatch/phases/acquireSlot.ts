/**
 * Phase: domain throttle slot acquire.
 *
 * Defers the attempt (5s) when the adaptive per-IP per-domain rate limit
 * has no slot available. The slot is released implicitly when the matching
 * `domain_throttle_*` effect fires in the outcome reducer.
 */

import * as domainThrottle from '../../intelligence/domainThrottle.js';
import type { Phase } from '../pipeline.js';
import type { CtxWithIp } from '../types.js';

export const acquireSlotPhase: Phase<CtxWithIp, CtxWithIp> = {
	name: 'acquire_slot',
	async run(deps, ctx) {
		const slotAcquired = await domainThrottle.acquireSlot(
			deps.redis,
			ctx.ip,
			ctx.throttleKey,
			ctx.providerKey
		);
		if (!slotAcquired) {
			return {
				kind: 'defer',
				delayMs: 5_000,
				reason: `Rate limit exceeded for ${ctx.ip} → ${ctx.throttleKey}`,
			};
		}
		return { kind: 'continue', ctx };
	},
};
