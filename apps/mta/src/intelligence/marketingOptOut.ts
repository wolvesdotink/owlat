/**
 * Marketing opt-outs Convex reports, so marketing mail this MTA already holds
 * for the address is withdrawn instead of delivered.
 *
 * Convex refuses marketing mail to an unsubscribed contact before dispatch,
 * but a message the MTA accepted earlier can sit in its queue for days
 * (greylisting, a provider throttle, the warm-up cap). The dispatch pipeline's
 * suppression phase reads this record before every attempt and drops a queued
 * campaign or automation message whose dispatch started before the opt-out.
 * Transactional and system mail to the same address is never withdrawn.
 *
 * One record per organization and address: the time of the latest opt-out,
 * kept as long as any job that predates it could still be queued. A job that
 * started dispatching after the record (the contact subscribed again and a new
 * campaign went out) is left alone, so a re-subscribe needs no message of its
 * own.
 */

import type Redis from 'ioredis';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS, normalizeEmail } from '@owlat/shared';
import type { MtaConfig } from '../config.js';
import type { EmailJob } from '../types.js';

const KEY_PREFIX = 'mta:marketing-optout:';

/**
 * Convex checks the contact before it starts a dispatch and stamps the
 * dispatch's start a moment later, so a dispatch that started just after the
 * opt-out may have read the contact before it. Withdrawing those too errs on
 * the side of the recipient.
 */
const GATE_READ_SLACK_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep the latest of two opt-outs; the record outlives every job it can match. */
const RECORD_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
end
return 1
`;

function optOutKey(organizationId: string, email: string): string {
	return `${KEY_PREFIX}${organizationId}:${normalizeEmail(email)}`;
}

export interface MarketingOptOut {
	organizationId: string;
	email: string;
	optedOutAt: number;
}

/** Record an opt-out. Returns false when it is too old to match any queued job. */
export async function recordMarketingOptOut(
	redis: Redis,
	entry: MarketingOptOut,
	config: Pick<MtaConfig, 'maxMessageAgeMs'>,
	now: number = Date.now()
): Promise<boolean> {
	const retainUntil =
		entry.optedOutAt +
		GATE_READ_SLACK_MS +
		Math.max(config.maxMessageAgeMs, GOVERNED_MTA_MAX_MESSAGE_AGE_MS) +
		DAY_MS;
	const ttlMs = retainUntil - now;
	if (ttlMs <= 0) return false;
	await redis.eval(
		RECORD_SCRIPT,
		1,
		optOutKey(entry.organizationId, entry.email),
		String(entry.optedOutAt),
		String(ttlMs)
	);
	return true;
}

/** The recorded opt-out time, or null. */
export async function marketingOptOutAt(
	redis: Redis,
	organizationId: string,
	email: string
): Promise<number | null> {
	const raw = await redis.get(optOutKey(organizationId, email));
	const value = raw === null ? Number.NaN : Number(raw);
	return Number.isFinite(value) ? value : null;
}

/**
 * Whether a queued job is marketing mail whose dispatch started before its
 * recipient opted out. A job without a stream (retained from before jobs
 * carried one, or a Postbox/system message) is never withdrawn.
 */
export async function isWithdrawnByMarketingOptOut(redis: Redis, job: EmailJob): Promise<boolean> {
	if (job.messageType !== 'campaign' && job.messageType !== 'automation') return false;
	if (job.firstEnqueuedAt === undefined) return false;
	const optedOutAt = await marketingOptOutAt(redis, job.organizationId, job.to);
	return optedOutAt !== null && job.firstEnqueuedAt <= optedOutAt + GATE_READ_SLACK_MS;
}
