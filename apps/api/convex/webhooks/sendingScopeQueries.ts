/**
 * The database half of `./sendingScope.ts` (#1243): does an event from outside
 * this deployment's sending scope match one of our Sends?
 */

import { v } from 'convex/values';
import { internalQuery, type DatabaseReader } from '../_generated/server';
import { normalizeEmail } from '../lib/inputGuards';

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
