/**
 * Authenticated delayed-feedback provenance.
 *
 * Exact message records and bounded recipient indexes expire after eight days:
 * one day beyond the signed VERP verification horizon and well beyond the
 * four-day delivery retry horizon. Recipient indexes keep at most 64 live
 * message/domain observations; mixed or missing observations resolve unknown
 * and therefore cannot mutate suppression or reputation state.
 */

import { createHash } from 'crypto';
import type Redis from 'ioredis';
import type { DeliveryDomain } from '@owlat/shared';
import type { BounceAttempt } from './types.js';
import type { EmailJob } from '../types.js';
import { parseCampaignFromFeedbackId } from '../intelligence/campaignComplaintRate.js';

const FEEDBACK_TTL_SECONDS = 8 * 24 * 60 * 60;
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

function parseRecord(value: string | null): FeedbackProvenance | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (
			typeof parsed['messageId'] === 'string' &&
			(parsed['deliveryDomain'] === 'production' || parsed['deliveryDomain'] === 'member_test') &&
			typeof parsed['organizationId'] === 'string' &&
			typeof parsed['recipient'] === 'string'
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
	const exact = classification.originalMessageId
		? parseRecord(await redis.get(messageKey(classification.originalMessageId)))
		: null;
	if (exact) {
		const enriched = {
			...classification,
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
