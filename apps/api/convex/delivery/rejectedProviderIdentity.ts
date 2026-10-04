/**
 * Bind a refused message's provider id to its Send (#1243).
 *
 * A provider can receive a message and refuse it in the same response (a
 * Mandrill `rejected` result). The send fails, but the provider still reports
 * the refusal later, keyed by the message id it assigned: Mandrill's `reject`
 * webhook, whose blacklist suppression Owlat mirrors. Without the id on the
 * Send, that event can only be matched by address, which the webhook refuses
 * for events from outside this deployment's subaccounts
 * (`webhooks/sendingScope.ts`).
 *
 * The governed dispatch calls this just before it throws for the failure, so
 * the Send is still `queued`; the completion then fails it as before, and the
 * id stays. A Send that already carries an id keeps it.
 *
 * A bound Send is no longer a candidate for the lost-send sweep, which skips
 * Sends with an id because provider feedback can reach them. Here it can: the
 * provider's own report of the refusal fails it if the completion never lands.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { sendRefValidator } from './routingReentry';

export const bindRejectedProviderIdentity = internalMutation({
	args: { send: sendRefValidator, providerMessageId: v.string(), providerType: v.string() },
	handler: async (ctx, args): Promise<{ isBound: boolean }> => {
		const send = await ctx.db.get(args.send.id);
		if (!send || send.status !== 'queued' || send.providerMessageId) return { isBound: false };
		await ctx.db.patch(args.send.id, {
			providerMessageId: args.providerMessageId,
			providerType: args.providerType,
		});
		return { isBound: true };
	},
});
