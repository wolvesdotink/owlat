/**
 * Redis surface for the per-(IP x mailbox provider) warming dimension.
 *
 * The per-IP daily cap stays authoritative and untouched; this module narrows
 * it for one mailbox provider at a time, records that provider's own outcomes,
 * and tracks the recent volume-pressure verdicts that lengthen retry backoff.
 *
 * It also owns the BULK-pool daily counter intraday pacing needs, because that
 * counter is bumped by the same atomic send-recording script.
 *
 * Every decision lives in `warmingProviderPolicy.ts` (pure); this module only
 * loads, calls, and writes.
 */

import type Redis from 'ioredis';
import {
	DURABLE_EFFECT_IDEMPOTENCY_TTL_MS,
	type DurableEffectIdentity,
} from '../lib/effectCheckpoint.js';
import { DESTINATION_PROVIDER_KEYS } from '../config/ispProfiles.js';
import { logger } from '../monitoring/logger.js';
import type { DestinationProviderKey, IpPoolType } from '../types.js';
import {
	warmingBulkDailyKey,
	warmingProviderDailyStatsKey,
	warmingProviderPressureKey,
	warmingProviderReceiptKey,
	warmingProviderStateKey,
} from './warmingKeys.js';
import {
	effectiveProviderCap,
	nextProviderCapMultiplier,
	normalizeCapMultiplier,
	sanitizeCount,
	type ProviderCapDecision,
} from './warmingProviderPolicy.js';
import {
	BULK_DAILY_TTL_SECONDS,
	PROVIDER_DAILY_STATS_TTL_SECONDS,
	PROVIDER_STATE_TTL_SECONDS,
	READ_PROVIDER_WARMING_STATE_LUA,
	RECORD_PROVIDER_PRESSURE_IDEMPOTENT_LUA,
	RECORD_PROVIDER_PRESSURE_LUA,
	RECORD_PROVIDER_WARMING_OUTCOME_IDEMPOTENT_LUA,
	RECORD_PROVIDER_WARMING_OUTCOME_LUA,
	RECORD_PROVIDER_WARMING_SEND_IDEMPOTENT_LUA,
	RECORD_PROVIDER_WARMING_SEND_LUA,
	WRITE_PROVIDER_CAP_MULTIPLIER_LUA,
} from './warmingProviderScripts.js';
import { WARMING_PROVIDER_STATE_CODEC_VERSION } from './warmingStateCodec.js';

const CODEC_VERSION = String(WARMING_PROVIDER_STATE_CODEC_VERSION);
const STATE_TTL = String(PROVIDER_STATE_TTL_SECONDS);
const STATS_TTL = String(PROVIDER_DAILY_STATS_TTL_SECONDS);
const RECEIPT_TTL = String(DURABLE_EFFECT_IDEMPOTENCY_TTL_MS);
const BULK_TTL = String(BULK_DAILY_TTL_SECONDS);

/**
 * The (IP, provider, UTC day) triple every call in this module is scoped by.
 *
 * Passed as one value rather than three positional arguments: the three always
 * travel together, and two of them are strings that are trivially swappable at
 * a call site.
 */
export interface ProviderWarmingRef {
	readonly ip: string;
	readonly provider: DestinationProviderKey;
	readonly utcDate: string;
}

export interface ProviderCapCheck {
	readonly allowed: boolean;
	readonly sentToday: number;
	readonly capMultiplier: number;
	/** The narrowed cap actually enforced for this provider. */
	readonly providerCap: number;
}

/**
 * Check the provider dimension against the authoritative per-IP daily cap.
 *
 * An IP with no provider state (every IP before this change, and every provider
 * that has never shown pressure) resolves to the full per-IP cap, so the shipped
 * behaviour is the degenerate case. Reading NEVER creates a key.
 */
export async function checkProviderCap(
	redis: Redis,
	ref: ProviderWarmingRef,
	dailyCap: number
): Promise<ProviderCapCheck> {
	const raw = (await redis.eval(
		READ_PROVIDER_WARMING_STATE_LUA,
		1,
		warmingProviderStateKey(ref.ip, ref.provider),
		ref.utcDate,
		CODEC_VERSION,
		STATE_TTL
	)) as Array<string | number> | null;
	const sentToday = sanitizeCount(raw?.[0]);
	const capMultiplier = normalizeCapMultiplier(raw?.[1]);
	const providerCap = effectiveProviderCap(dailyCap, capMultiplier);
	return { allowed: sentToday < providerCap, sentToday, capMultiplier, providerCap };
}

/**
 * Count one delivered send against the provider dimension, and — when the send
 * belongs to the bulk pool — against the day's bulk pacing counter.
 */
export async function recordProviderWarmingSend(
	redis: Redis,
	ref: ProviderWarmingRef,
	pool: IpPoolType,
	identity?: DurableEffectIdentity
): Promise<void> {
	const stateKey = warmingProviderStateKey(ref.ip, ref.provider);
	const statsKey = warmingProviderDailyStatsKey(ref.ip, ref.provider, ref.utcDate);
	const bulkKey = warmingBulkDailyKey(ref.ip, ref.utcDate);
	const countsBulk = pool === 'campaign' ? '1' : '0';
	if (identity) {
		await redis.eval(
			RECORD_PROVIDER_WARMING_SEND_IDEMPOTENT_LUA,
			4,
			stateKey,
			statsKey,
			bulkKey,
			warmingProviderReceiptKey(ref.ip, ref.provider, identity),
			ref.utcDate,
			CODEC_VERSION,
			STATE_TTL,
			STATS_TTL,
			countsBulk,
			BULK_TTL,
			RECEIPT_TTL
		);
		return;
	}
	await redis.eval(
		RECORD_PROVIDER_WARMING_SEND_LUA,
		3,
		stateKey,
		statsKey,
		bulkKey,
		ref.utcDate,
		CODEC_VERSION,
		STATE_TTL,
		STATS_TTL,
		countsBulk,
		BULK_TTL
	);
}

/** Bulk-pool sends recorded for this IP today — intraday pacing's denominator. */
export async function readBulkSentToday(
	redis: Redis,
	ip: string,
	utcDate: string
): Promise<number> {
	return sanitizeCount(await redis.get(warmingBulkDailyKey(ip, utcDate)));
}

/** Count one bounce or deferral against the provider dimension. */
export async function recordProviderWarmingOutcome(
	redis: Redis,
	ref: ProviderWarmingRef,
	field: 'bounced' | 'deferred',
	identity?: DurableEffectIdentity
): Promise<void> {
	const statsKey = warmingProviderDailyStatsKey(ref.ip, ref.provider, ref.utcDate);
	if (identity) {
		await redis.eval(
			RECORD_PROVIDER_WARMING_OUTCOME_IDEMPOTENT_LUA,
			2,
			statsKey,
			warmingProviderReceiptKey(ref.ip, ref.provider, identity),
			field,
			STATS_TTL,
			RECEIPT_TTL
		);
		return;
	}
	await redis.eval(RECORD_PROVIDER_WARMING_OUTCOME_LUA, 1, statsKey, field, STATS_TTL);
}

/**
 * Record one volume-pressure verdict from the SMTP classifier and return the
 * recent pressure count for this (IP x provider).
 */
export async function recordProviderVolumePressure(
	redis: Redis,
	ref: ProviderWarmingRef,
	pressureTtlSeconds: number,
	identity?: DurableEffectIdentity
): Promise<number> {
	const pressureKey = warmingProviderPressureKey(ref.ip, ref.provider);
	const statsKey = warmingProviderDailyStatsKey(ref.ip, ref.provider, ref.utcDate);
	const pressureTtl = String(pressureTtlSeconds);
	const pressure = identity
		? await redis.eval(
				RECORD_PROVIDER_PRESSURE_IDEMPOTENT_LUA,
				3,
				pressureKey,
				statsKey,
				warmingProviderReceiptKey(ref.ip, ref.provider, identity),
				pressureTtl,
				STATS_TTL,
				RECEIPT_TTL
			)
		: await redis.eval(
				RECORD_PROVIDER_PRESSURE_LUA,
				2,
				pressureKey,
				statsKey,
				pressureTtl,
				STATS_TTL
			);
	return sanitizeCount(pressure);
}

/** Recent volume-pressure count used to lengthen this attempt's retry backoff. */
export async function readProviderVolumePressure(
	redis: Redis,
	ip: string,
	provider: DestinationProviderKey
): Promise<number> {
	return sanitizeCount(await redis.get(warmingProviderPressureKey(ip, provider)));
}

export interface ProviderDayEvaluation {
	readonly provider: DestinationProviderKey;
	readonly decision: ProviderCapDecision;
}

/** One `hmget` reply out of a pipeline, defensively narrowed. */
function pipelineValues(entry: [Error | null, unknown] | undefined): Array<string | null> {
	const value = entry?.[1];
	return Array.isArray(value) ? (value as Array<string | null>) : [];
}

/**
 * Re-evaluate every provider dimension for one IP.
 *
 * Called from `evaluateDay` AFTER the shipped per-UTC-day idempotency guard has
 * been armed, so the provider caps advance at most once per UTC day exactly like
 * the per-IP schedule does. The whole day is read in ONE round trip, and nothing
 * is written unless a decision actually moves.
 */
export async function evaluateProviderWarmingDay(
	redis: Redis,
	ip: string,
	utcDate: string
): Promise<ProviderDayEvaluation[]> {
	const providers = DESTINATION_PROVIDER_KEYS;
	// ONE round trip for the whole IP. The previous shape did `hgetall` plus a
	// `hget` per provider — ten calls per IP per day — and neither read needs to
	// be atomic with the other: the day is already frozen by the per-UTC-day
	// guard this runs under. Reading through a pipeline also creates no keys, so
	// a provider that never sent stays absent from Redis.
	const pipeline = redis.pipeline();
	for (const provider of providers) {
		pipeline.hmget(
			warmingProviderDailyStatsKey(ip, provider, utcDate),
			'sent',
			'bounced',
			'deferred',
			'pressure'
		);
		pipeline.hmget(warmingProviderStateKey(ip, provider), 'capMultiplier', 'cleanStreak');
	}
	const results = (await pipeline.exec()) ?? [];

	const evaluations: ProviderDayEvaluation[] = [];
	for (const [index, provider] of providers.entries()) {
		const stats = pipelineValues(results[index * 2]);
		const state = pipelineValues(results[index * 2 + 1]);
		const sent = sanitizeCount(stats[0]);
		// A provider with no traffic today has no window to judge; skipping it is
		// also what keeps the evaluation from creating a key for it.
		if (sent === 0) continue;
		const currentMultiplier = normalizeCapMultiplier(state[0]);
		const currentStreak = sanitizeCount(state[1]);
		const decision = nextProviderCapMultiplier(
			currentMultiplier,
			{
				sent,
				bounced: sanitizeCount(stats[1]),
				deferred: sanitizeCount(stats[2]),
				pressureEventsToday: sanitizeCount(stats[3]),
			},
			currentStreak
		);
		if (decision.capMultiplier !== currentMultiplier || decision.cleanStreak !== currentStreak) {
			await redis.eval(
				WRITE_PROVIDER_CAP_MULTIPLIER_LUA,
				1,
				warmingProviderStateKey(ip, provider),
				String(decision.capMultiplier),
				utcDate,
				CODEC_VERSION,
				STATE_TTL,
				String(decision.cleanStreak)
			);
			logger.info(
				{
					ip,
					provider,
					verdict: decision.verdict,
					capMultiplier: decision.capMultiplier,
					cleanStreak: decision.cleanStreak,
				},
				'Per-provider warming cap re-evaluated'
			);
		}
		evaluations.push({ provider, decision });
	}
	return evaluations;
}
