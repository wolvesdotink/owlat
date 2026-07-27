/**
 * [6] Adaptive IP Warming Schedule
 *
 * Manages per-IP daily send caps that automatically adjust based on
 * actual deliverability signals. Instead of a static warming table,
 * this system accelerates on clean delivery and decelerates on
 * bounces/deferrals.
 */

import type Redis from 'ioredis';
import { BASE_WARMING_SCHEDULE } from '../config.js';
import { LAST_FINITE_WARMING_CAP } from '@owlat/shared/warming';
import type { MtaConfig } from '../config.js';
import type { WarmingPhase, WarmingState } from '../types.js';
import { logger } from '../monitoring/logger.js';
import type { DurableEffectIdentity } from '../lib/effectCheckpoint.js';
import {
	recordDailyWarmingOutcomeOnce,
	recordUnreservedWarmingSendOnce,
} from './warmingOutcomeStore.js';
import { evaluateProviderWarmingDay } from './warmingProviderStore.js';
import {
	applyWarmingGraduation,
	applyWarmingScheduleAdjustment,
} from './warmingScheduleAdjustment.js';
import {
	CHECK_WARMING_CAP_ROLLOVER_LUA,
	GET_NORMALIZED_WARMING_STATE_LUA,
	NORMALIZE_NON_GRADUATED_WARMING_CAP_LUA,
	RECORD_RESERVED_WARMING_SEND_LUA,
	RESERVE_WARMING_SLOT_LUA,
	WARMING_RESERVATION_TTL_MS,
} from './warmingScripts.js';
import {
	utcDateKey,
	warmingDailyStatsKey,
	warmingReservationReceiptKey,
	warmingReservationsKey,
	warmingStateKey,
} from './warmingKeys.js';
import {
	decodeCanonicalPositiveSafeInteger,
	decodeNormalizedDailyCap,
} from './warmingStateCodec.js';

export interface WarmingReservation {
	ip: string;
	messageId: string;
	utcDate: string;
	expiresAt: number;
}

/** Atomically reserve one authoritative per-IP warming slot for a message. */
export async function reserveWarmingSlot(
	redis: Redis,
	ip: string,
	messageId: string,
	now = Date.now()
): Promise<{
	allowed: boolean;
	sentToday: number;
	dailyCap: number;
	reserved: number;
	reservation?: WarmingReservation;
}> {
	const today = utcDateKey(now);
	const expiresAt = now + WARMING_RESERVATION_TTL_MS;
	const result = (await redis.eval(
		RESERVE_WARMING_SLOT_LUA,
		2,
		warmingStateKey(ip),
		warmingReservationsKey(ip, today),
		today,
		now,
		expiresAt,
		messageId
	)) as Array<number | string>;
	const allowed = Number(result[0]) === 1;
	// An IP that is not warming (or has graduated) is uncapped and reserves
	// nothing. Handing back a reservation object anyway would make `recordSend`
	// take the reserved branch, find no member to consume, and silently drop the
	// send from both `sentToday` and the daily stats.
	const uncapped = Number(result[2] ?? 0) === -1;
	return {
		allowed,
		sentToday: Number(result[1] ?? 0),
		dailyCap: uncapped ? Infinity : Number(result[2] ?? 0),
		reserved: Number(result[3] ?? 0),
		...(allowed && !uncapped ? { reservation: { ip, messageId, utcDate: today, expiresAt } } : {}),
	};
}

export async function isWarmingReservationValid(
	redis: Redis,
	reservation: WarmingReservation,
	now = Date.now()
): Promise<boolean> {
	if (reservation.expiresAt < now) return false;
	const today = reservation.utcDate;
	return (
		(await redis.zscore(warmingReservationsKey(reservation.ip, today), reservation.messageId)) !==
		null
	);
}

export async function releaseWarmingSlot(
	redis: Redis,
	reservation: WarmingReservation
): Promise<void> {
	await redis.zrem(
		warmingReservationsKey(reservation.ip, reservation.utcDate),
		reservation.messageId
	);
}

/** Revalidate a queued reservation against the actual UTC delivery day. */
export async function ensureWarmingReservation(
	redis: Redis,
	reservation: WarmingReservation,
	now = Date.now()
): Promise<{ allowed: boolean; reservation?: WarmingReservation }> {
	const today = utcDateKey(now);
	if (reservation.utcDate === today && (await isWarmingReservationValid(redis, reservation, now))) {
		return { allowed: true, reservation };
	}
	await releaseWarmingSlot(redis, reservation);
	const renewed = await reserveWarmingSlot(redis, reservation.ip, reservation.messageId, now);
	return renewed.allowed ? { allowed: true, reservation: renewed.reservation } : { allowed: false };
}

/**
 * Get the daily send cap for an IP based on its warming schedule
 * Returns Infinity if the IP has graduated (warming complete)
 */
export async function getDailyCap(redis: Redis, ip: string): Promise<number> {
	return normalizeNonGraduatedWarmingCap(redis, ip);
}

async function normalizeNonGraduatedWarmingCap(redis: Redis, ip: string): Promise<number> {
	const capRaw = await redis.eval(NORMALIZE_NON_GRADUATED_WARMING_CAP_LUA, 1, warmingStateKey(ip));
	return decodeNormalizedDailyCap(capRaw);
}

/**
 * Check if an IP has capacity to send (hasn't exceeded daily cap)
 */
export async function checkCap(
	redis: Redis,
	ip: string
): Promise<{
	allowed: boolean;
	sentToday: number;
	dailyCap: number;
}> {
	const today = utcDateKey();

	// Atomic day-rollover reset: read the stored reset date, the cap, and
	// (re)set the counter inside one Lua script so two concurrent workers at a
	// rolled-over date can't both observe the stale date and double-reset.
	const result = (await redis.eval(
		CHECK_WARMING_CAP_ROLLOVER_LUA,
		1,
		warmingStateKey(ip),
		today
	)) as [string, string];
	const sentToday = Number(result[0] ?? 0);
	const dailyCap = decodeNormalizedDailyCap(result[1]);

	return {
		allowed: sentToday < dailyCap,
		sentToday,
		dailyCap,
	};
}

/**
 * Record a successful send for warming tracking
 */
export async function recordSend(
	redis: Redis,
	ip: string,
	reservation?: WarmingReservation,
	idempotencyIdentity?: DurableEffectIdentity
): Promise<void> {
	const hashKey = warmingStateKey(ip);
	const today = utcDateKey();
	const statsKey = warmingDailyStatsKey(ip, today);
	if (reservation) {
		const recorded = Number(
			await redis.eval(
				RECORD_RESERVED_WARMING_SEND_LUA,
				4,
				hashKey,
				warmingReservationsKey(ip, reservation.utcDate),
				statsKey,
				warmingReservationReceiptKey(ip, reservation.messageId),
				reservation.messageId
			)
		);
		// -1: the reservation was not in today's set (already consumed by an
		// earlier replay, released, or rolled past its UTC day). The send is not
		// counted, which is correct for a replay but is a real accounting gap
		// otherwise — surface it rather than discarding it silently.
		if (recorded === -1) {
			logger.warn(
				{ ip, messageId: reservation.messageId, utcDate: reservation.utcDate },
				'Warming send had no live reservation to consume — not counted'
			);
		}
		return;
	}
	if (idempotencyIdentity) {
		await recordUnreservedWarmingSendOnce(redis, ip, today, idempotencyIdentity);
		return;
	}

	await redis.hincrby(hashKey, 'sentToday', 1);
	await redis.hincrby(statsKey, 'sent', 1);
	await redis.expire(statsKey, 172800); // 48h
}

/**
 * Record a bounce during warming
 */
export async function recordBounce(
	redis: Redis,
	ip: string,
	idempotencyIdentity?: DurableEffectIdentity
): Promise<void> {
	const today = utcDateKey();
	if (idempotencyIdentity) {
		await recordDailyWarmingOutcomeOnce(redis, ip, today, 'bounced', idempotencyIdentity);
		return;
	}
	await redis.hincrby(warmingDailyStatsKey(ip, today), 'bounced', 1);
}

/**
 * Record a deferral during warming
 */
export async function recordDeferral(
	redis: Redis,
	ip: string,
	idempotencyIdentity?: DurableEffectIdentity
): Promise<void> {
	const today = utcDateKey();
	if (idempotencyIdentity) {
		await recordDailyWarmingOutcomeOnce(redis, ip, today, 'deferred', idempotencyIdentity);
		return;
	}
	await redis.hincrby(warmingDailyStatsKey(ip, today), 'deferred', 1);
}

/**
 * Initialize warming for an IP (call when starting to use a new IP)
 */
export async function initializeWarming(redis: Redis, ip: string): Promise<void> {
	const hashKey = warmingStateKey(ip);
	const today = utcDateKey();

	const existing = await redis.hget(hashKey, 'startedAt');
	if (existing) return; // Already initialized

	const firstEntry = BASE_WARMING_SCHEDULE[0]!;

	await redis.hset(
		hashKey,
		'startedAt',
		String(Date.now()),
		'currentDay',
		'1',
		'dailyCap',
		String(firstEntry.cap),
		'sentToday',
		'0',
		'sentTodayReset',
		today,
		'lastEvaluatedDate',
		'',
		'bounceRate',
		'0',
		'deferralRate',
		'0',
		'phase',
		'ramp'
	);

	logger.info({ ip, dailyCap: firstEntry.cap }, 'IP warming initialized');
}

/**
 * Evaluate and adjust warming schedule based on today's performance.
 * Should be called at end of each day or periodically.
 */
export async function evaluateDay(redis: Redis, ip: string, config: MtaConfig): Promise<void> {
	const state = await getWarmingState(redis, ip);
	if (!state || state.phase === 'graduated') return;

	const today = utcDateKey();

	// Per-UTC-day idempotency guard. The cron calls evaluateDay hourly, but a
	// schedule advance must happen AT MOST once per UTC day — otherwise a clean
	// IP would graduate the entire BASE_WARMING_SCHEDULE in ~30 hours, defeating
	// the GRADUATION_MIN_DAYS=30 ramp. Once we've evaluated for `today`, bail.
	if (state.lastEvaluatedDate === today) return;

	const hashKey = warmingStateKey(ip);
	const dailyStats = await redis.hgetall(warmingDailyStatsKey(ip, today));

	const sent = parseInt(dailyStats['sent'] ?? '0', 10);
	const bounced = parseInt(dailyStats['bounced'] ?? '0', 10);
	const deferred = parseInt(dailyStats['deferred'] ?? '0', 10);

	if (sent === 0) return; // No sends today — leave the guard unset so a later
	// call the same day (after sends arrive) can still evaluate once.

	const bounceRate = bounced / sent;
	const deferralRate = deferred / sent;
	const enforcedCap = Number.isFinite(state.dailyCap) ? state.dailyCap : LAST_FINITE_WARMING_CAP;
	const usageRate = sent / enforcedCap;

	// Mark the day evaluated up front: every branch below performs exactly one
	// schedule adjustment, after which the hourly cron must not re-advance today.
	await redis.hset(hashKey, 'lastEvaluatedDate', today);

	// Re-shape the per-(IP x mailbox provider) caps under the SAME per-UTC-day
	// guard. This narrows or widens a provider's share of the per-IP cap; it
	// never changes the per-IP schedule the branches below advance.
	await evaluateProviderWarmingDay(redis, ip, today);

	// The four-way schedule adjustment and the graduation gate live in
	// `warmingScheduleAdjustment.ts`; both are unchanged from the shipped
	// cascade and run exactly once, under the guard armed above.
	const adjustment = await applyWarmingScheduleAdjustment(redis, ip, hashKey, config, {
		state,
		bounceRate,
		deferralRate,
		enforcedCap,
		usageRate,
	});
	// As shipped: a halt or a deceleration ends the day here; only an advance is
	// followed by the graduation check.
	if (adjustment !== 'advanced') return;
	await applyWarmingGraduation(
		redis,
		ip,
		hashKey,
		config,
		await getWarmingState(redis, ip),
		bounceRate
	);
}

/**
 * Get the current warming state for an IP
 */
export async function getWarmingState(redis: Redis, ip: string): Promise<WarmingState | null> {
	const entries = (await redis.eval(
		GET_NORMALIZED_WARMING_STATE_LUA,
		1,
		warmingStateKey(ip)
	)) as Array<number | string>;
	if (entries.length === 0) return null;
	const persistedFields: Record<string, string> = {};
	for (let index = 0; index < entries.length; index += 2) {
		persistedFields[String(entries[index])] = String(entries[index + 1]);
	}

	return {
		startedAt: parseInt(persistedFields['startedAt']!, 10),
		currentDay: decodeCanonicalPositiveSafeInteger(
			persistedFields['currentDay'],
			'warming currentDay'
		),
		dailyCap: decodeNormalizedDailyCap(persistedFields['dailyCap']),
		sentToday: parseInt(persistedFields['sentToday'] ?? '0', 10),
		sentTodayReset: persistedFields['sentTodayReset'] ?? '',
		lastEvaluatedDate: persistedFields['lastEvaluatedDate'] ?? '',
		bounceRate: parseFloat(persistedFields['bounceRate'] ?? '0'),
		deferralRate: parseFloat(persistedFields['deferralRate'] ?? '0'),
		phase: (persistedFields['phase'] as WarmingPhase) ?? 'ramp',
	};
}
