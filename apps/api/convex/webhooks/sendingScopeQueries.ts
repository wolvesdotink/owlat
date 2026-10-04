/**
 * The database half of `./sendingScope.ts` (#1243): does an event from outside
 * this deployment's sending scope match one of our Sends?
 *
 * Matching takes three facts: the provider message id names a Send, that Send
 * went out through the same provider kind, and it went to the address the event
 * names. A replay of stored feedback (`./unresolvedFeedback.ts`) asks the same
 * question later, from a keyed hash of the address instead of the address.
 */

import { v } from 'convex/values';
import { internalQuery, type DatabaseReader } from '../_generated/server';
import { hmacSha256Hex } from '../lib/crypto';
import { normalizeEmail } from '../lib/inputGuards';

/** `attributed`: one of ours. `mismatch`: the id names a Send, but not this one. */
export type SendingScopeMatch = 'attributed' | 'mismatch' | 'no_send';

/** The provider kind and recipient of the Send a provider message id names, if any. */
export async function findSendByProviderMessageId(
	db: DatabaseReader,
	providerMessageId: string
): Promise<{ providerType: string | undefined; recipient: string } | null> {
	const campaignSend = await db
		.query('emailSends')
		.withIndex('by_provider_message_id', (q) => q.eq('providerMessageId', providerMessageId))
		.first();
	if (campaignSend) {
		return { providerType: campaignSend.providerType, recipient: campaignSend.contactEmail };
	}
	const otherSend = await db
		.query('transactionalSends')
		.withIndex('by_provider_message_id', (q) => q.eq('providerMessageId', providerMessageId))
		.first();
	return otherSend ? { providerType: otherSend.providerType, recipient: otherSend.email } : null;
}

/**
 * The address an out-of-scope event named, as stored on an unresolved-feedback
 * row: an HMAC of the normalized address keyed by the message id. This avoids
 * storing the plaintext address and keeps equal addresses from linking across
 * rows, but the key sits on the same row, so anyone who can read the row can
 * confirm a guessed address. It is compared, never read back. Not keyed with
 * `INSTANCE_SECRET`: rotating that secret would turn a genuine match into a
 * refused replay.
 */
export async function scopeRecipientHash(
	providerMessageId: string,
	recipient: string
): Promise<string | undefined> {
	const normalized = normalizeEmail(recipient);
	return normalized ? await hmacSha256Hex(providerMessageId, normalized) : undefined;
}

export const matchSendingScope = internalQuery({
	args: {
		providerMessageId: v.string(),
		providerType: v.string(),
		recipient: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<SendingScopeMatch> => {
		const send = await findSendByProviderMessageId(ctx.db, args.providerMessageId);
		if (!send) return 'no_send';
		if (send.providerType !== args.providerType || !args.recipient) return 'mismatch';
		const recipient = normalizeEmail(args.recipient);
		return recipient && normalizeEmail(send.recipient) === recipient ? 'attributed' : 'mismatch';
	},
});
