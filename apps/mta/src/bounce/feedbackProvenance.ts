/**
 * Authenticated delayed-feedback provenance.
 *
 * Exact message records and bounded recipient indexes are retained for
 * `FEEDBACK_RECORD_RETENTION_SECONDS` (`bounce/signedToken.ts`) — the horizon
 * over which a signed feedback token still verifies, plus a day of clock-skew
 * slack. The record is the ONLY source of organizationId/campaignId/
 * deliveryDomain/recipient, so it must outlive every token that can still be
 * presented: a complaint that verifies but finds no record attributes to
 * nothing and cannot feed the complaint gate. That is why the retention is
 * derived from the token horizon rather than chosen here.
 *
 * Recipient indexes keep at most 64 live message/domain observations; mixed or
 * missing observations resolve unknown and therefore cannot mutate suppression
 * or reputation state.
 */

import { createHash } from 'crypto';
import type Redis from 'ioredis';
import type { DeliveryDomain } from '@owlat/shared';
import type { BounceAttempt } from './types.js';
import type { EmailJob } from '../types.js';
import { parseCampaignFromFeedbackId } from '../intelligence/campaignComplaintRate.js';
import { TransientFeedbackProcessingError } from './transientFeedbackError.js';
import { FEEDBACK_RECORD_RETENTION_SECONDS } from './signedToken.js';

const FEEDBACK_TTL_SECONDS = FEEDBACK_RECORD_RETENTION_SECONDS;
const FEEDBACK_TTL_MS = FEEDBACK_TTL_SECONDS * 1_000;
const MAX_RECIPIENT_OBSERVATIONS = 64;

interface FeedbackProvenance {
	messageId: string;
	deliveryDomain: DeliveryDomain;
	organizationId: string;
	recipient: string;
	campaignId?: string;
}

function messageKey(messageId: string): string {
	return `mta:{feedback}:message:${messageId}`;
}

function recipientKey(recipient: string): string {
	const digest = createHash('sha256').update(recipient.trim().toLowerCase()).digest('hex');
	return `mta:{feedback}:recipient:${digest}`;
}

function campaignIdOf(job: EmailJob): string | undefined {
	const key = job.headers
		? Object.keys(job.headers).find((header) => header.toLowerCase() === 'feedback-id')
		: undefined;
	return key && job.headers ? parseCampaignFromFeedbackId(job.headers[key]) : undefined;
}

export async function recordFeedbackProvenance(redis: Redis, job: EmailJob): Promise<void> {
	if (!job.deliveryDomain) return;
	const campaignId = campaignIdOf(job);
	const record: FeedbackProvenance = {
		messageId: job.messageId,
		deliveryDomain: job.deliveryDomain,
		organizationId: job.organizationId,
		recipient: job.to.trim().toLowerCase(),
		...(campaignId ? { campaignId } : {}),
	};
	const now = Date.now();
	const recipient = recipientKey(record.recipient);
	const member = JSON.stringify({ messageId: record.messageId, domain: record.deliveryDomain });
	const pipeline = redis.pipeline();
	pipeline.setex(messageKey(job.messageId), FEEDBACK_TTL_SECONDS, JSON.stringify(record));
	pipeline.zadd(recipient, String(now), member);
	pipeline.zremrangebyscore(recipient, '-inf', String(now - FEEDBACK_TTL_MS));
	pipeline.zremrangebyrank(recipient, 0, -(MAX_RECIPIENT_OBSERVATIONS + 1));
	pipeline.expire(recipient, FEEDBACK_TTL_SECONDS);
	const results = await pipeline.exec();
	if (!results || results.some(([error]) => error !== null)) {
		throw new Error('Delayed-feedback provenance pipeline did not commit completely');
	}
}

function parseRecord(value: string | null, expectedMessageId: string): FeedbackProvenance | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		const campaignId = parsed['campaignId'];
		const isKnownCampaignId =
			campaignId === undefined ||
			(typeof campaignId === 'string' &&
				parseCampaignFromFeedbackId(`campaign:${campaignId}:known:known`) === campaignId);
		if (
			parsed['messageId'] === expectedMessageId &&
			(parsed['deliveryDomain'] === 'production' || parsed['deliveryDomain'] === 'member_test') &&
			typeof parsed['organizationId'] === 'string' &&
			parsed['organizationId'].length > 0 &&
			parsed['organizationId'].length <= 128 &&
			typeof parsed['recipient'] === 'string' &&
			parsed['recipient'].length > 0 &&
			parsed['recipient'].length <= 320 &&
			isKnownCampaignId
		) {
			return parsed as unknown as FeedbackProvenance;
		}
	} catch {
		// Corrupt state is unknown, never production evidence.
	}
	return null;
}

async function recipientDomain(
	redis: Redis,
	recipient: string
): Promise<DeliveryDomain | 'unknown'> {
	const key = recipientKey(recipient);
	const now = Date.now();
	await redis.zremrangebyscore(key, '-inf', String(now - FEEDBACK_TTL_MS));
	const values = await redis.zrange(key, 0, -1);
	const domains = new Set<DeliveryDomain>();
	for (const value of values) {
		try {
			const parsed = JSON.parse(value) as Record<string, unknown>;
			if (parsed['domain'] === 'production' || parsed['domain'] === 'member_test') {
				domains.add(parsed['domain']);
			}
		} catch {
			return 'unknown';
		}
	}
	return domains.size === 1 ? [...domains][0]! : 'unknown';
}

/** Attach only server-persisted provenance to delayed DSN/FBL attribution. */
export async function attachFeedbackProvenance(
	redis: Redis,
	attempt: BounceAttempt
): Promise<BounceAttempt> {
	if (attempt.kind !== 'fbl' && attempt.kind !== 'dsn_attributed') return attempt;
	const classification = attempt.kind === 'fbl' ? attempt.arf : attempt.bounce;
	let exact: FeedbackProvenance | null = null;
	if (classification.originalMessageId) {
		try {
			exact = parseRecord(
				await redis.get(messageKey(classification.originalMessageId)),
				classification.originalMessageId
			);
		} catch (error) {
			throw new TransientFeedbackProcessingError(
				'Authenticated feedback provenance is unavailable',
				error
			);
		}
	}
	if (exact) {
		// EVERY trusted field comes from the record we wrote at send time, never
		// from the report. The recipient matters most: a verified message id proves
		// only that the reporter holds a token we signed — with a CFBL address that
		// is true of anyone who received one message from the tenant — so trusting
		// the report's `Original-Rcpt-To` would let such a reporter have an
		// arbitrary address suppressed inside that tenant. The record already knows
		// who the message went to.
		const enriched = {
			...classification,
			recipient: exact.recipient,
			organizationId: exact.organizationId,
			campaignId: exact.campaignId,
			deliveryDomain: exact.deliveryDomain,
			feedbackProvenance: exact.deliveryDomain,
		};
		return attempt.kind === 'fbl'
			? { ...attempt, arf: enriched }
			: { ...attempt, bounce: enriched };
	}

	if (attempt.kind === 'fbl' && classification.recipient) {
		// A recipient observation proves that Owlat sent mail, not that this ARF
		// came from a trusted feedback loop. Without exact Message-ID attribution
		// the report remains non-destructive even when the recipient has one known
		// delivery domain.
		const domain = await recipientDomain(redis, classification.recipient);
		const enriched = {
			...classification,
			organizationId: undefined,
			campaignId: undefined,
			...(domain === 'unknown' ? {} : { deliveryDomain: domain }),
			feedbackProvenance: 'unknown' as const,
		};
		return { ...attempt, arf: enriched };
	}

	const unknown = {
		...classification,
		organizationId: undefined,
		campaignId: undefined,
		feedbackProvenance: 'unknown' as const,
	};
	return attempt.kind === 'fbl' ? { ...attempt, arf: unknown } : { ...attempt, bounce: unknown };
}
