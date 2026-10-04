/**
 * Feedback from outside this deployment's sending scope (#1243).
 *
 * A Mandrill webhook belongs to the whole ACCOUNT, so on an account shared with
 * other senders it carries every subaccount's events. Two of them act on an
 * ADDRESS without a matching Send: `unsub` unsubscribes the contact, and a
 * `reject` blocklists the address before the Send is looked up. Another
 * subaccount's opt-out or blacklist rule must not reach an Owlat contact.
 *
 * The adapter cannot tell from the event alone whether it is ours: Mandrill
 * rules can move Owlat's own mail into a subaccount, and mail sent before an
 * operator changed `MANDRILL_SUBACCOUNT` carries the old one. So it does not
 * drop an event from another subaccount; it marks it
 * ({@link OutsideSendingScope}) and this module decides at dispatch, where the
 * database is:
 *
 *  - an event that attributes to one of our Sends (same provider message id,
 *    same provider kind, same recipient) is applied as usual, whatever
 *    subaccount it names. People unsubscribe from old mail at any time;
 *  - any other marked event is dropped before it is claimed or dispatched.
 *
 * Attribution needs the recipient as well as the id, so a marked event naming
 * no address is dropped too.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalQuery, type ActionCtx, type DatabaseReader } from '../_generated/server';
import { normalizeEmail } from '../lib/inputGuards';
import type { InboundEvent } from './types';

async function findSendByProviderMessageId(db: DatabaseReader, providerMessageId: string) {
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

/** Whether a Send of ours went out through `providerType` to `recipient` under this id. */
export const attributesToOwnSend = internalQuery({
	args: { providerMessageId: v.string(), providerType: v.string(), recipient: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const send = await findSendByProviderMessageId(ctx.db, args.providerMessageId);
		if (!send || send.providerType !== args.providerType) return false;
		const recipient = normalizeEmail(args.recipient);
		return Boolean(recipient) && normalizeEmail(send.recipient) === recipient;
	},
});

/**
 * Whether the dispatcher should apply this event: always for an unmarked one,
 * and for a marked one only when it attributes to one of our Sends.
 */
export async function isWithinSendingScope(ctx: ActionCtx, event: InboundEvent): Promise<boolean> {
	const scope = 'outsideSendingScope' in event ? event.outsideSendingScope : undefined;
	if (!scope) return true;
	const providerMessageId = 'providerMessageId' in event ? event.providerMessageId : undefined;
	const providerType = 'providerType' in event ? event.providerType : undefined;
	if (!providerMessageId || !providerType || !scope.recipient) return false;
	return await ctx.runQuery(internal.webhooks.sendingScope.attributesToOwnSend, {
		providerMessageId,
		providerType,
		recipient: scope.recipient,
	});
}
