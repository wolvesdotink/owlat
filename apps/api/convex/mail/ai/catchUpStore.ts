/**
 * The cache behind Answer mode's catch-up card for Postbox threads: the
 * non-'use node' half of mail/ai/catchUp.ts, since an action cannot touch the
 * database itself. The table and the visibility rule are shared with the team
 * twin, inbox/catchUpStore.ts.
 *
 *   - {@link get}: the reactive read the card subscribes to, so a warm card
 *     paints without an action round trip. Serves a row only while its
 *     `messageCount` matches the live thread; a new message flips it to null,
 *     which is the web's cue to call `ensure`.
 *   - {@link readForMessage}: the same check for the actions, plus what they
 *     need to regenerate (the owner's address, the live count, the AI flag).
 *   - {@link store}: the writer (the team twin lives in inbox/catchUpStore.ts).
 *
 * Advisory and fail-soft like the reader's summary strip (mail/ai/summaryCache.ts):
 * nothing here moves or changes mail.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { publicQuery } from '../../lib/authedFunctions';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { catchUpValidator } from '../../lib/validators/catchUp';
import { loadReadableMailbox } from '../permissions';
import { normalizeCatchUpLocale, visibleCatchUp, type CatchUp } from './catchUpPrompt';

export const catchUpModeValidator = v.union(v.literal('full'), v.literal('asksOnly'));

/** The cached row for a Postbox thread in one locale, fresh or not. */
export async function loadMailCatchUpRow(
	ctx: Pick<QueryCtx, 'db'>,
	threadId: Id<'mailThreads'>,
	locale: string
): Promise<Doc<'threadCatchUps'> | null> {
	return ctx.db
		.query('threadCatchUps')
		.withIndex('by_mail_thread_and_locale', (q) =>
			q.eq('mailThreadId', threadId).eq('locale', locale)
		)
		.first();
}

/** The message's thread and mailbox, when the caller may read them. */
async function readableThread(
	ctx: QueryCtx,
	messageId: Id<'mailMessages'>
): Promise<{ thread: Doc<'mailThreads'>; mailbox: Doc<'mailboxes'> } | null> {
	const seed = await ctx.db.get(messageId);
	if (!seed) return null;
	const mailbox = await loadReadableMailbox(ctx, seed.mailboxId);
	if (!mailbox) return null;
	const thread = await ctx.db.get(seed.threadId);
	return thread ? { thread, mailbox } : null;
}

// public: soft-auth — returns null for anonymous; mailbox access is enforced
// in-handler via loadReadableMailbox (null for a non-member). A row is served
// only while it matches the live messageCount and the `ai` flag is on.
export const get = publicQuery({
	args: { messageId: v.id('mailMessages'), locale: v.string() },
	handler: async (ctx, args): Promise<CatchUp | null> => {
		// authz: readableThread gates on loadReadableMailbox (null for a non-reader).
		const readable = await readableThread(ctx, args.messageId);
		if (!readable) return null;
		if (!(await isFeatureEnabled(ctx, 'ai'))) return null;
		const row = await loadMailCatchUpRow(
			ctx,
			readable.thread._id,
			normalizeCatchUpLocale(args.locale)
		);
		if (!row || row.messageCount !== readable.thread.messageCount) return null;
		return visibleCatchUp(row);
	},
});

/**
 * Everything `ensure` and `coverage` need before they spend a model call, read
 * under the calling user's auth (an action's `runQuery` carries it). Null when
 * the caller cannot read the message. `cached` is the row only when it is
 * fresh, so a caller never serves a stale card.
 */
export const readForMessage = internalQuery({
	args: { messageId: v.id('mailMessages'), locale: v.string() },
	handler: async (ctx, args) => {
		const readable = await readableThread(ctx, args.messageId);
		if (!readable) return null;
		const { thread, mailbox } = readable;
		const [aiEnabled, row] = await Promise.all([
			isFeatureEnabled(ctx, 'ai'),
			loadMailCatchUpRow(ctx, thread._id, args.locale),
		]);
		return {
			threadId: thread._id,
			ownerAddress: mailbox.address,
			messageCount: thread.messageCount,
			aiEnabled,
			cached: row && row.messageCount === thread.messageCount ? row : null,
		};
	},
});

/**
 * Write a freshly generated card for a Postbox thread, replacing whatever the
 * thread had in the same locale (the team twin is inbox/catchUpStore.ts).
 * Internal-only: its caller has already checked the reader and the AI gate.
 */
export const store = internalMutation({
	args: {
		mailThreadId: v.id('mailThreads'),
		mode: catchUpModeValidator,
		catchUp: catchUpValidator,
	},
	handler: async (ctx, args) => {
		const { mailThreadId, mode, catchUp } = args;
		const existing = await loadMailCatchUpRow(ctx, mailThreadId, catchUp.locale);
		if (existing) {
			await ctx.db.patch(existing._id, { mode, ...catchUp });
			return;
		}
		await ctx.db.insert('threadCatchUps', { mailThreadId, mode, ...catchUp });
	},
});
