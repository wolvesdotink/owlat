/**
 * The unified message timeline: the per-thread, per-contact and recent reads
 * across every channel (email, SMS, WhatsApp, webhook, chat), the chat send,
 * and the timeline writes the outbound commit and the email mirrors share.
 * Channel configuration is in `config.ts`, the health checks in `health.ts`,
 * and the outbound dispatch's thread and recipient resolution in
 * `outboundTargets.ts`.
 *
 * Each builder's body is an exported helper, so the previous release's paths
 * (`unifiedMessages.ts` at the convex root) run the same code.
 */

import { v, type ObjectType } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requirePermission, type MutationSessionContext } from '../lib/sessionOrganization';
import { isSharedInboxReader } from '../inbox/access';
import { transition as threadTransition } from '../inbox/threads/module';
import type { Doc, Id } from '../_generated/dataModel';
import { unifiedMessageChannelValidator, outboundChannelValidator } from '../lib/convexValidators';
import { openUnifiedMessageContent, sealUnifiedMessageContentAtWrite } from '../lib/messageBody';

/**
 * Open one `unifiedMessages` row for a timeline query: unseal the sealed-at-rest
 * `content` (E8b) and parse the metadata JSON. Shared by the three timeline
 * queries so the identical mapper lives in exactly one place.
 */
async function openTimelineRow(msg: Doc<'unifiedMessages'>) {
	return {
		...msg,
		content: await openUnifiedMessageContent(msg.content),
		metadata: msg.metadata ? parseMetadata(msg.metadata) : undefined,
	};
}

/** Refusal for a timeline read by a caller outside the Team Inbox. */
const NOT_A_READER = 'Only owners and admins can read Team Inbox conversations';

/**
 * Get messages for a conversation thread (unified timeline). Team Inbox
 * content: shared-inbox readers only (inbox/access.ts).
 */
export const getThreadTimelineArgs = {
	threadId: v.id('conversationThreads'),
	limit: v.optional(v.number()),
};

export async function threadTimeline(
	ctx: QueryCtx,
	args: ObjectType<typeof getThreadTimelineArgs>,
	session: MutationSessionContext
) {
	requirePermission(isSharedInboxReader(session), NOT_A_READER);
	const messages = await ctx.db
		.query('unifiedMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
		.order('asc')
		.take(args.limit ?? 100);

	return await Promise.all(messages.map(openTimelineRow));
}

// authz: threadTimeline requires a shared-inbox reader before it reads.
export const getThreadTimeline = authedQuery({
	args: getThreadTimelineArgs,
	handler: async (ctx, args, session) => await threadTimeline(ctx, args, session),
});

/**
 * Get messages for a contact across all channels. Team Inbox content:
 * shared-inbox readers only (inbox/access.ts).
 */
export const getContactTimelineArgs = {
	contactId: v.id('contacts'),
	limit: v.optional(v.number()),
};

export async function contactTimeline(
	ctx: QueryCtx,
	args: ObjectType<typeof getContactTimelineArgs>,
	session: MutationSessionContext
) {
	requirePermission(isSharedInboxReader(session), NOT_A_READER);
	const messages = await ctx.db
		.query('unifiedMessages')
		.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
		.order('desc')
		.take(args.limit ?? 50);

	return await Promise.all(messages.map(openTimelineRow));
}

// authz: contactTimeline requires a shared-inbox reader before it reads.
export const getContactTimeline = authedQuery({
	args: getContactTimelineArgs,
	handler: async (ctx, args, session) => await contactTimeline(ctx, args, session),
});

/**
 * Get recent messages across all channels. Team Inbox content: shared-inbox
 * readers only (inbox/access.ts).
 */
export const listRecentArgs = {
	channel: v.optional(unifiedMessageChannelValidator),
	limit: v.optional(v.number()),
};

export async function recentMessages(
	ctx: QueryCtx,
	args: ObjectType<typeof listRecentArgs>,
	session: MutationSessionContext
) {
	requirePermission(isSharedInboxReader(session), NOT_A_READER);
	let q;
	if (args.channel) {
		q = ctx.db
			.query('unifiedMessages')
			.withIndex('by_channel', (q2) => q2.eq('channel', args.channel!));
	} else {
		q = ctx.db.query('unifiedMessages').withIndex('by_created_at');
	}

	const messages = await q.order('desc').take(args.limit ?? 50);

	return await Promise.all(messages.map(openTimelineRow));
}

// authz: recentMessages requires a shared-inbox reader before it reads.
export const listRecent = authedQuery({
	args: listRecentArgs,
	handler: async (ctx, args, session) => await recentMessages(ctx, args, session),
});

export const outboundMessageArgs = {
	threadId: v.id('conversationThreads'),
	channel: unifiedMessageChannelValidator,
	contactId: v.optional(v.id('contacts')),
	memberId: v.optional(v.string()),
	content: v.string(),
	externalMessageId: v.optional(v.string()),
	status: v.optional(
		v.union(v.literal('queued'), v.literal('sent'), v.literal('delivered'), v.literal('failed'))
	),
	metadata: v.optional(v.string()),
};

/**
 * Insert an outbound timeline row, stamp the channel's last successful send
 * and close the thread's response clock when it reached the customer.
 */
export async function insertOutboundMessage(
	ctx: MutationCtx,
	args: ObjectType<typeof outboundMessageArgs>
): Promise<Id<'unifiedMessages'>> {
	const now = Date.now();
	const id = await ctx.db.insert('unifiedMessages', {
		threadId: args.threadId,
		channel: args.channel,
		direction: 'outbound',
		contactId: args.contactId,
		memberId: args.memberId,
		...(await sealUnifiedMessageContentAtWrite(args.content)),
		externalMessageId: args.externalMessageId,
		status: args.status ?? 'queued',
		metadata: args.metadata,
		createdAt: now,
	});

	// Stamp the channel's last successful send so the dashboard channel card
	// has a live signal (the field is otherwise never written). A `sent`
	// status is the provider's synchronous acceptance, the same point the
	// timeline row is recorded, for the SMS/WhatsApp/generic manual and
	// agent-reply paths that flow through channels/outbound.dispatchOutbound.
	if (args.status === 'sent') {
		await stampChannelLastSuccessfulSend(ctx, args.channel, now);
	}
	// A message that reached the customer is a reply: it closes the thread's
	// response clock (inbox/sla/clock.ts). A person's channel reply has no
	// inbound message to complete, so this is the only place it is seen.
	if (args.status === 'sent' || args.status === 'delivered') {
		await threadTransition(ctx, {
			threadId: args.threadId,
			input: { kind: 'reply_sent', at: now },
		});
	}

	return id;
}

/** A `sent` channel message awaiting a delivered/read/failed transition. */
export const pendingDeliveryValidator = v.object({
	messageId: v.id('unifiedMessages'),
	channel: outboundChannelValidator,
	externalMessageId: v.string(),
});

/**
 * Find outbound channel messages still stuck at `sent` that the delivery-status
 * poller should re-check against the provider. Scopes to the SMS/WhatsApp/generic
 * channels (email delivery state is owned by the MTA send pipeline; chat is
 * terminal on insert) and to rows with a provider `externalMessageId` to poll on.
 *
 * Bounded two ways: a recent `createdAt` window (providers stop reporting on old
 * messages, so polling them forever is wasted work) and a hard `take` cap. Backs
 * `channels.outbound.pollDeliveryStatus`.
 */
export const listPendingDeliveryStatusArgs = {
	sinceMs: v.number(),
	limit: v.number(),
};

export async function pendingDeliveryStatus(
	ctx: QueryCtx,
	args: ObjectType<typeof listPendingDeliveryStatusArgs>
) {
	const cutoff = Date.now() - args.sinceMs;
	const rows = await ctx.db
		.query('unifiedMessages')
		.withIndex('by_direction_status_and_created_at', (q) =>
			q.eq('direction', 'outbound').eq('status', 'sent').gte('createdAt', cutoff)
		)
		.order('desc')
		.take(args.limit);

	const out: Array<{
		messageId: Id<'unifiedMessages'>;
		channel: 'sms' | 'whatsapp' | 'generic';
		externalMessageId: string;
	}> = [];
	for (const row of rows) {
		if (
			(row.channel === 'sms' || row.channel === 'whatsapp' || row.channel === 'generic') &&
			row.externalMessageId
		) {
			out.push({
				messageId: row._id,
				channel: row.channel,
				externalMessageId: row.externalMessageId,
			});
		}
	}
	return out;
}

export const listPendingDeliveryStatus = internalQuery({
	args: listPendingDeliveryStatusArgs,
	returns: v.array(pendingDeliveryValidator),
	handler: async (ctx, args) => await pendingDeliveryStatus(ctx, args),
});

/**
 * Send a chat message (user-facing, authenticated)
 */
export const sendChatMessageArgs = {
	threadId: v.id('conversationThreads'),
	text: v.string(),
	contactId: v.optional(v.id('contacts')),
};

export async function insertChatMessage(
	ctx: MutationCtx,
	args: ObjectType<typeof sendChatMessageArgs>,
	session: MutationSessionContext
) {
	// Conversation threads are the shared customer inbox — sending an outbound
	// chat message on a thread is a support action, so the caller must be a
	// shared-inbox reader (inbox/access.ts).
	requirePermission(isSharedInboxReader(session), NOT_A_READER);
	const content = JSON.stringify({ text: args.text });

	const now = Date.now();
	const id = await ctx.db.insert('unifiedMessages', {
		threadId: args.threadId,
		channel: 'chat',
		direction: 'outbound',
		contactId: args.contactId,
		...(await sealUnifiedMessageContentAtWrite(content)),
		externalMessageId: `chat_${now}_${Math.random().toString(36).slice(2, 9)}`,
		status: 'delivered',
		createdAt: now,
	});

	// Chat is terminal on insert ('delivered'), so this row IS the
	// successful send — stamp the channel card's live signal here too.
	await stampChannelLastSuccessfulSend(ctx, 'chat', now);
	// A chat reply closes the thread's response clock (inbox/sla/clock.ts).
	await threadTransition(ctx, {
		threadId: args.threadId,
		input: { kind: 'reply_sent', at: now },
	});

	return id;
}

// authz: insertChatMessage requires a shared-inbox reader before it writes.
export const sendChatMessage = authedMutation({
	args: sendChatMessageArgs,
	handler: async (ctx, args, session) => await insertChatMessage(ctx, args, session),
});

/**
 * Stamp `lastSuccessfulSend` (and `updatedAt`) onto a channel's `channelConfigs`
 * row. The sole writer of that field — it has no other source, so the dashboard
 * channel card's "Last Successful Send" stat renders "Never" until this runs.
 *
 * Called from every successful-send writer, not just `insertOutboundMessage`:
 * the SMS/WhatsApp/generic path (insertOutboundMessage, `sent`), the email path
 * (mirrorEmailSendWrite, `sent`/`delivered`, which is how the highest-volume
 * default channel records outbound — it never goes through
 * insertOutboundMessage), and
 * chat (sendChatMessage, terminal `delivered`). A no-op when the channel has no
 * config row (nothing to stamp).
 */
async function stampChannelLastSuccessfulSend(
	ctx: MutationCtx,
	channel: Doc<'channelConfigs'>['channel'],
	now: number
): Promise<void> {
	const config = await ctx.db
		.query('channelConfigs')
		.withIndex('by_channel', (q) => q.eq('channel', channel))
		.first();
	if (!config) return;
	await ctx.db.patch(config._id, { lastSuccessfulSend: now, updatedAt: now });
}

/**
 * Find an already-mirrored `email` row by its provider message id, scoped to a
 * direction. The idempotency seam for the two email mirror helpers
 * (`recordInboundMirror` inbound, `mirrorEmailSendWrite` outbound): re-delivery of an
 * inbound or a retried `onComplete` of an outbound must not append a duplicate
 * timeline row. Returns null when no `externalMessageId` is known — without a
 * stable key there is nothing to dedupe on, so the caller inserts.
 */
async function findMirroredEmail(
	ctx: MutationCtx,
	args: {
		externalMessageId: string | undefined;
		channel: Doc<'unifiedMessages'>['channel'];
		direction: Doc<'unifiedMessages'>['direction'];
	}
): Promise<Doc<'unifiedMessages'> | null> {
	if (!args.externalMessageId) return null;
	const id = args.externalMessageId;
	const matches = await ctx.db
		.query('unifiedMessages')
		.withIndex('by_external_message_id', (q) => q.eq('externalMessageId', id))
		.take(10); // bounded: a provider message id maps to one mirror row per (channel, direction)
	return matches.find((m) => m.channel === args.channel && m.direction === args.direction) ?? null;
}

/**
 * Mirror an inbound message into `unifiedMessages` (idempotent). Called in the
 * same transaction as `inbox/messages.ts:receiveMessage`, so the
 * dedupe-then-insert logic lives in this plain helper. Returns the existing
 * row's id on a re-delivery.
 */
export async function recordInboundMirror(
	ctx: MutationCtx,
	args: {
		threadId: Id<'conversationThreads'>;
		channel: Doc<'unifiedMessages'>['channel'];
		contactId?: Id<'contacts'>;
		content: string;
		externalMessageId?: string;
		metadata?: string;
	}
): Promise<Id<'unifiedMessages'>> {
	// Idempotent on the provider message id: a re-delivered inbound (the
	// MTA/provider re-POSTs the same Message-ID) must not produce a second
	// timeline row. Match on (externalMessageId, channel, inbound) so an inbound
	// and its outbound reply — which never share an id — can't collide.
	const existing = await findMirroredEmail(ctx, {
		externalMessageId: args.externalMessageId,
		channel: args.channel,
		direction: 'inbound',
	});
	if (existing) return existing._id;

	return await ctx.db.insert('unifiedMessages', {
		threadId: args.threadId,
		channel: args.channel,
		direction: 'inbound',
		contactId: args.contactId,
		...(await sealUnifiedMessageContentAtWrite(args.content)),
		externalMessageId: args.externalMessageId,
		status: 'received',
		metadata: args.metadata,
		createdAt: Date.now(),
	});
}

/**
 * Mirror a confirmed outbound email into `unifiedMessages` (idempotent). Called
 * in the same transaction as the Send lifecycle's `agent_reply` success branch.
 * Returns the existing row's id when completion fires more than once for the
 * same Send.
 */
export async function mirrorEmailSendWrite(
	ctx: MutationCtx,
	args: {
		threadId: Id<'conversationThreads'>;
		contactId: Id<'contacts'>;
		subject?: string;
		textBody?: string;
		htmlBody?: string;
		externalMessageId?: string;
		status?: Doc<'unifiedMessages'>['status'];
	}
): Promise<Id<'unifiedMessages'>> {
	const existing = await findMirroredEmail(ctx, {
		externalMessageId: args.externalMessageId,
		channel: 'email',
		direction: 'outbound',
	});
	if (existing) return existing._id;

	const content = JSON.stringify({
		text: args.textBody,
		html: args.htmlBody,
		subject: args.subject,
	});

	const now = Date.now();
	const status = args.status ?? 'sent';
	const id = await ctx.db.insert('unifiedMessages', {
		threadId: args.threadId,
		channel: 'email',
		direction: 'outbound',
		contactId: args.contactId,
		...(await sealUnifiedMessageContentAtWrite(content)),
		externalMessageId: args.externalMessageId,
		status,
		createdAt: now,
	});

	// Email is the primary, default channel on the dashboard card, but its
	// outbound rows flow through here (not insertOutboundMessage), so stamp the live
	// 'Last Successful Send' signal on a confirmed send. Only on this insert
	// branch — past the idempotent dedupe early-return above — so a re-fired
	// workpool onComplete can't back-date the stamp.
	if (status === 'sent' || status === 'delivered') {
		await stampChannelLastSuccessfulSend(ctx, 'email', now);
	}

	return id;
}

function parseMetadata(str: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(str);
		if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
		return {};
	} catch {
		return {};
	}
}
