/**
 * Phase: per-domain connection-failure backoff.
 *
 * Defers the attempt when the recipient domain has had recent TCP-level
 * connection failures (distinct from SMTP-level intel). The helper
 * tracks exponential backoff per domain.
 */

import { shouldBackoffDomain } from '../../scaling/degradation.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx } from '../types.js';

export const domainBackoffPhase: Phase<BasePhaseCtx, BasePhaseCtx> = {
	name: 'domain_backoff',
	async run(deps, ctx) {
		const backoff = await shouldBackoffDomain(deps.redis, ctx.domain);
		if (backoff.backoff) {
			return {
				kind: 'defer',
				delayMs: backoff.retryAfter ?? 30_000,
				reason: `Domain ${ctx.domain} connection backoff`,
			};
		}
		return { kind: 'continue', ctx };
	},
};
