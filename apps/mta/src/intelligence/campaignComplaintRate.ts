/**
 * Per-Campaign Complaint-Rate Tracker
 *
 * The org-level circuit breaker (`circuitBreaker.ts`) computes a complaint rate
 * but only per-ORG, and only for complaints whose ARF carried an extractable
 * `organizationId`. A complaint that carried a `Feedback-ID` campaignId but no
 * org id (or whose org just isn't the right rollup) never entered any rate
 * window. This tracker closes that gap with a per-campaign window:
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
const COUNTS_SUFFIX = ':counts';
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

const RECORD_COMPLAINT_ONCE_LUA = `
local previous = redis.call('HGET', KEYS[1], ARGV[1])
if previous then
  local counts = redis.call('HMGET', KEYS[1], 'complaints', 'delivered')
  return {counts[1] or '0', counts[2] or '0', previous}
end
if ARGV[5] == '1' then redis.call('HSET', KEYS[1], 'alerted', '1') end
local complaints = redis.call('HINCRBY', KEYS[1], 'complaints', 1)
local delivered = tonumber(redis.call('HGET', KEYS[1], 'delivered') or '0')
local crossing = 'recorded'
if delivered >= tonumber(ARGV[3]) and complaints / math.max(delivered, 1) > tonumber(ARGV[4]) then
  if redis.call('HSETNX', KEYS[1], 'alerted', '1') == 1 then crossing = 'crossed' end
end
redis.call('HSET', KEYS[1], ARGV[1], crossing)
redis.call('EXPIRE', KEYS[1], ARGV[2])
local counts = redis.call('HMGET', KEYS[1], 'complaints', 'delivered')
return {counts[1] or '0', counts[2] or '0', crossing}
`;

/**
 * Convex document-id shape: lowercase base32-ish alphanumeric, ~32 chars. We
 * accept a generous 16–64 range so a doc-id format bump never silently drops a
 * legitimate id, while still rejecting anything that isn't a plausible id.
 *
 * This is a SECURITY bound, not just a sanity check: the campaignId is scraped
 * from internet-inbound ARF `Feedback-ID` headers (see fblProcessor.ts) and
 * becomes the `campaign` label on the `mta_fbl_complaints_by_campaign_total`
 * Prometheus counter as well as a Redis key. prom-client never evicts label
 * series, so a forged ARF carrying a random/oversized field-2 would otherwise
 * create an unbounded number of permanently-retained time series → memory
 * exhaustion. Rejecting non-id-shaped values keeps per-value cardinality the
 * same bounded posture as the fixed-enum `isp` label.
 */
const CAMPAIGN_ID_PATTERN = /^[a-z0-9]{16,64}$/;

export interface CampaignComplaintResult {
	complaints: number;
	delivered: number;
	/** Fraction 0..1 (complaints / max(delivered, 1)). */
	rate: number;
	/** True only on the transition that first crosses the threshold. */
	thresholdCrossed: boolean;
}

function countsKey(campaignId: string): string {
	return `${PREFIX}${campaignId}${COUNTS_SUFFIX}`;
}

function alertedKey(campaignId: string): string {
	return `${PREFIX}${campaignId}${ALERTED_SUFFIX}`;
}

/**
 * Record a delivery for a campaign (the rate denominator). Idempotency /
 * dedup is the caller's concern — this is a raw counter bump.
 */
export async function recordDelivery(redis: Redis, campaignId: string, count = 1): Promise<void> {
	const key = countsKey(campaignId);
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
	if (idempotencyIdentity) {
		const identityField = `effect:${createHash('sha256')
			.update(idempotencyIdentity)
			.digest('hex')}`;
		const legacyAlerted = await redis.exists(alertedKey(campaignId));
		const counts = (await redis.eval(
			RECORD_COMPLAINT_ONCE_LUA,
			1,
			key,
			identityField,
			String(TTL_SECONDS),
			String(CAMPAIGN_MIN_DELIVERIES),
			String(CAMPAIGN_COMPLAINT_THRESHOLD),
			String(legacyAlerted)
		)) as [string, string, 'crossed' | 'recorded'];
		complaints = Number(counts[0]);
		delivered = Number(counts[1]);
		return {
			complaints,
			delivered,
			rate: complaints / Math.max(delivered, 1),
			thresholdCrossed: counts[2] === 'crossed',
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

	return { complaints, delivered, rate, thresholdCrossed };
}

/**
 * Parse the campaignId out of a Gmail FBL `Feedback-ID` header VALUE (not the
 * whole header line). Shared by the outbound delivery path (which has the value
 * straight off the job headers) and the inbound bounce path (which scrapes it
 * out of the embedded original message).
 *
 * Header value shape (see delivery/sendComposition/feedbackId.ts):
 *   <streamType>:<campaignId>:<audienceType>:<senderId>
 *
 * Returns the campaignId only for the `campaign` stream and only when it is a
 * real, well-formed id — not the `none` EMPTY_FIELD placeholder used for
 * transactional / automation sends, and not an arbitrary attacker-supplied
 * value (the header is scraped from internet-inbound ARF content). Anything
 * that isn't a plausible Convex doc id (see CAMPAIGN_ID_PATTERN) is rejected so
 * it never becomes a Prometheus label or Redis key. Returns undefined otherwise.
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
