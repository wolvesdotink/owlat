/**
 * Mailbox search — free-text + structured query across one mailbox's messages.
 *
 * Kept apart from `mailbox/queries.ts` because it is the one read whose shape
 * is driven by the query PARSER (`parseSearchQuery` on the web side) rather
 * than by a folder/label view: its arg list, its two index branches, and its
 * post-filter chain all track the search grammar.
 *
 * Siblings: `mailbox/identity.ts` (CRUD + provisioning), `mailbox/queries.ts`
 * (list views), `mailbox/messages.ts` (single-message reads).
 */

import { v } from 'convex/values';
import { publicQuery } from '../../lib/authedFunctions';
import type { Id } from '../../_generated/dataModel';
import { loadReadableMailbox } from '../permissions';
import type { FolderRole } from './shared';

/**
 * Free-text + structured search across messages in a mailbox.
 *
 * Keyset-paginated: pass `nextCursor` from the previous response to walk past
 * the first page (the pre-pagination implementation silently capped at 200
 * rows with no way to reach deeper matches). Post-filters that the search
 * index can't express (`from:`/`to:`/`subject:` substrings, label, date range)
 * shrink a page but never invalidate its cursor — rows are consumed, not
 * skipped, so continuation stays complete.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const search = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		// Pre-parsed query payload; the web side calls
		// `parseSearchQuery(rawText)` before calling us so the parser
		// stays close to the UI.
		text: v.string(),
		// Quoted runs from the raw query ("exact phrase"). Their words are also in
		// `text`, so the search index still does the indexed narrowing; these
		// additionally require ADJACENCY, which a token index cannot express.
		// Already lowercased by the parser.
		phrases: v.optional(v.array(v.string())),
		from: v.optional(v.string()),
		to: v.optional(v.string()),
		subject: v.optional(v.string()),
		hasAttachment: v.optional(v.boolean()),
		flagSeen: v.optional(v.boolean()),
		flagFlagged: v.optional(v.boolean()),
		folderRole: v.optional(v.string()),
		labelName: v.optional(v.string()),
		beforeMs: v.optional(v.number()),
		afterMs: v.optional(v.number()),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return { messages: [], hasMore: false, nextCursor: null };

		// Resolve folder if `in:role` was specified
		let folderId: Id<'mailFolders'> | undefined;
		if (args.folderRole) {
			const folder = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('role', args.folderRole as FolderRole)
				)
				.first();
			folderId = folder?._id;
			if (!folderId) return { messages: [], hasMore: false, nextCursor: null };
		}

		// Resolve label by name
		let labelId: Id<'mailLabels'> | undefined;
		if (args.labelName) {
			const label = await ctx.db
				.query('mailLabels')
				.withIndex('by_mailbox_and_name', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('name', args.labelName as string)
				)
				.first();
			labelId = label?._id;
			if (!labelId) return { messages: [], hasMore: false, nextCursor: null };
		}

		const limit = Math.min(args.limit ?? 50, 200);

		// Both branches paginate natively: the text branch over the search index,
		// the no-text branch over the arrival index. The page may shrink below
		// `limit` after the post-filter; the cursor still marks the true scan
		// position, so "Load more" never skips or repeats a row.
		const page = args.text
			? await ctx.db
					.query('mailMessages')
					.withSearchIndex('search_messages', (q) => {
						let filtered = q.search('snippet', args.text).eq('mailboxId', args.mailboxId);
						if (folderId) filtered = filtered.eq('folderId', folderId);
						// `from` is a partial token (e.g. "sara"), not a full address, so it
						// can't use the search index's exact .eq('fromAddress') — the substring
						// post-filter below handles it for both the text and no-text branches.
						if (args.flagSeen !== undefined) filtered = filtered.eq('flagSeen', args.flagSeen);
						if (args.flagFlagged !== undefined)
							filtered = filtered.eq('flagFlagged', args.flagFlagged);
						return filtered;
					})
					.paginate({ cursor: args.cursor ?? null, numItems: limit })
			: await ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
					.order('desc')
					.paginate({ cursor: args.cursor ?? null, numItems: limit });

		// Final filters that the search index couldn't express
		const filtered = page.page.filter((m) => {
			if (folderId && m.folderId !== folderId) return false;
			if (args.from && !m.fromAddress.includes(args.from)) return false;
			if (args.to && !m.toAddresses.some((a) => a.includes(args.to as string))) return false;
			if (args.subject && !m.subject.toLowerCase().includes(args.subject)) return false;
			// Every quoted phrase must appear verbatim in the subject or the
			// snippet — the two fields the caller can actually see in a result row.
			if (args.phrases && args.phrases.length > 0) {
				const haystack = `${m.subject}\n${m.snippet}`.toLowerCase();
				if (!args.phrases.every((phrase) => haystack.includes(phrase))) return false;
			}
			if (args.hasAttachment !== undefined && m.hasAttachments !== args.hasAttachment) return false;
			if (args.flagSeen !== undefined && m.flagSeen !== args.flagSeen) return false;
			if (args.flagFlagged !== undefined && m.flagFlagged !== args.flagFlagged) return false;
			if (labelId && !m.labelIds.includes(labelId)) return false;
			if (args.beforeMs !== undefined && m.receivedAt >= args.beforeMs) return false;
			if (args.afterMs !== undefined && m.receivedAt <= args.afterMs) return false;
			return true;
		});

		return {
			messages: filtered,
			hasMore: !page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
