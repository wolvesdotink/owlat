/**
 * The schedule-adjustment cascade of `evaluateDay`, extracted verbatim.
 *
 * Splitting it out of `warming.ts` keeps that module readable (and inside the
 * repo's file-size ratchet) without changing a single branch: the thresholds,
 * the order they are tested in, the fields written and the log lines are
 * exactly the shipped ones. `evaluateDay` still owns the per-UTC-day
 * idempotency guard and calls this once, after the guard is armed.
 */

import type Redis from 'ioredis';
import { ADAPTIVE_WARMING_POLICY, getWarmingCapForDay } from '@owlat/shared/warming';
import type { MtaConfig } from '../config.js';
import type { WarmingState } from '../types.js';
import { logger } from '../monitoring/logger.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';

/** One UTC day's measured warming performance for an IP. */
export interface WarmingDayMeasurement {
	readonly state: WarmingState;
	readonly bounceRate: number;
	readonly deferralRate: number;
	/** The cap actually enforced today (the last finite cap when graduated). */
	readonly enforcedCap: number;
	readonly usageRate: number;
}

/**
 * Which branch of the cascade fired.
 *
 * The caller needs this because the shipped `evaluateDay` returned early from
 * the halt and deceleration branches, so ONLY an advance is ever followed by
 * the graduation check.
 */
export type WarmingScheduleAdjustment = 'halted' | 'decelerated' | 'advanced';

/**
 * Apply exactly one schedule adjustment: halt, decelerate, accelerate, or the
 * normal one-day advance.
 */
export async function applyWarmingScheduleAdjustment(
	redis: Redis,
	ip: string,
	hashKey: string,
	config: MtaConfig,
	measurement: WarmingDayMeasurement
): Promise<WarmingScheduleAdjustment> {
	const { state, bounceRate, deferralRate, enforcedCap, usageRate } = measurement;
	// CRITICAL HALT
	if (
		bounceRate > ADAPTIVE_WARMING_POLICY.halt.bounceRateExclusiveMin ||
		deferralRate > ADAPTIVE_WARMING_POLICY.halt.deferralRateExclusiveMin
	) {
		await redis.hset(
			hashKey,
			'phase',
			'plateau',
			'bounceRate',
			String(bounceRate),
			'deferralRate',
			String(deferralRate)
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
		return 'halted';
	}

	// DECELERATE
	if (
		bounceRate > ADAPTIVE_WARMING_POLICY.deceleration.bounceRateExclusiveMin ||
		deferralRate > ADAPTIVE_WARMING_POLICY.deceleration.deferralRateExclusiveMin
	) {
		const newDay = Math.max(
			1,
			state.currentDay * ADAPTIVE_WARMING_POLICY.deceleration.scheduleDayMultiplier
		);
		const newCap = Math.max(
			ADAPTIVE_WARMING_POLICY.deceleration.minimumCap,
			Math.floor(enforcedCap * ADAPTIVE_WARMING_POLICY.deceleration.capMultiplier)
		);

		await redis.hset(
			hashKey,
			'currentDay',
			String(Math.floor(newDay)),
			'dailyCap',
			String(newCap),
			'bounceRate',
			String(bounceRate),
			'deferralRate',
			String(deferralRate),
			'phase',
			'ramp'
		);

		logger.warn({ ip, bounceRate, deferralRate, newCap }, 'Warming decelerated');
		return 'decelerated';
	}

	// ACCELERATE (all conditions must be met)
	if (
		bounceRate < ADAPTIVE_WARMING_POLICY.acceleration.bounceRateExclusiveMax &&
		deferralRate < ADAPTIVE_WARMING_POLICY.acceleration.deferralRateExclusiveMax &&
		usageRate >= ADAPTIVE_WARMING_POLICY.acceleration.usageRateMinimum
	) {
		// Multiplication alone floors day 1 back to day 1 forever. A qualifying
		// day must always make at least the normal one-day progress.
		const newDay = Math.min(
			Math.max(
				state.currentDay + 1,
				Math.floor(state.currentDay * ADAPTIVE_WARMING_POLICY.acceleration.scheduleDayMultiplier)
			),
			ADAPTIVE_WARMING_POLICY.graduation.minimumScheduleDay + 1
		);
		const scheduledCap = getWarmingCapForDay(newDay);
		// Infinity is the graduated state, not merely the day-30 checkpoint.
		// Keep the last finite cap until the health gate below actually passes.
		const newCap = Number.isFinite(scheduledCap) ? scheduledCap : enforcedCap;

		await redis.hset(
			hashKey,
			'currentDay',
			String(newDay),
			'dailyCap',
			String(newCap),
			'bounceRate',
			String(bounceRate),
			'deferralRate',
			String(deferralRate)
		);

		logger.info({ ip, newDay, newCap }, 'Warming accelerated');
	} else {
		// NORMAL: advance by 1 day
		const newDay = state.currentDay + 1;
		const scheduledCap = getWarmingCapForDay(newDay);
		// A day-30 schedule position is still capped until graduation passes.
		const newCap = Number.isFinite(scheduledCap) ? scheduledCap : enforcedCap;

		await redis.hset(
			hashKey,
			'currentDay',
			String(newDay),
			'dailyCap',
			String(newCap),
			'bounceRate',
			String(bounceRate),
			'deferralRate',
			String(deferralRate)
		);
	}
	return 'advanced';
}

/**
 * Promote the IP to `graduated` once the schedule position and the health gate
 * both allow it. Unchanged from the shipped check.
 */
export async function applyWarmingGraduation(
	redis: Redis,
	ip: string,
	hashKey: string,
	config: MtaConfig,
	updatedState: WarmingState | null,
	bounceRate: number
): Promise<void> {
	if (
		updatedState &&
		updatedState.currentDay >= ADAPTIVE_WARMING_POLICY.graduation.minimumScheduleDay &&
		bounceRate < ADAPTIVE_WARMING_POLICY.graduation.bounceRateExclusiveMax &&
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
