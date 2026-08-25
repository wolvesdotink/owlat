/**
 * Single-message reads for the Postbox reader — one message by id, its thread,
 * the team-inbox "last reply" state, and the lazily-served body/raw blobs.
 *
 * Access is enforced in-handler via the shared readable-mailbox gate, so an
 * anonymous or unauthorised caller gets `null` rather than an error.
 *
 * Siblings: `mailbox/identity.ts` (CRUD + provisioning), `mailbox/queries.ts`
 * (list views), `mailbox/search.ts`.
 */

import { v } from 'convex/values';
import { openMailMessageInlineBody } from '../../lib/messageBody';
import { sealedBlobUrl } from '../../lib/sealedBlob';
import { internalQuery, type QueryCtx } from '../../_generated/server';
import { publicAction, publicQuery } from '../../lib/authedFunctions';
import type { Id, Doc } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { requireMessageAccess, loadReadableMailbox } from '../permissions';

/**
 * Load a message the caller is allowed to READ (owner/admin, or the mailbox
 * owner) on an active mailbox, else null. Single read-authz predicate shared by
 * the by-id message queries; mailbox ownership + `status === 'active'` flow
 * through the canonical {@link loadReadableMailbox} so a suspended/deleted
 * mailbox can't be read by id.
 */
async function loadReadableMessage(
	ctx: QueryCtx,
	messageId: Id<'mailMessages'>
): Promise<Doc<'mailMessages'> | null> {
	const message = await ctx.db.get(messageId);
	if (!message) return null;
	const mailbox = await loadReadableMailbox(ctx, message.mailboxId);
	if (!mailbox) return null;
	return message;
}

/**
 * Single message by id (ownership-checked). Backs the reader's deep-link
 * fallback: opening a bookmark/notification/search link to a message that
 * isn't in the currently-loaded list page would otherwise render blank.
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const getMessage = publicQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		return loadReadableMessage(ctx, args.messageId);
	},
});

/** Fetch all messages in a thread (oldest first). Used by the conversation view. */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listThreadMessages = publicQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const seed = await ctx.db.get(args.messageId);
		if (!seed) return null;
		const mailbox = await loadReadableMailbox(ctx, seed.mailboxId);
		if (!mailbox) return null;
		const siblings = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', seed.threadId))
			.collect(); // bounded: one thread's messages
		siblings.sort((a, b) => a.receivedAt - b.receivedAt);
		const labels = await ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', seed.mailboxId))
			.collect(); // bounded: one mailbox's labels
		const labelMap = new Map(labels.map((l) => [l._id, l]));
		const thread = await ctx.db.get(seed.threadId);
		return {
			thread,
			messages: siblings,
			labels: Array.from(labelMap.values()),
		};
	},
});

/**
 * Team-inbox collision safety. Given any message in a thread, return the
 * thread's newest OUTBOUND reply — who sent it and when — so the reader can
 * show "last reply by …" and the composer can warn a second teammate before
 * they send a duplicate. Returns null for a personal mailbox (scope !==
 * 'shared'), so both the badge and the stale-reply guard are inert on personal
 * mail and its behaviour is unchanged. Access is enforced via the shared
 * readable-mailbox gate; the display name comes from the sender's `userProfiles`
 * row (single-org-per-deployment).
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const latestReplyState = publicQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		// One message-keyed access check — yields the mailbox, the message, and the
		// caller's userId (for `byIsYou`) at the single choke point.
		const access = await requireMessageAccess(ctx, args.messageId);
		if (!access.ok) return null;
		// Personal mailbox → no team collisions to guard against.
		if (access.mailbox.scope !== 'shared') return null;
		const thread = await ctx.db.get(access.message.threadId);
		const latest = thread?.latestReply;
		if (!latest) return null;
		let byName: string | null = null;
		if (latest.byUserId) {
			const byUserId = latest.byUserId;
			const profile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', byUserId))
				.first();
			byName = profile?.name ?? profile?.email ?? null;
		}
		return {
			messageId: latest.messageId,
			at: latest.at,
			byName,
			byIsYou: !!latest.byUserId && latest.byUserId === access.userId,
			// Send-as marker: the latest reply went out under the teammate's own
			// personal address (its copy lives in their mailbox, not this thread).
			isFromPersonalAddress: latest.isFromPersonalAddress === true,
		};
	},
});

/**
 * Resolve a single message's body for the reader. Small bodies are stored
 * inline on the row; bodies over the inline threshold (newsletters, long
 * threads) live in storage blobs (`htmlBodyStorageId` / `textBodyStorageId`)
 * and are fetched lazily via the returned signed URLs — previously they had no
 * inline value and rendered blank.
 */
type ReadableMessageBodySource = {
	htmlInline: string | null;
	textInline: string | null;
	htmlBodyStorageId: Id<'_storage'> | null;
	textBodyStorageId: Id<'_storage'> | null;
} | null;

export const getReadableMessageBodySource = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<ReadableMessageBodySource> => {
		const message = await loadReadableMessage(ctx, args.messageId);
		if (!message) return null;
		const { text, html } = await openMailMessageInlineBody(message);
		return {
			htmlInline: html ?? null,
			textInline: text ?? null,
			htmlBodyStorageId: message.htmlBodyStorageId ?? null,
			textBodyStorageId: message.textBodyStorageId ?? null,
		};
	},
});

type ReadableMessageBody = {
	htmlInline: string | null;
	textInline: string | null;
	htmlUrl: string | null;
	textUrl: string | null;
} | null;

// public: soft-auth — internal source query returns null for anonymous and enforces mailbox access
export const getMessageBody = publicAction({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<ReadableMessageBody> => {
		const source: ReadableMessageBodySource = await ctx.runQuery(
			internal.mail.mailbox.messages.getReadableMessageBodySource,
			args
		);
		if (!source) return null;
		// E8b: the over-threshold body blobs are sealed at rest, so hand the reader
		// a decrypt-serving proxy URL. Action storage can inspect a keyless blob
		// before minting a direct legacy-plaintext URL, so key loss fails closed.
		return {
			htmlInline: source.htmlInline,
			textInline: source.textInline,
			htmlUrl: source.htmlBodyStorageId
				? await sealedBlobUrl(ctx.storage, source.htmlBodyStorageId, 'text/html; charset=utf-8')
				: null,
			textUrl: source.textBodyStorageId
				? await sealedBlobUrl(ctx.storage, source.textBodyStorageId, 'text/plain; charset=utf-8')
				: null,
		};
	},
});

/**
 * Signed URL for a message's raw .eml. The reader fetches it to extract an
 * attachment client-side (the attachment bytes live in the raw MIME) and for
 * "download original". Ownership-checked.
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const getReadableMessageRawStorageId = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<Id<'_storage'> | null> => {
		const message = await loadReadableMessage(ctx, args.messageId);
		return message?.rawStorageId ?? null;
	},
});

// public: soft-auth — internal source query returns null for anonymous and enforces mailbox access
export const getMessageRawUrl = publicAction({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<string | null> => {
		const storageId: Id<'_storage'> | null = await ctx.runQuery(
			internal.mail.mailbox.messages.getReadableMessageRawStorageId,
			args
		);
		if (!storageId) return null;
		// E8b: the raw `.eml` is sealed at rest; serve it through the decrypt proxy
		// so the reader's client-side attachment extraction / "download original"
		// receives the plaintext RFC822 bytes.
		return await sealedBlobUrl(ctx.storage, storageId, 'message/rfc822');
	},
});
