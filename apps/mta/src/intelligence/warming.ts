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
import { getWarmingCapForDay } from '@owlat/shared/warming';
import type { MtaConfig } from '../config.js';
import type { WarmingPhase, WarmingState } from '../types.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';
import { logger } from '../monitoring/logger.js';

const WARMING_PREFIX = 'mta:warming:';
const DAILY_STATS_PREFIX = 'mta:warming:daily:';

/**
 * Atomically roll over the per-day send counter.
 *
 * KEYS[1] = warming hash key
 * ARGV[1] = today's UTC date (YYYY-MM-DD)
 *
 * Reads the stored reset date and the cap inside a single atomic script so
 * that two workers hitting a rolled-over day can't both observe the stale
 * date and double-reset `sentToday`. Returns the post-rollover `sentToday`
 * and `dailyCap` so the caller doesn't need a second non-atomic read.
 *
 * Returns: { sentToday, dailyCap }  (both as strings)
 */
const CHECK_CAP_ROLLOVER_LUA = `
local hashKey = KEYS[1]
local today = ARGV[1]

local reset = redis.call('HGET', hashKey, 'sentTodayReset')
local dailyCap = redis.call('HGET', hashKey, 'dailyCap') or '0'

if reset ~= today then
  redis.call('HSET', hashKey, 'sentToday', '0', 'sentTodayReset', today)
  return { '0', dailyCap }
end

local sentToday = redis.call('HGET', hashKey, 'sentToday') or '0'
return { sentToday, dailyCap }
`;

// Adaptive thresholds
const ACCELERATE_BOUNCE_MAX = 0.01; // <1% bounce rate to accelerate
const ACCELERATE_DEFER_MAX = 0.05; // <5% deferral rate to accelerate
const ACCELERATE_USAGE_MIN = 0.8; // Must use >80% of daily cap
const DECELERATE_BOUNCE_MIN = 0.03; // >3% bounce triggers slowdown
const DECELERATE_DEFER_MIN = 0.10; // >10% deferral triggers slowdown
const HALT_BOUNCE = 0.08; // >8% bounce halts warming
const HALT_DEFER = 0.25; // >25% deferral halts warming
const GRADUATION_MIN_DAYS = 30;
const GRADUATION_MAX_BOUNCE = 0.02; // <2% bounce to graduate

/**
 * Get the daily send cap for an IP based on its warming schedule
 * Returns Infinity if the IP has graduated (warming complete)
 */
export async function getDailyCap(redis: Redis, ip: string): Promise<number> {
	const state = await getWarmingState(redis, ip);
	if (!state) return Infinity; // No warming state = no limit
	if (state.phase === 'graduated') return Infinity;

	return state.dailyCap;
}

/**
 * Check if an IP has capacity to send (hasn't exceeded daily cap)
 */
export async function checkCap(redis: Redis, ip: string): Promise<{
	allowed: boolean;
	sentToday: number;
	dailyCap: number;
}> {
	const state = await getWarmingState(redis, ip);
	if (!state || state.phase === 'graduated') {
		return { allowed: true, sentToday: 0, dailyCap: Infinity };
	}

	const today = new Date().toISOString().split('T')[0]!;

	// Atomic day-rollover reset: read the stored reset date, the cap, and
	// (re)set the counter inside one Lua script so two concurrent workers at a
	// rolled-over date can't both observe the stale date and double-reset.
	const result = (await redis.eval(CHECK_CAP_ROLLOVER_LUA, 1, `${WARMING_PREFIX}${ip}`, today)) as [
		string,
		string,
	];
	const sentToday = parseInt(result[0] ?? '0', 10);
	const dailyCap = result[1] === 'Infinity' ? Infinity : parseInt(result[1] ?? '0', 10);

	return {
		allowed: sentToday < dailyCap,
		sentToday,
		dailyCap,
	};
}

/**
 * Record a successful send for warming tracking
 */
export async function recordSend(redis: Redis, ip: string): Promise<void> {
	const hashKey = `${WARMING_PREFIX}${ip}`;
	const today = new Date().toISOString().split('T')[0]!;

	await redis.hincrby(hashKey, 'sentToday', 1);
	await redis.hincrby(`${DAILY_STATS_PREFIX}${ip}:${today}`, 'sent', 1);
	await redis.expire(`${DAILY_STATS_PREFIX}${ip}:${today}`, 172800); // 48h
}

/**
 * Record a bounce during warming
 */
export async function recordBounce(redis: Redis, ip: string): Promise<void> {
	const today = new Date().toISOString().split('T')[0]!;
	await redis.hincrby(`${DAILY_STATS_PREFIX}${ip}:${today}`, 'bounced', 1);
}

/**
 * Record a deferral during warming
 */
export async function recordDeferral(redis: Redis, ip: string): Promise<void> {
	const today = new Date().toISOString().split('T')[0]!;
	await redis.hincrby(`${DAILY_STATS_PREFIX}${ip}:${today}`, 'deferred', 1);
}

/**
 * Initialize warming for an IP (call when starting to use a new IP)
 */
export async function initializeWarming(redis: Redis, ip: string): Promise<void> {
	const hashKey = `${WARMING_PREFIX}${ip}`;
	const today = new Date().toISOString().split('T')[0]!;

	const existing = await redis.hget(hashKey, 'startedAt');
	if (existing) return; // Already initialized

	const firstEntry = BASE_WARMING_SCHEDULE[0]!;

	await redis.hset(
		hashKey,
		'startedAt', String(Date.now()),
		'currentDay', '1',
		'dailyCap', String(firstEntry.cap),
		'sentToday', '0',
		'sentTodayReset', today,
		'lastEvaluatedDate', '',
		'bounceRate', '0',
		'deferralRate', '0',
		'phase', 'ramp'
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

	const today = new Date().toISOString().split('T')[0]!;

	// Per-UTC-day idempotency guard. The cron calls evaluateDay hourly, but a
	// schedule advance must happen AT MOST once per UTC day — otherwise a clean
	// IP would graduate the entire BASE_WARMING_SCHEDULE in ~30 hours, defeating
	// the GRADUATION_MIN_DAYS=30 ramp. Once we've evaluated for `today`, bail.
	if (state.lastEvaluatedDate === today) return;

	const hashKey = `${WARMING_PREFIX}${ip}`;
	const dailyStats = await redis.hgetall(`${DAILY_STATS_PREFIX}${ip}:${today}`);

	const sent = parseInt(dailyStats['sent'] ?? '0', 10);
	const bounced = parseInt(dailyStats['bounced'] ?? '0', 10);
	const deferred = parseInt(dailyStats['deferred'] ?? '0', 10);

	if (sent === 0) return; // No sends today — leave the guard unset so a later
	// call the same day (after sends arrive) can still evaluate once.

	const bounceRate = bounced / sent;
	const deferralRate = deferred / sent;
	const usageRate = sent / state.dailyCap;

	// Mark the day evaluated up front: every branch below performs exactly one
	// schedule adjustment, after which the hourly cron must not re-advance today.
	await redis.hset(hashKey, 'lastEvaluatedDate', today);

	// CRITICAL HALT
	if (bounceRate > HALT_BOUNCE || deferralRate > HALT_DEFER) {
		await redis.hset(
			hashKey,
			'phase', 'plateau',
			'bounceRate', String(bounceRate),
			'deferralRate', String(deferralRate)
		);

		logger.error({ ip, bounceRate, deferralRate }, 'Warming HALTED — critical thresholds exceeded');

		await notifyConvex(
			{
				event: 'ip.blocklisted',
				ip,
				severity: 'critical',
				message: `Warming halted: bounce rate ${(bounceRate * 100).toFixed(1)}%, deferral rate ${(deferralRate * 100).toFixed(1)}%`,
				timestamp: Date.now(),
			},
			config,
			redis
		).catch(() => {});
		return;
	}

	// DECELERATE
	if (bounceRate > DECELERATE_BOUNCE_MIN || deferralRate > DECELERATE_DEFER_MIN) {
		const newDay = Math.max(1, state.currentDay * 0.5);
		const newCap = Math.max(50, Math.floor(state.dailyCap * 0.7));

		await redis.hset(
			hashKey,
			'currentDay', String(Math.floor(newDay)),
			'dailyCap', String(newCap),
			'bounceRate', String(bounceRate),
			'deferralRate', String(deferralRate),
			'phase', 'ramp'
		);

		logger.warn({ ip, bounceRate, deferralRate, newCap }, 'Warming decelerated');
		return;
	}

	// ACCELERATE (all conditions must be met)
	if (bounceRate < ACCELERATE_BOUNCE_MAX && deferralRate < ACCELERATE_DEFER_MAX && usageRate >= ACCELERATE_USAGE_MIN) {
		const newDay = Math.min(state.currentDay * 1.5, GRADUATION_MIN_DAYS + 1);
		const newCap = getWarmingCapForDay(Math.floor(newDay));

		await redis.hset(
			hashKey,
			'currentDay', String(Math.floor(newDay)),
			'dailyCap', String(newCap),
			'bounceRate', String(bounceRate),
			'deferralRate', String(deferralRate)
		);

		logger.info({ ip, newDay: Math.floor(newDay), newCap }, 'Warming accelerated');
	} else {
		// NORMAL: advance by 1 day
		const newDay = state.currentDay + 1;
		const newCap = getWarmingCapForDay(newDay);

		await redis.hset(
			hashKey,
			'currentDay', String(newDay),
			'dailyCap', String(newCap),
			'bounceRate', String(bounceRate),
			'deferralRate', String(deferralRate)
		);
	}

	// CHECK GRADUATION
	const updatedState = await getWarmingState(redis, ip);
	if (
		updatedState &&
		updatedState.currentDay >= GRADUATION_MIN_DAYS &&
		bounceRate < GRADUATION_MAX_BOUNCE &&
		updatedState.phase !== 'plateau'
	) {
		await redis.hset(hashKey, 'phase', 'graduated', 'dailyCap', String(Infinity));
		logger.info({ ip, actualDays: updatedState.currentDay }, 'IP GRADUATED — warming complete');

		await notifyConvex(
			{
				event: 'ip.warming_complete',
				ip,
				severity: 'info',
				message: `IP ${ip} warming complete after ${updatedState.currentDay} days`,
				timestamp: Date.now(),
			},
			config,
			redis
		).catch(() => {});
	}
}

/**
 * Get the current warming state for an IP
 */
export async function getWarmingState(redis: Redis, ip: string): Promise<WarmingState | null> {
	const hashKey = `${WARMING_PREFIX}${ip}`;
	const data = await redis.hgetall(hashKey);
	if (!data['startedAt']) return null;

	return {
		startedAt: parseInt(data['startedAt'], 10),
		currentDay: parseInt(data['currentDay'] ?? '1', 10),
		dailyCap: data['dailyCap'] === 'Infinity' ? Infinity : parseInt(data['dailyCap'] ?? '50', 10),
		sentToday: parseInt(data['sentToday'] ?? '0', 10),
		sentTodayReset: data['sentTodayReset'] ?? '',
		lastEvaluatedDate: data['lastEvaluatedDate'] ?? '',
		bounceRate: parseFloat(data['bounceRate'] ?? '0'),
		deferralRate: parseFloat(data['deferralRate'] ?? '0'),
		phase: (data['phase'] as WarmingPhase) ?? 'ramp',
	};
}
