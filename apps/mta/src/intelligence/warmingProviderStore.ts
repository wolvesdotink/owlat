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
	PROVIDER_DAILY_STATS_TTL_SECONDS,
	PROVIDER_STATE_TTL_SECONDS,
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

/** The provider-state fields the cap gate reads, in reply order. */
const STATE_FIELDS = ['sentToday', 'sentTodayReset', 'capMultiplier'] as const;

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

/** Everything the warming-cap phase reads beyond the authoritative per-IP gate. */
export interface WarmingCapGateInputs {
	readonly ref: ProviderWarmingRef;
	/** Raw `STATE_FIELDS` reply; narrowed by the pure `providerCapVerdict`. */
	readonly providerState: ReadonlyArray<string | null>;
	/** Bulk-pool sends recorded for this IP today — intraday pacing's numerator. */
	readonly bulkSentToday: number;
	/** Recent volume-pressure count that lengthens this attempt's retry backoff. */
	readonly volumePressure: number;
}

/** What a failed advisory read degrades to: exactly the shipped behaviour. */
function shippedGateDefaults(ref: ProviderWarmingRef): WarmingCapGateInputs {
	return { ref, providerState: [], bulkSentToday: 0, volumePressure: 0 };
}

/**
 * Read gates 2 and 3 and the retry-backoff signal in ONE round trip.
 *
 * All three keys live under the same `{warming:<ip>}` hash tag, so they are one
 * Redis Cluster slot; issuing them sequentially cost the hot dispatch path three
 * round trips just to build inputs for three PURE functions. They do not need to
 * be atomic with each other — each is an advisory counter, and the per-IP cap
 * above them is the authoritative gate — so this is a plain `Promise.all`, which
 * ioredis auto-pipelines into a single write to the socket, rather than an
 * explicit `pipeline()` object.
 *
 * ADVISORY MEANS ADVISORY: a Redis failure here must never withhold an attempt
 * the authoritative per-IP gate would have allowed, so the whole read degrades
 * to the shipped defaults. `providerCapVerdict` resolves an empty state to the
 * full per-IP cap and `evaluateIntradayPacing` fails open on a zero counter, so
 * the degraded path IS shipped behaviour.
 *
 * The per-IP daily cap is NOT an input here: it is only known after the shipped
 * gate 1 has run, and keeping it out lets this read be issued CONCURRENTLY with
 * gate 1. Applying it is `providerCapVerdict`, which is pure.
 */
export async function readWarmingCapGateInputs(
	redis: Redis,
	ref: ProviderWarmingRef
): Promise<WarmingCapGateInputs> {
	try {
		const [providerState, bulkSentToday, volumePressure] = await Promise.all([
			redis.hmget(warmingProviderStateKey(ref.ip, ref.provider), ...STATE_FIELDS),
			redis.get(warmingBulkDailyKey(ref.ip, ref.utcDate)),
			redis.get(warmingProviderPressureKey(ref.ip, ref.provider)),
		]);
		return {
			ref,
			providerState,
			bulkSentToday: sanitizeCount(bulkSentToday),
			volumePressure: sanitizeCount(volumePressure),
		};
	} catch (err) {
		logger.debug({ err, ip: ref.ip, provider: ref.provider }, 'Warming advisory read failed');
		return shippedGateDefaults(ref);
	}
}

/**
 * PURE. Narrow a raw provider-state read against the per-IP daily cap.
 *
 * A `sentTodayReset` that is not the reference day means the persisted counter
 * belongs to a finished day and reads as zero, which is why neither read path
 * has to write to roll the day.
 */
export function providerCapVerdict(
	inputs: Pick<WarmingCapGateInputs, 'providerState' | 'ref'>,
	dailyCap: number
): ProviderCapCheck {
	const state = inputs.providerState;
	const sentToday = state[1] === inputs.ref.utcDate ? sanitizeCount(state[0]) : 0;
	const capMultiplier = normalizeCapMultiplier(state[2]);
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
			STATS_TTL,
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
		STATS_TTL
	);
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
	retryPressureWindowTtlSeconds: number,
	identity?: DurableEffectIdentity
): Promise<number> {
	const pressureKey = warmingProviderPressureKey(ref.ip, ref.provider);
	const statsKey = warmingProviderDailyStatsKey(ref.ip, ref.provider, ref.utcDate);
	const pressureTtl = String(retryPressureWindowTtlSeconds);
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

/**
 * Recent volume-pressure count used to lengthen this attempt's retry backoff.
 *
 * The narrow read for the path that needs ONLY this signal: an attempt holding a
 * live warming reservation owns its slot and skips gates 2 and 3 by design, so
 * reading their inputs would be two wasted keys and two extra chances to fail on
 * the one path the phase promises capacity to. Degrades to `0` (no pressure, no
 * lengthening) for the same reason `readWarmingCapGateInputs` does.
 */
export async function readProviderVolumePressure(
	redis: Redis,
	ip: string,
	provider: DestinationProviderKey
): Promise<number> {
	try {
		return sanitizeCount(await redis.get(warmingProviderPressureKey(ip, provider)));
	} catch (err) {
		logger.debug({ err, ip, provider }, 'Warming pressure read failed');
		return 0;
	}
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
