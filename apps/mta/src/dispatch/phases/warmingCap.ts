/**
 * Phase: per-IP warming cap.
 *
 * Defers the attempt (5 min) when the IP has hit its daily send cap for
 * the current warming day. Graduated IPs report `allowed: true` with an
 * `Infinity` cap.
 */

import * as warming from '../../intelligence/warming.js';
import { logger } from '../../monitoring/logger.js';
import type { Phase } from '../pipeline.js';
import type { CtxWithIp } from '../types.js';

export const warmingCapPhase: Phase<CtxWithIp, CtxWithIp> = {
	name: 'warming_cap',
	async run(deps, ctx) {
		const reservation = ctx.job.routingLease?.warmingReservation;
		if (
			reservation?.ip === ctx.ip &&
			(await warming.isWarmingReservationValid(deps.redis, reservation))
		) {
			return { kind: 'continue', ctx };
		}
		const warmingCap = await warming.checkCap(deps.redis, ctx.ip);
		if (!warmingCap.allowed) {
			logger.debug(
				{ ip: ctx.ip, sentToday: warmingCap.sentToday, dailyCap: warmingCap.dailyCap },
				'Warming cap reached — deferring'
			);
			return {
				kind: 'defer',
				delayMs: 300_000,
				reason: `Warming cap reached for IP ${ctx.ip}`,
			};
		}
		return { kind: 'continue', ctx };
	},
};
