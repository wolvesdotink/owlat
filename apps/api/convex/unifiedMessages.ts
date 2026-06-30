/**
 * Unified Messages
 *
 * Central module for sending, receiving, and querying messages
 * across all channels (email, SMS, WhatsApp, webhook, chat).
 * Provides a unified timeline view per thread and per contact.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation, internalAction } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission, getBetterAuthSessionWithRole, hasPermission } from './lib/sessionOrganization';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { unifiedMessageChannelValidator, outboundChannelValidator } from './lib/convexValidators';
import { applyOpenThreadDelta } from './lib/inboxStats';


// ============================================================
// Queries
// ============================================================

/**
 * Get messages for a conversation thread (unified timeline)
 */
export const getThreadTimeline = authedQuery({
	args: {
		threadId: v.id('conversationThreads'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// Reads shared-inbox conversation content — owner/admin only, matching
		// the shared-inbox access policy enforced in inbox/queries.ts. Without
		// this, any logged-in member could read inbound customer messages.
		await requireOrgPermission(ctx, 'organization:manage');

		const messages = await ctx.db
			.query('unifiedMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('asc')
			.take(args.limit ?? 100);

		return messages.map((msg) => ({
			...msg,
			content: parseContent(msg.content),
			metadata: msg.metadata ? parseMetadata(msg.metadata) : undefined,
		}));
	},
});

/**
 * Get messages for a contact across all channels
 */
export const getContactTimeline = authedQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// Reads shared-inbox conversation content — owner/admin only (see
		// getThreadTimeline). The customer-facing contact timeline UI uses
		// contacts.timeline.getTimeline, not this query.
		await requireOrgPermission(ctx, 'organization:manage');

		const messages = await ctx.db
			.query('unifiedMessages')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.order('desc')
			.take(args.limit ?? 50);

		return messages.map((msg) => ({
			...msg,
			content: parseContent(msg.content),
			metadata: msg.metadata ? parseMetadata(msg.metadata) : undefined,
		}));
	},
});

/**
 * Get recent messages across all channels
 */
export const listRecent = authedQuery({
	args: {
		channel: v.optional(unifiedMessageChannelValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// Reads shared-inbox conversation content across ALL threads/contacts —
		// owner/admin only, same policy as getThreadTimeline/getContactTimeline.
		await requireOrgPermission(ctx, 'organization:manage');

		let q;
		if (args.channel) {
			q = ctx.db
				.query('unifiedMessages')
				.withIndex('by_channel', (q2) => q2.eq('channel', args.channel!));
		} else {
			q = ctx.db
				.query('unifiedMessages')
				.withIndex('by_created_at');
		}

		const messages = await q.order('desc').take(args.limit ?? 50);

		return messages.map((msg) => ({
			...msg,
			content: parseContent(msg.content),
			metadata: msg.metadata ? parseMetadata(msg.metadata) : undefined,
		}));
	},
});

/**
 * Get channel configuration and health status
 */
export const getChannelConfigs = authedQuery({
	args: {},
	handler: async (ctx) => {
		// all-members: health/display fields feed the dashboard channel card.
		// The encrypted credential envelope (config) is admin-only — members
		// get the row WITHOUT it; the settings page (admin) gets it for the
		// edit form.
		const rows = await ctx.db.query('channelConfigs').collect();
		const session = await getBetterAuthSessionWithRole(ctx);
		const isAdmin = session?.role != null && hasPermission(session.role, 'organization:manage');
		if (isAdmin) return rows;
		return rows.map((row) => ({ ...row, config: undefined }));
	},
});

/**
 * Get a single channel config
 */
export const getChannelConfig = authedQuery({
	args: {
		channel: unifiedMessageChannelValidator,
	},
	handler: async (ctx, args) => {
		// Returns the encrypted credential envelope — same admin policy as
		// updateChannelConfig.
		await requireOrgPermission(ctx, 'organization:manage');
		return await ctx.db
			.query('channelConfigs')
			.withIndex('by_channel', (q) => q.eq('channel', args.channel))
			.first();
	},
});

// ============================================================
// Mutations
// ============================================================

/**
 * Record an inbound message from any channel
 */
export const recordInbound = internalMutation({
	args: {
		threadId: v.id('conversationThreads'),
		channel: unifiedMessageChannelValidator,
		contactId: v.optional(v.id('contacts')),
		content: v.string(),
		externalMessageId: v.optional(v.string()),
		metadata: v.optional(v.string()),
	},
	handler: async (ctx, args) => recordInboundMirror(ctx, args),
});

/**
 * Record an outbound message from any channel
 */
export const recordOutbound = internalMutation({
	args: {
		threadId: v.id('conversationThreads'),
		channel: unifiedMessageChannelValidator,
		contactId: v.optional(v.id('contacts')),
		memberId: v.optional(v.string()),
		content: v.string(),
		externalMessageId: v.optional(v.string()),
		status: v.optional(v.union(
			v.literal('queued'),
			v.literal('sent'),
			v.literal('delivered'),
			v.literal('failed')
		)),
		metadata: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const id = await ctx.db.insert('unifiedMessages', {
			threadId: args.threadId,
			channel: args.channel,
			direction: 'outbound',
			contactId: args.contactId,
			memberId: args.memberId,
			content: args.content,
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

		return id;
	},
});

/**
 * Update delivery status of an outbound message. Called by the channel
 * delivery-status poller (`channels.outbound.pollDeliveryStatus`) after it
 * reads the provider's current status for a `sent` channel message.
 */
export const updateDeliveryStatus = internalMutation({
	args: {
		messageId: v.id('unifiedMessages'),
		status: v.union(
			v.literal('sent'),
			v.literal('delivered'),
			v.literal('read'),
			v.literal('failed')
		),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.messageId, { status: args.status });
	},
});

/** A `sent` channel message awaiting a delivered/read/failed transition. */
const pendingDeliveryValidator = v.object({
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
export const listPendingDeliveryStatus = internalQuery({
	args: {
		sinceMs: v.number(),
		limit: v.number(),
	},
	returns: v.array(pendingDeliveryValidator),
	handler: async (ctx, args) => {
		const cutoff = Date.now() - args.sinceMs;
		const rows = await ctx.db
			.query('unifiedMessages')
			.withIndex('by_direction_status_and_created_at', (q) =>
				q.eq('direction', 'outbound').eq('status', 'sent').gte('createdAt', cutoff),
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
	},
});

/**
 * Send a chat message (user-facing, authenticated)
 */
export const sendChatMessage = authedMutation({
	args: {
		threadId: v.id('conversationThreads'),
		text: v.string(),
		contactId: v.optional(v.id('contacts')),
	},
	handler: async (ctx, args) => {
		// Conversation threads are the shared customer inbox (admin-only, per the
		// inbox access policy) — sending an outbound chat message on a thread is a
		// support action, so require an owner/admin.
		await requireOrgPermission(ctx, 'organization:manage');
		const content = JSON.stringify({ text: args.text });

		const now = Date.now();
		const id = await ctx.db.insert('unifiedMessages', {
			threadId: args.threadId,
			channel: 'chat',
			direction: 'outbound',
			contactId: args.contactId,
			content,
			externalMessageId: `chat_${now}_${Math.random().toString(36).slice(2, 9)}`,
			status: 'delivered',
			createdAt: now,
		});

		// Chat is terminal on insert ('delivered'), so this row IS the
		// successful send — stamp the channel card's live signal here too.
		await stampChannelLastSuccessfulSend(ctx, 'chat', now);

		return id;
	},
});

/**
 * Update channel configuration.
 *
 * The non-secret fields (`isEnabled`, `displayName`) are written inline.
 * The credential `config` blob is NEVER written here in plaintext — this is a
 * v8 mutation and `encryptSecret` is Node-only. When a `config` is supplied we
 * schedule the Node action `channels.outbound.encryptAndPersistConfig`, which
 * wraps it in an AES-256-GCM envelope and patches the row. The
 * `channelConfigs.config` column therefore only ever holds an encrypted
 * envelope on disk (encrypt-on-write, A3). Atomic single-org policy: no dual
 * plaintext read path — `channels.outbound.dispatchOutbound` always decrypts.
 */
export const updateChannelConfig = authedMutation({
	args: {
		channel: unifiedMessageChannelValidator,
		isEnabled: v.optional(v.boolean()),
		displayName: v.optional(v.string()),
		config: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can configure channels');
		const existing = await ctx.db
			.query('channelConfigs')
			.withIndex('by_channel', (q) => q.eq('channel', args.channel))
			.first();

		const now = Date.now();
		let configId: Id<'channelConfigs'>;
		if (existing) {
			await ctx.db.patch(existing._id, {
				...(args.isEnabled !== undefined ? { isEnabled: args.isEnabled } : {}),
				...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
				updatedAt: now,
			});
			configId = existing._id;
		} else {
			configId = await ctx.db.insert('channelConfigs', {
				channel: args.channel,
				isEnabled: args.isEnabled ?? false,
				displayName: args.displayName,
				// config left unset until the encrypt action persists the envelope.
				createdAt: now,
				updatedAt: now,
			});
		}

		// Encrypt-on-write: hand the plaintext to the Node action, which encrypts
		// and patches `config`. The plaintext never lands in the row.
		if (args.config !== undefined) {
			await ctx.scheduler.runAfter(0, internal.channels.outbound.encryptAndPersistConfig, {
				channel: args.channel,
				plaintextConfig: args.config,
			});
		}

		return configId;
	},
});

/**
 * Patch the encrypted credential envelope onto a channel config row. Sole
 * writer of the `config` column. Called only by
 * `channels.outbound.encryptAndPersistConfig` after encryption — the value is
 * always a serialized AES-256-GCM envelope, never plaintext.
 */
export const setChannelConfigSecret = internalMutation({
	args: {
		channel: unifiedMessageChannelValidator,
		config: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('channelConfigs')
			.withIndex('by_channel', (q) => q.eq('channel', args.channel))
			.first();
		// updateChannelConfig creates the row in the same mutation before
		// scheduling the encrypt action, so a missing row here means it was
		// deleted in the interim — surface that loudly rather than silently
		// dropping the credential (which would leave the channel un-sendable
		// with no signal).
		if (!existing) {
			throw new Error(`setChannelConfigSecret: no channelConfigs row for channel '${args.channel}' — encrypted credential was not persisted`);
		}
		await ctx.db.patch(existing._id, { config: args.config, updatedAt: Date.now() });
	},
});

/**
 * Internal read of a single channel config (including the encrypted `config`
 * envelope) for the Node dispatch action. Not exposed publicly — decryption
 * happens in `channels.outbound.dispatchOutbound`.
 */
export const getChannelConfigInternal = internalQuery({
	args: {
		channel: unifiedMessageChannelValidator,
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query('channelConfigs')
			.withIndex('by_channel', (q) => q.eq('channel', args.channel))
			.first();
	},
});

/**
 * Resolve the destination address/handle for a contact on a given channel,
 * for outbound dispatch (the SMS/WhatsApp `To`). Reads `contactIdentities`,
 * preferring the primary identity. `sms` maps onto the `phone` identity
 * channel. Returns null when the contact has no identity for the channel.
 */
export const getContactChannelIdentifier = internalQuery({
	args: {
		contactId: v.id('contacts'),
		channel: outboundChannelValidator,
	},
	handler: async (ctx, args): Promise<string | null> => {
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
	},
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
 */
export const resolveOutboundThread = internalMutation({
	args: {
		contactId: v.id('contacts'),
		channel: outboundChannelValidator,
	},
	returns: v.id('conversationThreads'),
	handler: async (ctx, args): Promise<Id<'conversationThreads'>> => {
		// The channel must be configured AND enabled — a disabled/unconfigured
		// channel would only ever record a `failed` row in dispatchOutbound, so
		// reject up front with a clear message for the compose UI.
		const config = await ctx.db
			.query('channelConfigs')
			.withIndex('by_channel', (q) => q.eq('channel', args.channel))
			.first();
		if (!config || !config.isEnabled) {
			throw new Error(
				`The ${args.channel} channel is not enabled. Configure and enable it in Settings → Channels first.`,
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
	},
});

/**
 * Update channel health status (called by health check cron)
 */
export const updateChannelHealth = internalMutation({
	args: {
		channel: unifiedMessageChannelValidator,
		healthStatus: v.union(
			v.literal('healthy'),
			v.literal('degraded'),
			v.literal('down')
		),
		lastError: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const config = await ctx.db
			.query('channelConfigs')
			.withIndex('by_channel', (q) => q.eq('channel', args.channel))
			.first();

		if (!config) return;

		await ctx.db.patch(config._id, {
			healthStatus: args.healthStatus,
			lastHealthCheckAt: Date.now(),
			...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
			updatedAt: Date.now(),
		});
	},
});

/**
 * Mirror an existing email send to the unified messages table
 * Called after successful email delivery to maintain a unified timeline
 */
export const mirrorEmailSend = internalMutation({
	args: {
		threadId: v.id('conversationThreads'),
		contactId: v.id('contacts'),
		subject: v.optional(v.string()),
		textBody: v.optional(v.string()),
		htmlBody: v.optional(v.string()),
		externalMessageId: v.optional(v.string()),
		status: v.optional(
			v.union(
				v.literal('received'),
				v.literal('queued'),
				v.literal('sent'),
				v.literal('delivered'),
				v.literal('read'),
				v.literal('failed')
			)
		),
	},
	handler: async (ctx, args) => mirrorEmailSendWrite(ctx, args),
});

// ============================================================
// Channel Health Check Action (called by cron)
// ============================================================

/**
 * Run health checks on all enabled channels
 */
export const runChannelHealthChecks = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const configs = await ctx.runQuery(internal.unifiedMessages.getEnabledChannels);

		for (const config of configs) {
			try {
				// Email/chat have no outbound provider adapter here (email health
				// is tracked by the existing providerHealth system; chat is native),
				// so config-presence is the only available signal.
				if (config.channel === 'email' || config.channel === 'chat') {
					await ctx.runMutation(internal.unifiedMessages.updateChannelHealth, {
						channel: config.channel,
						healthStatus: 'healthy',
					});
					continue;
				}

				// For SMS/WhatsApp/Webhook: fast-path the unconfigured case, then
				// run the adapter's REAL healthCheck() probe (Twilio/Meta/webhook)
				// for configured channels. The probe needs node:crypto to decrypt
				// the stored creds, so it lives in a `'use node'` action — a channel
				// with revoked/invalid credentials surfaces degraded/down instead of
				// reporting healthy off mere config-blob presence.
				if (!config.config) {
					await ctx.runMutation(internal.unifiedMessages.updateChannelHealth, {
						channel: config.channel,
						healthStatus: 'down',
						lastError: 'No credentials configured',
					});
					continue;
				}

				await ctx.runAction(internal.channels.outbound.probeChannelHealth, {
					channel: config.channel,
				});
			} catch (error) {
				await ctx.runMutation(internal.unifiedMessages.updateChannelHealth, {
					channel: config.channel,
					healthStatus: 'down',
					lastError: error instanceof Error ? error.message : String(error),
				});
			}
		}
	},
});

/**
 * Internal query to get enabled channel configs
 */
export const getEnabledChannels = internalQuery({
	args: {},
	handler: async (ctx) => {
		// `channelConfigs` is intrinsically tiny — one row per channel
		// kind (email/sms/whatsapp/generic/chat), capped by the union
		// literal in the schema. Indexing would add maintenance cost for
		// no read win at this scale.
		const all = await ctx.db.query('channelConfigs').collect(); // bounded: ≤5 rows by schema literal union
		return all.filter((c) => c.isEnabled);
	},
});

// ============================================================
// Helpers
// ============================================================

/**
 * Stamp `lastSuccessfulSend` (and `updatedAt`) onto a channel's `channelConfigs`
 * row. The sole writer of that field — it has no other source, so the dashboard
 * channel card's "Last Successful Send" stat renders "Never" until this runs.
 *
 * Called from every successful-send writer, not just `recordOutbound`: the
 * SMS/WhatsApp/generic path (recordOutbound, `sent`), the email path
 * (mirrorEmailSendWrite, `sent`/`delivered`, which is how the highest-volume
 * default channel records outbound — it never goes through recordOutbound), and
 * chat (sendChatMessage, terminal `delivered`). A no-op when the channel has no
 * config row (nothing to stamp).
 */
async function stampChannelLastSuccessfulSend(
	ctx: MutationCtx,
	channel: Doc<'channelConfigs'>['channel'],
	now: number,
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
 * direction. The idempotency seam for the two email mirror writers
 * (`recordInbound` inbound, `mirrorEmailSend` outbound): re-delivery of an
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
	},
): Promise<Doc<'unifiedMessages'> | null> {
	if (!args.externalMessageId) return null;
	const id = args.externalMessageId;
	const matches = await ctx.db
		.query('unifiedMessages')
		.withIndex('by_external_message_id', (q) => q.eq('externalMessageId', id))
		.take(10); // bounded: a provider message id maps to one mirror row per (channel, direction)
	return (
		matches.find(
			(m) => m.channel === args.channel && m.direction === args.direction,
		) ?? null
	);
}

/**
 * Mirror an inbound message into `unifiedMessages` (idempotent). Shared by the
 * `recordInbound` internalMutation and the in-transaction call site in
 * `inbox/messages.ts:receiveMessage` — a Convex mutation can't `ctx.runMutation`
 * a sibling mutation, so the dedupe-then-insert logic lives in this plain helper
 * both can call. Returns the existing row's id on a re-delivery.
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
	},
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
		content: args.content,
		externalMessageId: args.externalMessageId,
		status: 'received',
		metadata: args.metadata,
		createdAt: Date.now(),
	});
}

/**
 * Mirror a confirmed outbound email into `unifiedMessages` (idempotent). Shared
 * by the `mirrorEmailSend` internalMutation and the in-transaction call site in
 * `delivery/sendCompletion.ts` (the `agent_reply` success branch). Returns the
 * existing row's id when the workpool `onComplete` fires more than once for the
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
	},
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
		content,
		externalMessageId: args.externalMessageId,
		status,
		createdAt: now,
	});

	// Email is the primary, default channel on the dashboard card, but its
	// outbound rows flow through here (not recordOutbound), so stamp the live
	// 'Last Successful Send' signal on a confirmed send. Only on this insert
	// branch — past the idempotent dedupe early-return above — so a re-fired
	// workpool onComplete can't back-date the stamp.
	if (status === 'sent' || status === 'delivered') {
		await stampChannelLastSuccessfulSend(ctx, 'email', now);
	}

	return id;
}

/** Parsed shape of the `content` JSON blob (see schema comment). */
interface UnifiedMessageContent {
	text?: string;
	html?: string;
	subject?: string;
	mediaUrl?: string;
}

function parseContent(str: string): UnifiedMessageContent {
	try {
		const parsed: unknown = JSON.parse(str);
		if (parsed && typeof parsed === 'object') return parsed as UnifiedMessageContent;
		return { text: str };
	} catch {
		return { text: str };
	}
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
