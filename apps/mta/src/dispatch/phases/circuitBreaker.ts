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
		const globalResult = await circuitBreaker.canSend(deps.redis, ctx.job.organizationId);
		const providerResult = await circuitBreaker.canSend(
			deps.redis,
			ctx.job.organizationId,
			ctx.destination.providerKey
		);
		const lease = ctx.job.routingLease;
		const generationChanged = Boolean(
			lease &&
			(globalResult.generation !== lease.globalBreakerGeneration ||
				providerResult.generation !== lease.providerBreakerGeneration)
		);
		let probesCurrent = true;
		if (globalResult.state === 'half-open') {
			probesCurrent = Boolean(
				lease?.globalProbe &&
				(await circuitBreaker.reserveHalfOpenProbe(
					deps.redis,
					ctx.job.organizationId,
					undefined,
					ctx.job.messageId,
					Date.now(),
					globalResult.generation
				))
			);
		}
		if (probesCurrent && providerResult.state === 'half-open') {
			probesCurrent = Boolean(
				lease?.probe &&
				(await circuitBreaker.reserveHalfOpenProbe(
					deps.redis,
					ctx.job.organizationId,
					ctx.destination.providerKey,
					ctx.job.messageId,
					Date.now(),
					providerResult.generation
				))
			);
		}
		if (!globalResult.allowed || !providerResult.allowed || generationChanged || !probesCurrent) {
			logger.info(
				{
					orgId: ctx.job.organizationId,
					state: !globalResult.allowed ? globalResult.state : providerResult.state,
					retryAfter: globalResult.retryAfter ?? providerResult.retryAfter,
					generationChanged,
				},
				'Circuit breaker OPEN — deferring'
			);
			return {
				kind: 'defer',
				delayMs: globalResult.retryAfter ?? providerResult.retryAfter ?? 60_000,
				reason: `Circuit breaker open for org ${ctx.job.organizationId}`,
			};
		}
		return { kind: 'continue', ctx };
	},
};
