/**
 * Phase: SMTP intel domain health check.
 *
 * Defers the attempt when the recipient domain is in a degraded or
 * blocking state based on recent SMTP response patterns. The intel
 * helper returns the remaining defer interval in milliseconds.
 */

import * as smtpResponse from '../../intelligence/smtpResponse.js';
import { logger } from '../../monitoring/logger.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx } from '../types.js';

export const smtpIntelPhase: Phase<BasePhaseCtx, BasePhaseCtx> = {
	name: 'smtp_intel',
	async run(deps, ctx) {
		const deferMs = await smtpResponse.shouldDefer(deps.redis, ctx.domain);
		if (deferMs > 0) {
			logger.debug({ domain: ctx.domain, deferMs }, 'SMTP intel suggests deferral');
			return {
				kind: 'defer',
				delayMs: deferMs,
				reason: `Domain ${ctx.domain} in degraded/blocking state`,
			};
		}
		return { kind: 'continue', ctx };
	},
};
