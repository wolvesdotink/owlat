/**
 * Per-Campaign Complaint-Rate Tracker
 *
 * The org-level circuit breaker (`circuitBreaker.ts`) computes a complaint rate
 * but only per-ORG. A complaint whose signed Message-ID resolves to persisted
 * outbound campaign provenance also needs a campaign-level window independent
 * of that org rollup. This tracker closes that gap:
 *
 * - `recordDelivery` bumps the per-campaign delivered counter (the denominator).
 * - `recordComplaint` bumps the per-campaign complaint counter (numerator) and
 *   returns the current rate plus whether it has just crossed the alert
 *   threshold for the first time. Crossing emits a `campaign.complaint_rate`
 *   alert exactly once per window (a SET NX latch) so a noisy campaign doesn't
 *   spam the alert channel.
 *
 * Threshold: 0.3% — Gmail's 2024 Postmaster spam-rate guidance (keep below
 * 0.3%, never exceed 0.3%). This is intentionally above the org breaker's 0.2%
 * trip line: the breaker pauses sending for the whole org, whereas this is a
 * per-campaign observability alert, so it fires at the published ceiling.
 */

import { createHash } from 'crypto';
import type Redis from 'ioredis';
import type { DurableEffectIdentity } from '../lib/effectCheckpoint.js';

const PREFIX = 'mta:campaign-complaints:';
const ALERTED_SUFFIX = ':alerted';

/** Gmail 2024: keep spam complaint rate below 0.3%. */
export const CAMPAIGN_COMPLAINT_THRESHOLD = 0.003;

/**
 * Minimum deliveries before the rate is meaningful. A single complaint against
 * a handful of sends is 100% — require a floor so we don't alert on noise.
 */
export const CAMPAIGN_MIN_DELIVERIES = 100;

/** 30-day TTL — matches the delivery-metrics retention window. */
const TTL_SECONDS = 30 * 86400;
/** Individual replay receipts outlive both the seven-day parent and 30-day window. */
export const CAMPAIGN_EFFECT_RECEIPT_TTL_SECONDS = 35 * 86400;

const RECORD_COMPLAINT_ONCE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  local previous = redis.call('HMGET', KEYS[2], 'crossing', 'complaints', 'delivered', 'recordedAt')
  return {previous[2], previous[3], previous[1], previous[4]}
end
local complaints = redis.call('HINCRBY', KEYS[1], 'complaints', 1)
local delivered = tonumber(redis.call('HGET', KEYS[1], 'delivered') or '0')
local crossing = 'recorded'
if ARGV[4] == '1' then redis.call('HSET', KEYS[1], 'alerted', '1') end
if delivered >= tonumber(ARGV[2]) and complaints / math.max(delivered, 1) > tonumber(ARGV[3]) then
  if redis.call('HSETNX', KEYS[1], 'alerted', '1') == 1 then crossing = 'crossed' end
end
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'crossing', crossing, 'complaints', complaints, 'delivered', delivered, 'recordedAt', ARGV[6])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return {tostring(complaints), tostring(delivered), crossing, ARGV[6]}
`;

const RECORD_DELIVERY_ONCE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HINCRBY', KEYS[1], 'delivered', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], 'recorded', 'EX', ARGV[3])
return 1
`;

/**
 * Convex document-id shape: lowercase base32-ish alphanumeric, ~32 chars. We
 * accept a generous 16–64 range so a doc-id format bump never silently drops a
 * legitimate id, while still rejecting anything that isn't a plausible id.
 *
 * This is a defense-in-depth SECURITY bound, not just a sanity check. The live
 * complaint path accepts campaign attribution only from the exact
 * server-persisted outbound record resolved through a signed VERP Message-ID;
 * it never trusts a re-attached ARF `Feedback-ID`. The value still becomes a
 * Prometheus label and Redis key, so the shared outbound parser rejects corrupt
 * or future malformed persisted state before it reaches either sink.
 */
const CAMPAIGN_ID_PATTERN = /^[a-z0-9]{16,64}$/;

export interface CampaignComplaintResult {
	complaints: number;
	delivered: number;
	/** Fraction 0..1 (complaints / max(delivered, 1)). */
	rate: number;
	/** True only on the transition that first crosses the threshold. */
	thresholdCrossed: boolean;
	/** Stable first-commit time carried into downstream idempotent alerts. */
	recordedAt: number;
}

function countsKey(campaignId: string): string {
	return `${PREFIX}{${campaignSlot(campaignId)}}:counts`;
}

function alertedKey(campaignId: string): string {
	return `${PREFIX}${campaignId}${ALERTED_SUFFIX}`;
}

function campaignSlot(campaignId: string): string {
	return createHash('sha256').update(campaignId).digest('hex');
}

function effectReceiptKey(campaignId: string, identity: DurableEffectIdentity): string {
	const identityDigest = createHash('sha256').update(identity).digest('hex');
	return `${PREFIX}{${campaignSlot(campaignId)}}:effect:${identityDigest}`;
}

/**
 * Record a delivery for a campaign (the rate denominator). Idempotency /
 * dedup is the caller's concern — this is a raw counter bump.
 */
export async function recordDelivery(
	redis: Redis,
	campaignId: string,
	count = 1,
	idempotencyIdentity?: DurableEffectIdentity
): Promise<void> {
	const key = countsKey(campaignId);
	if (idempotencyIdentity) {
		await redis.eval(
			RECORD_DELIVERY_ONCE_LUA,
			2,
			key,
			effectReceiptKey(campaignId, idempotencyIdentity),
			String(count),
			String(TTL_SECONDS),
			String(CAMPAIGN_EFFECT_RECEIPT_TTL_SECONDS)
		);
		return;
	}
	await redis.hincrby(key, 'delivered', count);
	await redis.expire(key, TTL_SECONDS);
}

/**
 * Record a complaint for a campaign and re-evaluate the rate.
 *
 * Returns the post-increment complaint/delivered counts, the rate, and whether
 * this complaint is the one that first pushed the campaign over the threshold
 * (so the caller can emit the alert exactly once per window).
 */
export async function recordComplaint(
	redis: Redis,
	campaignId: string,
	idempotencyIdentity?: DurableEffectIdentity
): Promise<CampaignComplaintResult> {
	const key = countsKey(campaignId);
	let complaints: number;
	let delivered: number;
	let recordedAt = Date.now();
	if (idempotencyIdentity) {
		const legacyAlerted = await redis.exists(alertedKey(campaignId));
		const counts = (await redis.eval(
			RECORD_COMPLAINT_ONCE_LUA,
			2,
			key,
			effectReceiptKey(campaignId, idempotencyIdentity),
			String(TTL_SECONDS),
			String(CAMPAIGN_MIN_DELIVERIES),
			String(CAMPAIGN_COMPLAINT_THRESHOLD),
			String(legacyAlerted),
			String(CAMPAIGN_EFFECT_RECEIPT_TTL_SECONDS),
			String(recordedAt)
		)) as [string, string, 'crossed' | 'recorded', string];
		complaints = Number(counts[0]);
		delivered = Number(counts[1]);
		recordedAt = Number(counts[3]);
		return {
			complaints,
			delivered,
			rate: complaints / Math.max(delivered, 1),
			thresholdCrossed: counts[2] === 'crossed',
			recordedAt,
		};
	} else {
		// Compatibility for callers that do not yet own a durable effect identity.
		complaints = await redis.hincrby(key, 'complaints', 1);
		await redis.expire(key, TTL_SECONDS);
		const deliveredRaw = await redis.hget(key, 'delivered');
		delivered = deliveredRaw ? parseInt(deliveredRaw, 10) : 0;
	}

	const rate = complaints / Math.max(delivered, 1);

	let thresholdCrossed = false;
	if (delivered >= CAMPAIGN_MIN_DELIVERIES && rate > CAMPAIGN_COMPLAINT_THRESHOLD) {
		// SET NX latch — only the transition into the alerted state returns true.
		const latch = await redis.set(alertedKey(campaignId), '1', 'EX', TTL_SECONDS, 'NX');
		thresholdCrossed = latch !== null;
	}

	return { complaints, delivered, rate, thresholdCrossed, recordedAt };
}

/**
 * Parse the campaignId out of the outbound Gmail FBL `Feedback-ID` header VALUE
 * (not the whole header line). The delivery path persists this parsed value as
 * trusted delayed-feedback provenance; the inbound ARF parser never reads the
 * re-attached header as attribution.
 *
 * Header value shape (see delivery/sendComposition/feedbackId.ts):
 *   <streamType>:<campaignId>:<audienceType>:<senderId>
 *
 * Returns the campaignId only for the `campaign` stream and only when it is a
 * real, well-formed id — not the `none` EMPTY_FIELD placeholder used for
 * transactional / automation sends. Anything that is not a plausible Convex
 * document id (see CAMPAIGN_ID_PATTERN) is rejected before persisted provenance
 * can later supply a Prometheus label or Redis key. Returns undefined otherwise.
 */
export function parseCampaignFromFeedbackId(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const fields = trimmed.split(':');
	// Require the full four-segment shape so we don't misread an arbitrary value.
	if (fields.length !== 4) return undefined;

	const [streamType, campaignField] = fields;
	if (streamType !== 'campaign') return undefined;

	const campaignId = campaignField?.trim();
	if (!campaignId || campaignId === 'none') return undefined;
	// Bound the value's shape BEFORE it can become an unbounded metric label /
	// Redis key — forged ARFs must not be able to inflate Prometheus cardinality.
	if (!CAMPAIGN_ID_PATTERN.test(campaignId)) return undefined;
	return campaignId;
}

/** Read the current per-campaign complaint stats (for monitoring / tests). */
export async function getStats(
	redis: Redis,
	campaignId: string
): Promise<{ complaints: number; delivered: number; rate: number }> {
	const data = await redis.hgetall(countsKey(campaignId));
	const complaints = data['complaints'] ? parseInt(data['complaints'], 10) : 0;
	const delivered = data['delivered'] ? parseInt(data['delivered'], 10) : 0;
	return { complaints, delivered, rate: complaints / Math.max(delivered, 1) };
}
