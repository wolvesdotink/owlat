/**
 * The volume caps of the transactional send API: per template and recipient,
 * and per API key and UTC day. Their defaults and bounds are in
 * `./sendCapsPolicy.ts`; an instance admin changes them (`./sendCapSettings.ts`)
 * and a template can opt out of the per-recipient one.
 *
 * Charged inside the intake mutation, after the request has passed every
 * refusal that does not depend on volume and before anything is written, so a
 * refused request spends nothing and an accepted one is charged in the same
 * transaction as its Send. An Idempotency-Key replay is answered before this
 * runs and so is never charged or refused. System mail and campaigns do not
 * come through the intake and are not capped here.
 *
 * Each bucket counts USAGE against a fixed ceiling instead of holding the cap
 * as the limiter's capacity: the limiter stores what is left, so a bucket sized
 * by the cap would keep an exhausted recipient or key refused after an admin
 * raised the cap. Counted this way, a changed cap decides the very next
 * request, in both directions, with one limiter config per bucket.
 */

import { calculateRateLimit, DAY, type RateLimitConfig } from '@convex-dev/rate-limiter';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { redactEmailAddress } from '@owlat/shared/logRedaction';
import { rateLimiter } from '../lib/rateLimiter';
import type { DispatchRefusal } from './dispatchDecision';
import { capVerdict, describeWindow, effectiveSendCaps } from './sendCapsPolicy';

/** Far above any cap an admin may set, so usage never reaches it. */
const USAGE_CEILING = 1_000_000_000;

/**
 * Bucket names. They differ from the names the limiter used while it held the
 * caps as capacities, whose stored values mean "left", not "used".
 */
export const PER_RECIPIENT_BUCKET = 'transactionalPerRecipientUsage';
export const PER_API_KEY_DAILY_BUCKET = 'transactionalPerApiKeyDailyUsage';

/** Usage drains continuously at the cap's own rate: `count` per window. */
function perRecipientConfig(count: number, windowMs: number): RateLimitConfig {
	return { kind: 'token bucket', rate: count, period: windowMs, capacity: USAGE_CEILING };
}

/** `start: 0` puts the window boundary at UTC midnight. */
export const PER_API_KEY_DAILY_CONFIG: RateLimitConfig = {
	kind: 'fixed window',
	rate: USAGE_CEILING,
	period: DAY,
	capacity: USAGE_CEILING,
	start: 0,
};

/** Sends counted against a bucket now, and when its current window began. */
export async function readBucketUsage(
	ctx: MutationCtx,
	name: string,
	key: string,
	config: RateLimitConfig,
	now: number
): Promise<{ used: number; windowStart: number }> {
	const stored = await rateLimiter.getValue(ctx, name, { key, config });
	const current = calculateRateLimit({ value: stored.value, ts: stored.ts }, config, now);
	return { used: USAGE_CEILING - current.value, windowStart: current.ts };
}

/**
 * Charge one send against the caps in force, or return the refusal when one is
 * spent. Both are checked before either is charged, so a request refused by the
 * daily cap does not also use up the recipient's allowance. A cap that is off,
 * or the per-recipient cap of an exempt template, is neither checked nor
 * charged.
 *
 * The recipient key carries the address's digest, not the address: the
 * limiter's rows sit outside contact erasure.
 */
export async function chargeTransactionalSendCaps(
	ctx: MutationCtx,
	template: Pick<Doc<'transactionalEmails'>, '_id' | 'isRecipientCapExempt'>,
	request: { email: string; apiKeyId?: Id<'apiKeys'> },
	settings: Pick<Doc<'instanceSettings'>, 'transactionalSendCaps'> | null
): Promise<DispatchRefusal | null> {
	const caps = effectiveSendCaps(settings?.transactionalSendCaps);
	const now = Date.now();
	const charges: Array<{ name: string; key: string; config: RateLimitConfig }> = [];

	const { perRecipient, perApiKeyDaily } = caps;
	if (perRecipient.isEnabled && template.isRecipientCapExempt !== true) {
		const key = `${template._id}:${redactEmailAddress(request.email)}`;
		const config = perRecipientConfig(perRecipient.count, perRecipient.windowMs);
		const { used } = await readBucketUsage(ctx, PER_RECIPIENT_BUCKET, key, config, now);
		const verdict = capVerdict({
			used,
			cap: perRecipient.count,
			drainPerMs: perRecipient.count / perRecipient.windowMs,
			msUntilWindowEnds: 0,
		});
		if (!verdict.ok) {
			return {
				ok: false,
				reason: 'recipient_rate_limited',
				detail: `Too many emails from this transactional template to this recipient: the limit is ${perRecipient.count} per ${describeWindow(perRecipient.windowMs)}. The instance admin can change or switch off this limit, or exempt the template from it.`,
				retryAfterMs: verdict.retryAfterMs,
			};
		}
		charges.push({ name: PER_RECIPIENT_BUCKET, key, config });
	}

	const keyId = request.apiKeyId;
	if (keyId !== undefined && perApiKeyDaily.isEnabled) {
		const config = PER_API_KEY_DAILY_CONFIG;
		const usage = await readBucketUsage(ctx, PER_API_KEY_DAILY_BUCKET, keyId, config, now);
		const verdict = capVerdict({
			used: usage.used,
			cap: perApiKeyDaily.count,
			drainPerMs: null,
			msUntilWindowEnds: usage.windowStart + DAY - now,
		});
		if (!verdict.ok) {
			return {
				ok: false,
				reason: 'daily_send_limit',
				detail: `This API key has reached its daily transactional send limit of ${perApiKeyDaily.count}. The instance admin can change or switch off this limit.`,
				retryAfterMs: verdict.retryAfterMs,
			};
		}
		charges.push({ name: PER_API_KEY_DAILY_BUCKET, key: keyId, config });
	}

	for (const charge of charges) {
		await rateLimiter.limit(ctx, charge.name, { key: charge.key, config: charge.config });
	}
	return null;
}
