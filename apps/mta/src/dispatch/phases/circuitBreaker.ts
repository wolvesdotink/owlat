/**
 * Phase: per-organization circuit breaker.
 *
 * Defers the attempt when the org's bounce/complaint rate has tripped the
 * breaker. The breaker's own `retryAfter` (when present) sets the delay;
 * otherwise a 60s default applies.
 */

import * as circuitBreaker from '../../intelligence/circuitBreaker.js';
import { logger } from '../../monitoring/logger.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx } from '../types.js';

export const circuitBreakerPhase: Phase<BasePhaseCtx, BasePhaseCtx> = {
	name: 'circuit_breaker',
	async run(deps, ctx) {
		const breakerResult = await circuitBreaker.canSend(deps.redis, ctx.job.organizationId);
		if (!breakerResult.allowed) {
			logger.info(
				{
					orgId: ctx.job.organizationId,
					state: breakerResult.state,
					retryAfter: breakerResult.retryAfter,
				},
				'Circuit breaker OPEN — deferring',
			);
			return {
				kind: 'defer',
				delayMs: breakerResult.retryAfter ?? 60_000,
				reason: `Circuit breaker open for org ${ctx.job.organizationId}`,
			};
		}
		return { kind: 'continue', ctx };
	},
};
