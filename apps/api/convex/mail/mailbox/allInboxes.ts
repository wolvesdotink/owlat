/**
 * All inboxes and the unified folders (All Sent, All Archive, All Spam, All
 * Trash): one system folder of every mailbox the caller reads, as one
 * newest-first list that pages like a single folder. All Drafts is
 * `listDrafts`, since drafts are `mailDrafts` rows rather than filed messages.
 *
 * Each folder is read along its own `by_folder_and_received` index from the
 * page cursor down and the pieces are merged with the keyset rules in
 * `lib/keysetMerge.ts`: a position is `(receivedAt,
 * _creationTime, id)`, the order every source's index serves its rows in, so
 * a page boundary inside a run of equal timestamps never skips or repeats a
 * message, and no source is capped. A page reads at most a page and a scan
 * budget per mailbox, never a whole folder.
 *
 * The list is the caller's own mailboxes plus the team inboxes they are a
 * member of (`loadAccessibleMailboxes`), never a mailbox an org admin could
 * merely open: a teammate's mail must not appear in someone's unified inbox.
 */

import { v } from 'convex/values';
import { publicQuery } from '../../lib/authedFunctions';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { loadAccessibleMailboxes } from '../permissions';
import { isMessageSnoozed } from '../../lib/mailSnooze';
import { readSession } from './shared';
import { openMailDraftBody } from '../../lib/messageBody';
import { attachThreadState, type MailListRow, type RowThreadState } from './rowThreadState';
import type { SenderLogoField } from '../senderLogos/cache';
import {
	decodeStreamCursor,
	mergeStreamPage,
	rangesBefore,
	readSourceBatch,
	type SourceBatch,
	type StreamPosition,
} from '../../lib/keysetMerge';

/** More mailboxes than anyone triages from one list; bounds a page's reads. */
export const ALL_INBOXES_MAX_SOURCES = 25;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type Entry = StreamPosition & { message: Doc<'mailMessages'> };

function positionOf(message: Doc<'mailMessages'>): StreamPosition {
	return { at: message.receivedAt, tie: message._creationTime, key: `m:${message._id}` };
}

/**
 * One folder's rows before the cursor. The folder doc is not read (IMAP
 * bookkeeping patches it on every delivery and flag change, which would re-run
 * the subscribed first page); ownership is checked on the rows instead: a
 * folder belongs to one mailbox, so a row from any other mailbox means the id
 * was not that mailbox's folder, and the source then contributes nothing.
 */
async function readFolder(
	ctx: QueryCtx,
	source: { mailboxId: Id<'mailboxes'>; folderId: Id<'mailFolders'> },
	before: StreamPosition | null,
	now: number,
	limit: number
): Promise<SourceBatch<Entry>> {
	const folder = (range?: { at: number; tie?: number }) =>
		ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_received', (q) => {
				const rows = q.eq('folderId', source.folderId);
				if (!range) return rows;
				// The cursor's own `receivedAt` from its creation time down; the
				// position filter in readSourceBatch drops what the page already showed.
				if (range.tie !== undefined) {
					return rows.eq('receivedAt', range.at).lte('_creationTime', range.tie);
				}
				return rows.lt('receivedAt', range.at);
			})
			.order('desc');
	const rows = rangesBefore(before, {
		all: () => folder(),
		tied: (at, tie) => folder({ at, tie }),
		older: (at) => folder({ at }),
	});
	let foreign = false;
	const batch = await readSourceBatch(rows, {
		before,
		limit,
		// Snoozed rows stay in their folder but yield nothing, as in the
		// single-folder list; the budget keeps a long snoozed run from turning
		// one page into a folder scan.
		budget: limit * 2,
		positionOf,
		toEntries: (message) => {
			if (message.mailboxId !== source.mailboxId) foreign = true;
			if (foreign || isMessageSnoozed(message, now)) return [];
			return [{ ...positionOf(message), message }];
		},
	});
	return foreign ? { entries: [], floor: null } : batch;
}

/**
 * One page of the merged list, newest first. `sources` names each mailbox
 * with the folder id of the one role the list shows (the `accessible` rows
 * carry each role's id); a source whose mailbox the caller does not read is
 * dropped. Pass `nextCursor` back for the next page; `hasMore` is false once
 * every folder is exhausted.
 */
// public: soft-auth — returns empty for anonymous; access via loadAccessibleMailboxes (own + team-inbox memberships)
export const listMessages = publicQuery({
	args: {
		sources: v.array(v.object({ mailboxId: v.id('mailboxes'), folderId: v.id('mailFolders') })),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const empty = {
			messages: [] as Array<MailListRow & RowThreadState & SenderLogoField>,
			hasMore: false,
			nextCursor: null as string | null,
		};
		const session = await readSession(ctx);
		if (!session) return empty;
		const readable = new Set(
			(await loadAccessibleMailboxes(ctx, session.userId, session.activeOrganizationId))
				.filter((mailbox) => mailbox.status === 'active')
				.map((mailbox) => mailbox._id)
		);
		const seen = new Set<Id<'mailFolders'>>();
		const sources = args.sources
			.filter((source) => {
				if (!readable.has(source.mailboxId) || seen.has(source.folderId)) return false;
				seen.add(source.folderId);
				return true;
			})
			.slice(0, ALL_INBOXES_MAX_SOURCES);
		if (sources.length === 0) return empty;

		const limit = Math.max(1, Math.min(Math.round(args.limit ?? DEFAULT_LIMIT), MAX_LIMIT));
		const before = decodeStreamCursor(args.cursor);
		const now = Date.now();
		const batches: SourceBatch<Entry>[] = [];
		for (const source of sources) batches.push(await readFolder(ctx, source, before, now, limit));
		const page = mergeStreamPage(batches, limit);
		// The merge hands its page back oldest first; the list shows newest first.
		const messages = page.entries.map((entry) => entry.message).reverse();
		return {
			messages: await attachThreadState(ctx, messages),
			hasMore: !page.isDone,
			nextCursor: page.cursor,
		};
	},
});

/** The single-mailbox Drafts list's own bound, kept for the merged one. */
const DRAFTS_LIMIT = 100;

/**
 * All Drafts: the live drafts of every named mailbox the caller reads, last
 * edited first, as the single-mailbox Drafts list shows them. Each mailbox is
 * read along `by_mailbox_live_and_edited` up to the list's bound, and the merge
 * keeps every one of them, so it lists what each mailbox's own Drafts would.
 */
// public: soft-auth — returns empty for anonymous; access via loadAccessibleMailboxes (own + team-inbox memberships)
export const listDrafts = publicQuery({
	args: { mailboxIds: v.array(v.id('mailboxes')) },
	handler: async (ctx, args) => {
		const session = await readSession(ctx);
		if (!session) return [];
		const readable = new Set(
			(await loadAccessibleMailboxes(ctx, session.userId, session.activeOrganizationId))
				.filter((mailbox) => mailbox.status === 'active')
				.map((mailbox) => mailbox._id)
		);
		const mailboxIds = [...new Set(args.mailboxIds)]
			.filter((id) => readable.has(id))
			.slice(0, ALL_INBOXES_MAX_SOURCES);
		const drafts: Doc<'mailDrafts'>[] = [];
		for (const mailboxId of mailboxIds) {
			drafts.push(
				...(await ctx.db
					.query('mailDrafts')
					.withIndex('by_mailbox_live_and_edited', (q) =>
						q.eq('mailboxId', mailboxId).eq('obsoleted.at', undefined)
					)
					.order('desc')
					.take(DRAFTS_LIMIT))
			);
		}
		// No cap on the merge: each mailbox is already held to its own bound, and
		// a global one would hide drafts no other view reaches.
		drafts.sort((a, b) => b.lastEditedAt - a.lastEditedAt);
		return await Promise.all(drafts.map((draft) => openMailDraftBody(draft)));
	},
});
