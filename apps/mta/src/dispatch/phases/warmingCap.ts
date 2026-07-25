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
		if (reservation?.ip === ctx.ip) {
			const current = await warming.ensureWarmingReservation(deps.redis, reservation);
			if (!current.allowed) {
				const reason = `Warming reservation unavailable for IP ${ctx.ip}`;
				return ctx.job.routingReentryToken
					? { kind: 'routing_reentry', reason }
					: { kind: 'defer', delayMs: 300_000, reason };
			}
			const routingLease = { ...ctx.job.routingLease! };
			if (current.reservation) {
				routingLease.warmingReservation = current.reservation;
			} else {
				// Graduated/uncapped IPs intentionally reserve no capacity. Drop
				// the obsolete reservation so delivery uses unreserved accounting.
				delete routingLease.warmingReservation;
			}
			return {
				kind: 'continue',
				ctx: {
					...ctx,
					job: {
						...ctx.job,
						routingLease,
					},
				},
			};
		}
		const warmingCap = await warming.checkCap(deps.redis, ctx.ip);
		if (!warmingCap.allowed) {
			logger.debug(
				{ ip: ctx.ip, sentToday: warmingCap.sentToday, dailyCap: warmingCap.dailyCap },
				'Warming cap reached — deferring'
			);
			const reason = `Warming cap reached for IP ${ctx.ip}`;
			return ctx.job.routingReentryToken
				? { kind: 'routing_reentry', reason }
				: { kind: 'defer', delayMs: 300_000, reason };
		}
		return { kind: 'continue', ctx };
	},
};
