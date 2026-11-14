/**
 * The volume caps of the transactional send API: per template and recipient,
 * and per API key and UTC day (the `transactionalPerRecipient` and
 * `transactionalPerApiKeyDaily` buckets in `lib/rateLimiter.ts`).
 *
 * Charged inside the intake mutation, after the request has passed every
 * refusal that does not depend on volume and before anything is written, so a
 * refused request spends nothing and an accepted one is charged in the same
 * transaction as its Send. An Idempotency-Key replay is answered before this
 * runs and so is never charged or refused. System mail and campaigns do not
 * come through the intake and are not capped here.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { redactEmailAddress } from '@owlat/shared/logRedaction';
import { rateLimiter } from '../lib/rateLimiter';
import type { DispatchRefusal } from './dispatchDecision';

/**
 * Charge one send against both caps, or return the refusal when either is
 * spent. Both are checked before either is charged, so a request refused by the
 * daily cap does not also use up the recipient's budget.
 *
 * The recipient key carries the address's digest, not the address: the
 * limiter's rows sit outside contact erasure.
 */
export async function chargeTransactionalSendCaps(
	ctx: MutationCtx,
	templateId: Id<'transactionalEmails'>,
	request: { email: string; apiKeyId?: Id<'apiKeys'> }
): Promise<DispatchRefusal | null> {
	const recipientKey = `${templateId}:${redactEmailAddress(request.email)}`;
	const recipient = await rateLimiter.check(ctx, 'transactionalPerRecipient', {
		key: recipientKey,
	});
	if (!recipient.ok) {
		return {
			ok: false,
			reason: 'recipient_rate_limited',
			detail:
				'Too many emails from this transactional template to this recipient. Try again later.',
			retryAfterMs: recipient.retryAfter,
		};
	}
	const keyId = request.apiKeyId;
	if (keyId !== undefined) {
		const daily = await rateLimiter.check(ctx, 'transactionalPerApiKeyDaily', { key: keyId });
		if (!daily.ok) {
			return {
				ok: false,
				reason: 'daily_send_limit',
				detail: 'This API key has reached its daily transactional send limit.',
				retryAfterMs: daily.retryAfter,
			};
		}
	}
	await rateLimiter.limit(ctx, 'transactionalPerRecipient', { key: recipientKey });
	if (keyId !== undefined) {
		await rateLimiter.limit(ctx, 'transactionalPerApiKeyDaily', { key: keyId });
	}
	return null;
}
