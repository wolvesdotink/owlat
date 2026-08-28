/**
 * The Files view's read — a browse over `mailAttachments`, one mailbox at a
 * time.
 *
 * Kept apart from `mailbox/search.ts` because the unit is an ATTACHMENT, not a
 * message: the list is newest-file-first (a two-year-old thread that got a new
 * PDF today sorts by the PDF), the facets are file facets (kind, sender, date),
 * and the row carries just enough of its parent message (subject, folder) for
 * the Files view to label it and open it.
 *
 * Siblings: `mailbox/queries.ts` (list views), `mailbox/search.ts` (query
 * grammar), `mailbox/messages.ts` (single-message reads).
 */

import { v } from 'convex/values';
import { publicQuery } from '../../lib/authedFunctions';
import type { Doc, Id } from '../../_generated/dataModel';
import { loadReadableMailbox } from '../permissions';
import { attachmentKind, type AttachmentKind } from '../attachmentIndex';

/** The coarse type facet, as the wire spells it. */
const attachmentKindValidator = v.union(
	v.literal('pdf'),
	v.literal('image'),
	v.literal('document'),
	v.literal('archive'),
	v.literal('other')
);

/** One Files-view row: the file, plus the message it hangs off. */
export interface AttachmentListRow {
	_id: Id<'mailAttachments'>;
	messageId: Id<'mailMessages'>;
	filename: string;
	contentType: string;
	kind: AttachmentKind;
	size: number;
	receivedAt: number;
	fromAddress: string;
	fromName?: string;
	subject: string;
	partIndex: string;
}

/** Hard cap on one page, matching the message search. */
const MAX_LIMIT = 200;

async function decorate(
	ctx: { db: { get: (id: Id<'mailMessages'>) => Promise<Doc<'mailMessages'> | null> } },
	rows: Doc<'mailAttachments'>[]
): Promise<AttachmentListRow[]> {
	const out: AttachmentListRow[] = [];
	// One message can contribute several files; the cache keeps a five-part
	// message to one read rather than five.
	const cache = new Map<Id<'mailMessages'>, Doc<'mailMessages'> | null>();
	for (const row of rows) {
		let message = cache.get(row.messageId);
		if (message === undefined) {
			message = await ctx.db.get(row.messageId);
			cache.set(row.messageId, message);
		}
		// A junction row whose message is gone is a teardown that lost a race.
		// Skipping it here means the view never opens a file into nothing; the
		// row itself is cleaned up by whichever delete path missed it.
		if (!message) continue;
		out.push({
			_id: row._id,
			messageId: row.messageId,
			filename: row.filename,
			contentType: row.contentType,
			kind: attachmentKind(row.contentType),
			size: row.size,
			receivedAt: row.receivedAt,
			fromAddress: row.fromAddress,
			fromName: message.fromName,
			subject: message.subject,
			partIndex: row.partIndex,
		});
	}
	return out;
}

/**
 * Browse one mailbox's attachment index.
 *
 * Three narrowing paths, in the order they beat each other:
 *  - `filenameQuery` runs the `search_filenames` search index — the whole point
 *    of the junction table, and the same index `filename:` uses.
 *  - `fromAddress` runs the `by_mailbox_and_from` index.
 *  - neither runs the plain newest-first `by_mailbox_and_received` index.
 *
 * `kinds` and the date bounds are always POST-filters over the chosen scan:
 * they shrink a page without invalidating its cursor (rows are consumed, not
 * skipped), exactly like the message search's post-filter chain, so "Load
 * more" stays complete.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		/** Filename substring/prefix — the `filename:` operator's own index. */
		filenameQuery: v.optional(v.string()),
		/** Exact sender address facet (lowercased). */
		fromAddress: v.optional(v.string()),
		/** Type facet; empty/absent = every kind. */
		kinds: v.optional(v.array(attachmentKindValidator)),
		afterMs: v.optional(v.number()),
		beforeMs: v.optional(v.number()),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ files: AttachmentListRow[]; hasMore: boolean; nextCursor: string | null }> => {
		const empty = { files: [] as AttachmentListRow[], hasMore: false, nextCursor: null };
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return empty;

		const limit = Math.min(args.limit ?? 50, MAX_LIMIT);
		const term = args.filenameQuery?.trim().toLowerCase() ?? '';
		const wantedKinds = args.kinds && args.kinds.length > 0 ? new Set(args.kinds) : null;

		const page = term
			? await ctx.db
					.query('mailAttachments')
					.withSearchIndex('search_filenames', (q) =>
						q.search('filename', term).eq('mailboxId', args.mailboxId)
					)
					.paginate({ cursor: args.cursor ?? null, numItems: limit })
			: args.fromAddress
				? await ctx.db
						.query('mailAttachments')
						.withIndex('by_mailbox_and_from', (q) =>
							q.eq('mailboxId', args.mailboxId).eq('fromAddress', args.fromAddress!.toLowerCase())
						)
						.order('desc')
						.paginate({ cursor: args.cursor ?? null, numItems: limit })
				: await ctx.db
						.query('mailAttachments')
						.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
						.order('desc')
						.paginate({ cursor: args.cursor ?? null, numItems: limit });

		const filtered = page.page.filter((row) => {
			// The search index cannot express "sender is X", so the filename path
			// carries the sender facet in its post-filter instead of losing it.
			if (term && args.fromAddress && row.fromAddress !== args.fromAddress.toLowerCase()) {
				return false;
			}
			if (wantedKinds && !wantedKinds.has(attachmentKind(row.contentType))) return false;
			if (args.afterMs !== undefined && row.receivedAt <= args.afterMs) return false;
			if (args.beforeMs !== undefined && row.receivedAt >= args.beforeMs) return false;
			return true;
		});

		return {
			files: await decorate(ctx, filtered),
			hasMore: !page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

/**
 * How many distinct senders the facet list may name. The Files view offers a
 * "From" picker, not a directory — past this the sender facet is a search box's
 * job, and the scan behind it has to stay bounded.
 */
const SENDER_FACET_SCAN = 500;

/**
 * The sender facet's options: the distinct senders in the newest slice of the
 * index, with a count each, most files first.
 *
 * Derived from a bounded scan rather than a maintained aggregate — the facet is
 * a convenience over recent files, and a stale denormalized counter on every
 * attachment write would be a much worse trade than a capped read.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const senderFacets = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ address: string; count: number }[]> => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return [];
		const rows = await ctx.db
			.query('mailAttachments')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(SENDER_FACET_SCAN);
		const counts = new Map<string, number>();
		for (const row of rows) counts.set(row.fromAddress, (counts.get(row.fromAddress) ?? 0) + 1);
		return Array.from(counts, ([address, count]) => ({ address, count })).sort(
			(a, b) => b.count - a.count || a.address.localeCompare(b.address)
		);
	},
});
