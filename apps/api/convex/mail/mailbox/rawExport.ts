/**
 * "Download all my mail" (idea 50) — the paged raw-message read behind it.
 *
 * The reader has always been able to save ONE message's original bytes
 * (`messages.getMessageRawUrl`). This is the same read over a whole mailbox, in
 * arrival order, one page at a time: the browser walks the pages, fetches each
 * signed URL, and appends the message to an mbox archive it streams straight to
 * disk (`apps/web/app/utils/mboxExport.ts`). Nothing is assembled server-side,
 * so a mailbox larger than any process's memory still exports.
 *
 * A page is deliberately small. Every entry mints a signed URL to a sealed
 * blob, and a page is the unit of work the client re-requests if a fetch fails
 * partway through; 25 keeps both the URL burst and the retry cheap.
 *
 * Access is the same gate the single-message read uses: `loadReadableMailbox`
 * in the internal query, so an anonymous or unauthorised caller gets an empty
 * page rather than a mailbox dump.
 */

import { v } from 'convex/values';
import { sealedBlobUrl } from '../../lib/sealedBlob';
import { internalQuery } from '../../_generated/server';
import { publicAction } from '../../lib/authedFunctions';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { loadReadableMailbox } from '../permissions';

/** Messages per page. */
export const RAW_EXPORT_PAGE_SIZE = 25;

type RawExportRow = {
	messageId: Id<'mailMessages'>;
	rawStorageId: Id<'_storage'>;
	fromAddress: string;
	receivedAt: number;
};

type RawExportPage = {
	page: RawExportRow[];
	continueCursor: string;
	isDone: boolean;
};

/**
 * One arrival-ordered page of the caller's mail, as storage ids.
 *
 * OLDEST FIRST, unlike every list view: an mbox is read top to bottom by the
 * client that imports it, and a chronological archive is what every other mail
 * program writes.
 */
export const listRawMessagePage = internalQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<RawExportPage> => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return { page: [], continueCursor: '', isDone: true };
		const result = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.order('asc')
			.paginate({ cursor: args.cursor ?? null, numItems: RAW_EXPORT_PAGE_SIZE });
		return {
			page: result.page.map((message) => ({
				messageId: message._id,
				rawStorageId: message.rawStorageId,
				fromAddress: message.fromAddress,
				receivedAt: message.receivedAt,
			})),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

/**
 * The same page with each message's raw `.eml` resolved to a signed URL.
 *
 * An action rather than a query because the raw bytes are sealed at rest and
 * the URL comes from the decrypt proxy — the same reason `getMessageRawUrl` is
 * one.
 */
// public: soft-auth — the internal source query returns an empty page for anonymous callers and enforces mailbox access
export const listRawMessageUrls = publicAction({
	args: {
		mailboxId: v.id('mailboxes'),
		cursor: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{
		messages: Array<{ url: string; fromAddress: string; receivedAt: number }>;
		continueCursor: string;
		isDone: boolean;
	}> => {
		const result: RawExportPage = await ctx.runQuery(
			internal.mail.mailbox.rawExport.listRawMessagePage,
			args
		);
		const messages = [];
		for (const row of result.page) {
			// A message whose blob has gone (a storage purge mid-export) is skipped
			// rather than failing the whole download.
			const url = await sealedBlobUrl(ctx.storage, row.rawStorageId, 'message/rfc822').catch(
				() => null
			);
			if (!url) continue;
			messages.push({ url, fromAddress: row.fromAddress, receivedAt: row.receivedAt });
		}
		return { messages, continueCursor: result.continueCursor, isDone: result.isDone };
	},
});
