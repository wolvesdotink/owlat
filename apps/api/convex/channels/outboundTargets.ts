/**
 * Where a manual outbound channel message goes: the contact's address on the
 * channel and the conversation thread it lands in. The dispatch in
 * `outbound.ts` is `'use node'` and cannot touch the db, so it calls these.
 *
 * Each builder's body is an exported helper, so the previous release's paths
 * (`unifiedMessages.ts` at the convex root) run the same code.
 */

import { v, type ObjectType } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Id } from '../_generated/dataModel';
import { outboundChannelValidator } from '../lib/convexValidators';
import { applyOpenThreadDelta } from '../lib/inboxStats';

/**
 * Resolve the destination address/handle for a contact on a given channel,
 * for outbound dispatch (the SMS/WhatsApp `To`). Reads `contactIdentities`,
 * preferring the primary identity. `sms` maps onto the `phone` identity
 * channel. Returns null when the contact has no identity for the channel.
 */
export const getContactChannelIdentifierArgs = {
	contactId: v.id('contacts'),
	channel: outboundChannelValidator,
};

export async function contactChannelIdentifier(
	ctx: QueryCtx,
	args: ObjectType<typeof getContactChannelIdentifierArgs>
): Promise<string | null> {
	// `sms` outbound is keyed off the contact's phone identity.
	const accepted = args.channel === 'sms' ? ['sms', 'phone'] : [args.channel];
	const identities = await ctx.db
		.query('contactIdentities')
		.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
		.collect(); // bounded: a contact has a handful of channel identities
	const matches = identities.filter((id) => accepted.includes(id.channel));
	if (matches.length === 0) return null;
	const primary = matches.find((m) => m.isPrimary);
	return (primary ?? matches[0]!).identifier;
}

export const getContactChannelIdentifier = internalQuery({
	args: getContactChannelIdentifierArgs,
	handler: async (ctx, args): Promise<string | null> => await contactChannelIdentifier(ctx, args),
});

/**
 * Resolve (or create) the conversation thread to use for a user-initiated
 * outbound channel message, and validate the send is possible. Backs the public
 * `channels.outbound.sendChannelMessage` action — which, being a `'use node'`
 * action, cannot touch the db itself. Unlike the fail-safe agent-reply path
 * (which silently records a `failed` row), the manual path throws on a
 * misconfiguration so the admin gets immediate feedback in the compose UI.
 *
 * Continues the contact's most recent thread for the channel when one exists
 * (so a manual reply lands in the same conversation), otherwise opens a fresh
 * thread. Returns the thread id; the caller schedules `dispatchOutbound`.
 *
 * `threadId` PINS the conversation instead of inferring it. The Team Inbox
 * replies per message, from inside a thread the agent is already reading, and
 * "the contact's most recent thread on this channel" is not reliably that one —
 * an older thread reopened for triage would silently answer on the newer one.
 * The contact composer sends no thread and keeps the inferring behaviour.
 */
export const resolveOutboundThreadArgs = {
	contactId: v.id('contacts'),
	channel: outboundChannelValidator,
	threadId: v.optional(v.id('conversationThreads')),
};

export async function resolveThreadForOutbound(
	ctx: MutationCtx,
	args: ObjectType<typeof resolveOutboundThreadArgs>
): Promise<Id<'conversationThreads'>> {
	// The channel must be configured AND enabled — a disabled/unconfigured
	// channel would only ever record a `failed` row in dispatchOutbound, so
	// reject up front with a clear message for the compose UI.
	const config = await ctx.db
		.query('channelConfigs')
		.withIndex('by_channel', (q) => q.eq('channel', args.channel))
		.first();
	if (!config || !config.isEnabled) {
		throw new Error(
			`The ${args.channel} channel is not enabled. Configure and enable it in Settings → Channels first.`
		);
	}

	// Treat a soft-deleted (GDPR-erased / unsubscribe-deleted) contact as
	// not-found so an admin acting on a stale id can't dispatch a channel
	// message to someone who exercised their right to erasure. Mirrors the
	// schema-mandated `deletedAt === undefined` filter every other lookup
	// (e.g. contacts/timeline.ts, contacts get()) honors.
	const contact = await ctx.db.get(args.contactId);
	if (!contact || contact.deletedAt !== undefined) throw new Error('Contact not found');

	// sms/whatsapp need a destination identity; generic posts to a fixed
	// endpoint and needs none. Block the send early when the address is absent.
	if (args.channel === 'sms' || args.channel === 'whatsapp') {
		const accepted = args.channel === 'sms' ? ['sms', 'phone'] : ['whatsapp'];
		const identities = await ctx.db
			.query('contactIdentities')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: a contact has a handful of channel identities
		if (!identities.some((id) => accepted.includes(id.channel))) {
			throw new Error(`This contact has no ${args.channel} address on file.`);
		}
	}

	// A pinned thread must belong to this contact — the id reaches us from a
	// client, so an unrelated thread would otherwise become a place to write
	// an outbound message about someone else.
	if (args.threadId) {
		const thread = await ctx.db.get(args.threadId);
		if (!thread || thread.contactId !== args.contactId) {
			throw new Error('That conversation does not belong to this contact.');
		}
		return thread._id;
	}

	// Continue the most recent thread for this contact+channel if one exists.
	const recent = await ctx.db
		.query('unifiedMessages')
		.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
		.order('desc')
		.take(50); // bounded scan of the contact's latest messages
	const sameChannel = recent.find((m) => m.channel === args.channel);
	if (sameChannel) return sameChannel.threadId;

	// No prior thread for this channel — open a fresh one. The display
	// identifier mirrors the inbound convention (raw handle for sms/whatsapp,
	// email/label for generic).
	const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
	const identifier = contact.email ?? name ?? args.contactId;
	const now = Date.now();
	const threadId = await ctx.db.insert('conversationThreads', {
		subject: name ? `Conversation with ${name}` : `${args.channel} conversation`,
		normalizedSubject: '',
		contactId: args.contactId,
		contactIdentifier: identifier,
		status: 'open',
		messageCount: 0,
		lastMessageAt: now,
		firstMessageAt: now,
		createdAt: now,
	});
	// A fresh thread is born 'open'; account the open-count entry here so the
	// denormalized counter stays consistent with the inbound create-as-open
	// paths (inbox/threads/module.ts). Continuing an existing thread above
	// returns early and never reaches this branch, so it isn't double-counted.
	await applyOpenThreadDelta(ctx, 1);
	return threadId;
}

export const resolveOutboundThread = internalMutation({
	args: resolveOutboundThreadArgs,
	returns: v.id('conversationThreads'),
	handler: async (ctx, args): Promise<Id<'conversationThreads'>> =>
		await resolveThreadForOutbound(ctx, args),
});
