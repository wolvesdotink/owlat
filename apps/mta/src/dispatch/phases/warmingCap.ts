/**
 * Phase: per-IP warming cap, narrowed per mailbox provider and paced across
 * the UTC day.
 *
 * Three gates, in ascending order of strictness:
 *  1. the shipped per-IP daily cap (authoritative — unchanged, and still
 *     bypassed entirely by an attempt holding a live reservation);
 *  2. the per-(IP x mailbox provider) cap derived from it, so an IP that is
 *     trusted at Google can keep crawling at Microsoft;
 *  3. intraday pacing for bulk traffic, so a day's cap is spread across the day
 *     instead of being emptied in the first ten minutes.
 *
 * An attempt that already holds a live warming reservation OWNS its slot: the
 * routing layer promised it capacity, and withholding it here would strand the
 * reservation in the zset until TTL and could expire the routing lease. Such an
 * attempt short-circuits to `continue` exactly as the shipped phase did, before
 * any of the three gates run.
 *
 * Graduated IPs report `allowed: true` with an `Infinity` cap and pass gates 2
 * and 3 untouched.
 */

import * as warming from '../../intelligence/warming.js';
import { nextCapWindowDelayMs } from '../../intelligence/warmingCapWindow.js';
import { utcDateKey } from '../../intelligence/warmingKeys.js';
import { evaluateIntradayPacing, utcDayElapsedFraction } from '../../intelligence/warmingPacing.js';
import {
	providerCapVerdict,
	readProviderVolumePressure,
	readWarmingCapGateInputs,
} from '../../intelligence/warmingProviderStore.js';
import { logger } from '../../monitoring/logger.js';
import type { DispatchTerminal, Phase } from '../pipeline.js';
import type { CtxWithIp, CtxWithProviderPressure } from '../types.js';

/**
 * Deferral applied when a RESERVATION could not be refreshed.
 *
 * Deliberately still the shipped 300 s and NOT the next cap window: a
 * reservation is a short-lived promise of capacity the routing layer already
 * made, and it can become available again within the day (the holder finishes,
 * or the reservation's own TTL lapses). Only the two DAILY cap gates below —
 * whose verdict provably cannot change until the UTC day rolls over — defer to
 * the window.
 */
const RESERVATION_DEFER_DELAY_MS = 300_000;

/**
 * Withhold this attempt. A governed attempt carrying a re-entry token goes back
 * to the routing layer (which may pick a different IP); everything else defers.
 */
function withhold(ctx: CtxWithIp, reason: string, delayMs: number): DispatchTerminal {
	return ctx.job.routingReentryToken
		? { kind: 'routing_reentry', reason }
		: { kind: 'defer', delayMs, reason };
}

export const warmingCapPhase: Phase<CtxWithIp, CtxWithProviderPressure> = {
	name: 'warming_cap',
	async run(deps, ctx) {
		const providerKey = ctx.destination.providerKey;
		const now = Date.now();
		const utcDate = utcDateKey(now);

		const ref = { ip: ctx.ip, provider: providerKey, utcDate };

		const reservation = ctx.job.routingLease?.warmingReservation;
		if (reservation?.ip === ctx.ip) {
			// One extra key alongside the reservation refresh — and only one: a
			// reserved attempt skips gates 2 and 3 by design, so their inputs would
			// be read and thrown away. It still carries the retry-backoff signal
			// into the outcome reducer.
			const [current, volumePressure] = await Promise.all([
				warming.ensureWarmingReservation(deps.redis, reservation),
				readProviderVolumePressure(deps.redis, ctx.ip, providerKey),
			]);
			if (!current.allowed) {
				return withhold(
					ctx,
					`Warming reservation unavailable for IP ${ctx.ip}`,
					RESERVATION_DEFER_DELAY_MS
				);
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
					job: { ...ctx.job, routingLease },
					providerVolumePressure: volumePressure,
				},
			};
		}

		// Gate 1 and the inputs to gates 2/3 are independent reads, so they go out
		// together; the gate-2/3 inputs are only INTERPRETED once gate 1 has
		// yielded the authoritative daily cap.
		const [warmingCap, gateInputs] = await Promise.all([
			warming.checkCap(deps.redis, ctx.ip),
			readWarmingCapGateInputs(deps.redis, ref),
		]);
		if (!warmingCap.allowed) {
			logger.debug(
				{ ip: ctx.ip, sentToday: warmingCap.sentToday, dailyCap: warmingCap.dailyCap },
				'Warming cap reached — deferring'
			);
			// THE NEXT CAP WINDOW, not a blind five minutes: the daily budget cannot
			// change before the UTC day rolls over, so re-asking sooner produces the
			// same verdict and nothing but Redis re-queue churn.
			return withhold(ctx, `Warming cap reached for IP ${ctx.ip}`, nextCapWindowDelayMs(now));
		}

		const providerCap = providerCapVerdict(gateInputs, warmingCap.dailyCap);
		if (!providerCap.allowed) {
			logger.debug(
				{
					ip: ctx.ip,
					providerKey,
					sentToday: providerCap.sentToday,
					providerCap: providerCap.providerCap,
					capMultiplier: providerCap.capMultiplier,
				},
				'Per-provider warming cap reached — deferring'
			);
			return withhold(
				ctx,
				`Warming cap reached for IP ${ctx.ip} at ${providerKey}`,
				nextCapWindowDelayMs(now)
			);
		}

		// Pacing shapes the BULK pool against a BULK-only counter. Feeding it the
		// per-IP total would let transactional volume — which is exempt from
		// pacing and holds its own headroom — defer a small campaign.
		const pacing = evaluateIntradayPacing({
			dailyCap: warmingCap.dailyCap,
			bulkSentToday: ctx.pool === 'campaign' ? gateInputs.bulkSentToday : 0,
			dayElapsedFraction: utcDayElapsedFraction(now),
			pool: ctx.pool,
		});
		if (!pacing.allowed) {
			logger.debug(
				{ ip: ctx.ip, allowance: pacing.allowance, ceiling: pacing.ceiling },
				'Intraday pacing allowance reached — deferring'
			);
			return withhold(
				ctx,
				`Intraday pacing allowance reached for IP ${ctx.ip}`,
				pacing.retryAfterMs
			);
		}

		// Carried on the context so the pure outcome reducer can lengthen this
		// attempt's retry backoff without a Redis dependency of its own.
		return { kind: 'continue', ctx: { ...ctx, providerVolumePressure: gateInputs.volumePressure } };
	},
};
