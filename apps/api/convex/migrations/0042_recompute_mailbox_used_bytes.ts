/**
 * Recompute mailbox `usedBytes` from message rows (migration 0042).
 *
 * IMAP COPY historically inserted another `mailMessages` row without charging
 * its `rawSize`, while every expunge/purge decremented per row. The resulting
 * under-count is user-visible and cannot be repaired by the forward-path fix.
 * This hand-run, idempotent migration restores the RFC 2087/per-row total:
 *
 *   npx convex run migrations/0042_recompute_mailbox_used_bytes:run
 *
 * Queries are paginated at both levels. An action accumulates one mailbox's
 * bounded message pages, then a mutation publishes that mailbox's exact total.
 */

import { v } from 'convex/values';
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { logInfo } from '../lib/runtimeLog';

const PAGE_SIZE = 100;
const cursorArgs = { cursor: v.union(v.string(), v.null()) };

export const mailboxPage = internalQuery({
	args: cursorArgs,
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query('mailboxes').paginate({ numItems: PAGE_SIZE, cursor });
		return {
			mailboxIds: result.page.map((mailbox) => mailbox._id),
			cursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export const messageSizePage = internalQuery({
	args: { mailboxId: v.id('mailboxes'), ...cursorArgs },
	handler: async (ctx, { mailboxId, cursor }) => {
		const result = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
			.paginate({ numItems: PAGE_SIZE, cursor });
		return {
			bytes: result.page.reduce((sum, message) => sum + message.rawSize, 0),
			cursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export const setMailboxUsedBytes = internalMutation({
	args: { mailboxId: v.id('mailboxes'), usedBytes: v.number() },
	handler: async (ctx, { mailboxId, usedBytes }) => {
		const mailbox = await ctx.db.get(mailboxId);
		if (!mailbox) return false;
		await ctx.db.patch(mailboxId, { usedBytes, updatedAt: Date.now() });
		return true;
	},
});

async function recomputeMailbox(ctx: ActionCtx, mailboxId: Id<'mailboxes'>): Promise<boolean> {
	let cursor: string | null = null;
	let usedBytes = 0;
	for (;;) {
		const page: { bytes: number; cursor: string; isDone: boolean } = await ctx.runQuery(
			internal.migrations['0042_recompute_mailbox_used_bytes'].messageSizePage,
			{ mailboxId, cursor }
		);
		usedBytes += page.bytes;
		if (page.isDone) break;
		cursor = page.cursor;
	}
	return ctx.runMutation(
		internal.migrations['0042_recompute_mailbox_used_bytes'].setMailboxUsedBytes,
		{ mailboxId, usedBytes }
	);
}

export const run = internalAction({
	args: {},
	handler: async (ctx): Promise<{ mailboxes: number }> => {
		let cursor: string | null = null;
		let mailboxes = 0;
		for (;;) {
			const page: { mailboxIds: Id<'mailboxes'>[]; cursor: string; isDone: boolean } =
				await ctx.runQuery(internal.migrations['0042_recompute_mailbox_used_bytes'].mailboxPage, {
					cursor,
				});
			for (const mailboxId of page.mailboxIds) {
				if (await recomputeMailbox(ctx, mailboxId)) mailboxes++;
			}
			if (page.isDone) break;
			cursor = page.cursor;
		}
		logInfo('migration.0042_recompute_mailbox_used_bytes', { mailboxes });
		return { mailboxes };
	},
});
