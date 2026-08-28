/**
 * Mailbox LIST views — the reads behind the Postbox message list, thread list,
 * folder sidebar, mailbox switcher and unread badge.
 *
 * Every handler is soft-auth (`publicQuery`): an anonymous caller gets the
 * empty result rather than an error, and mailbox access is enforced in-handler
 * through `loadReadableMailbox` / `loadAccessibleMailboxes`.
 *
 * Siblings: `mailbox/identity.ts` (CRUD + provisioning), `mailbox/messages.ts`
 * (single-message reads), `mailbox/search.ts`.
 */

import { v } from 'convex/values';
import type { QueryCtx } from '../../_generated/server';
import { publicQuery } from '../../lib/authedFunctions';
import { mailSortOrderValidator } from '../../lib/mailSettingsValidators';
import type { Id, Doc } from '../../_generated/dataModel';
import { loadReadableMailbox, loadAccessibleMailboxes } from '../permissions';
import { isMessageSnoozed } from '../../lib/mailSnooze';
import { readSession, type FolderRole } from './shared';

/**
 * Follow-up watch state attached to each list row ("No reply yet" chip /
 * armed-reminder chip in the thread list). One thread get per distinct thread
 * on the page, memoized.
 */
type RowFollowUp = { remindAt: number; dueAt?: number; watched: boolean };

async function attachThreadFollowUps(
	ctx: QueryCtx,
	messages: Doc<'mailMessages'>[]
): Promise<Array<Doc<'mailMessages'> & { followUp?: RowFollowUp }>> {
	const cache = new Map<Id<'mailThreads'>, Doc<'mailThreads'>['followUp']>();
	const out: Array<Doc<'mailMessages'> & { followUp?: RowFollowUp }> = [];
	for (const m of messages) {
		if (!cache.has(m.threadId)) {
			const thread = await ctx.db.get(m.threadId);
			cache.set(m.threadId, thread?.followUp);
		}
		const followUp = cache.get(m.threadId);
		out.push(
			followUp
				? {
						...m,
						followUp: {
							remindAt: followUp.remindAt,
							dueAt: followUp.dueAt,
							watched: followUp.messageId === m._id,
						},
					}
				: m
		);
	}
	return out;
}

/**
 * List messages in a mailbox, for the webmail UI.
 *
 * `sortOrder` flips the arrival direction on the same index: 'newest' (the
 * default, and the only order this view had before) reads descending, 'oldest'
 * ascending for clearing a backlog front to back. Omitting it is exactly the
 * previous behaviour, so a client that never sends it is unaffected.
 *
 * Keyset-paginated: pass `nextCursor` from the previous response to fetch the
 * next page. The cursor is opaque (a Convex paginate cursor minted for this
 * exact index + filter + direction) and stays valid across live updates of
 * already-read rows; a folder switch or a sort flip simply starts again
 * without one.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listMessages = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		folderRole: v.optional(v.string()),
		folderId: v.optional(v.id('mailFolders')),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
		sortOrder: v.optional(mailSortOrderValidator),
	},
	handler: async (ctx, args) => {
		const empty = { messages: [] as Doc<'mailMessages'>[], hasMore: false, nextCursor: null };
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return empty;

		const now = Date.now();
		// Arrival direction, applied to every branch below so the folder, custom
		// folder, label and Snoozed views never disagree about what "oldest" means.
		const oldestFirst = args.sortOrder === 'oldest';
		const order = oldestFirst ? ('asc' as const) : ('desc' as const);
		const limit = Math.min(args.limit ?? 50, 500);
		const pagination = { cursor: args.cursor ?? null, numItems: limit };
		// A message is hidden from its origin folder while snoozedUntil is in the
		// future; the wakeup cron clears the flag to float it back.
		const isSnoozed = (m: { snoozedUntil?: number }) => isMessageSnoozed(m, now);

		// Virtual "Snoozed" view — mailbox-scoped, range-scanned on snoozedUntil so
		// older snoozed mail stays reachable (no fixed recent-window cap). The
		// result is re-sorted by arrival client-side, so a keyset cursor has no
		// stable meaning here — this view stays take()-bounded instead.
		if (args.folderRole === 'snoozed') {
			const raw = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_snoozed', (q) =>
					q.eq('mailboxId', args.mailboxId).gt('snoozedUntil', now)
				)
				.take(limit + 1);
			const hasMore = raw.length > limit;
			const messages = raw
				.slice(0, limit)
				.sort((a, b) => (oldestFirst ? a.receivedAt - b.receivedAt : b.receivedAt - a.receivedAt));
			return { messages, hasMore, nextCursor: null };
		}

		// Custom-folder view, addressed directly by id — custom IMAP folders carry
		// no role, so the sidebar links them here (the by_folder index, like the
		// role path below, just keyed on the folder id). Ownership re-checked.
		if (args.folderId) {
			const folder = await ctx.db.get(args.folderId);
			if (!folder || folder.mailboxId !== args.mailboxId) return empty;
			const page = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', folder._id))
				.order(order)
				.paginate(pagination);
			return {
				messages: await attachThreadFollowUps(
					ctx,
					page.page.filter((m) => !isSnoozed(m))
				),
				hasMore: !page.isDone,
				nextCursor: page.isDone ? null : page.continueCursor,
			};
		}

		// Folder-scoped view, indexed by arrival (no mailbox-wide overfetch).
		if (args.folderRole) {
			const folder = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('role', args.folderRole as FolderRole)
				)
				.first();
			if (!folder) return empty;
			const page = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', folder._id))
				.order(order)
				.paginate(pagination);
			return {
				messages: await attachThreadFollowUps(
					ctx,
					page.page.filter((m) => !isSnoozed(m))
				),
				hasMore: !page.isDone,
				nextCursor: page.isDone ? null : page.continueCursor,
			};
		}

		// No folder (label view): whole mailbox by arrival.
		const page = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.order(order)
			.paginate(pagination);
		return {
			messages: await attachThreadFollowUps(
				ctx,
				page.page.filter((m) => !isSnoozed(m))
			),
			hasMore: !page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

/**
 * How deep into a mailbox's recent history the label view scans. Convex has no
 * element-containment index for array fields (an index over `labelIds` matches
 * whole-array equality only), so the label view reads the mailbox's newest
 * messages off `by_mailbox_and_received` and filters membership in-query. A
 * label whose newest message is inside this window is fully served; anything
 * older is out of view — the same bound the old client-side filter had at 500,
 * now doubled, moved server-side, and honest about its edge.
 */
const LABEL_SCAN_WINDOW = 1000;

/**
 * Server-side label view — messages carrying one label, newest first.
 *
 * Backs `/dashboard/postbox/label/[labelId]`, which previously fetched up to
 * 500 recent mailbox messages to the CLIENT and filtered `labelIds` there
 * (the "P7" debt): every visit paid for 500 rows regardless of hit count, and
 * the filtering logic lived outside the access-controlled read path. This
 * keeps the scan on the server: bounded indexed read, in-query membership
 * filter, only matching rows cross the wire.
 *
 * Contract: a single bounded page, NOT keyset pagination. The scan window is
 * the view's total reach, so `nextCursor` is always null by design — a
 * consumer fetches once at its display cap. `hasMore` means matches exist
 * beyond the returned slice (still inside the window); the UI renders an
 * honest cap note rather than offering a Load-more that has nothing to walk.
 * A membership table with true cursor paging is the eventual fix and needs a
 * migration across every `labelIds` writer (see ADR-0037's one-contract rule).
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listByLabel = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		labelId: v.id('mailLabels'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const empty = { messages: [] as Doc<'mailMessages'>[], hasMore: false, nextCursor: null };
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return empty;

		// The label must belong to this mailbox — an id from another mailbox must
		// never serve (or leak) rows.
		const label = await ctx.db.get(args.labelId);
		if (!label || label.mailboxId !== args.mailboxId) return empty;

		const now = Date.now();
		const limit = Math.min(Math.max(1, args.limit ?? 200), LABEL_SCAN_WINDOW);

		// Scan of the mailbox's newest messages, filtered to the label. Bounded:
		// LABEL_SCAN_WINDOW rows off `by_mailbox_and_received` — the documented,
		// deliberate reach of this view (see above); Convex has no
		// element-containment index for array fields to do better today.
		const scanned = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(LABEL_SCAN_WINDOW);
		// Snoozed rows are hidden from this view, so they must be dropped BEFORE
		// the slice: filtering afterwards lets them eat result slots (ask for
		// `limit`, get fewer with matches still in the window) and makes `hasMore`
		// count rows the caller will never see, overstating the cap note.
		const matching = scanned.filter(
			(m) => m.labelIds.includes(args.labelId) && !isMessageSnoozed(m, now)
		);

		return {
			messages: await attachThreadFollowUps(ctx, matching.slice(0, limit)),
			hasMore: matching.length > limit,
			nextCursor: null,
		};
	},
});

/**
 * Conversation list — one row per thread that has a message in the folder,
 * newest first. Snoozed threads (newest message snoozed) are hidden. Threads
 * aren't folder-indexed, so this overfetches the recent set then filters; it's
 * used for the inbox view (where most threads live), with the flat
 * `listMessages` serving other folders.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listThreads = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		folderRole: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const empty = { threads: [] as Doc<'mailThreads'>[], hasMore: false };
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return empty;

		const now = Date.now();
		const limit = Math.min(args.limit ?? 50, 500);
		const candidates = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take((limit + 1) * 3);

		const threads: Doc<'mailThreads'>[] = [];
		for (const t of candidates) {
			if (!t.folderRoles.includes(args.folderRole)) continue;
			if (t.latestMessageId) {
				const latest = await ctx.db.get(t.latestMessageId);
				if (latest && isMessageSnoozed(latest, now)) continue;
			}
			threads.push(t);
			if (threads.length > limit) break;
		}
		return { threads: threads.slice(0, limit), hasMore: threads.length > limit };
	},
});

/** List folders for a mailbox (for sidebar with unread counts). */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listFolders = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return [];
		return ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's folders
	},
});

/**
 * Every mailbox the caller can actually reach — their own personal mailbox(es)
 * plus any shared/team inbox they explicitly belong to — with its label, scope,
 * and inbox unread total. This is the SINGLE source for the Postbox sidebar
 * switcher and the Cmd-K "switch mailbox" entries: sections, labels, and badges
 * all derive from one accessible+active set, so an admin never sees a teammate's
 * private inbox or a shared inbox they don't belong to advertised as a switch
 * target (unlike `identity.list`, which returns every org mailbox for
 * owners/admins). Suspended/deleted rows are filtered out here, so there are no
 * dead-end targets.
 *
 * O(1) per mailbox: reads the denormalized `mailFolders.unseenCount`. Read
 * state is a single shared truth per message,
 * so every member of a shared inbox sees the same count.
 */
// public: soft-auth — returns empty for anonymous; access via loadAccessibleMailboxes (own + shared memberships)
export const accessible = publicQuery({
	args: {},
	handler: async (ctx) => {
		const session = await readSession(ctx);
		if (!session) return [];
		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		const rows: Array<{
			mailboxId: Id<'mailboxes'>;
			label: string;
			scope: 'personal' | 'shared';
			unread: number;
		}> = [];
		for (const mb of mailboxes) {
			if (mb.status !== 'active') continue;
			const inbox = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mb._id).eq('role', 'inbox'))
				.first();
			const displayName = mb.displayName?.trim();
			rows.push({
				mailboxId: mb._id,
				label: displayName && displayName.length > 0 ? displayName : mb.address,
				scope: mb.scope === 'shared' ? 'shared' : 'personal',
				unread: inbox?.unseenCount ?? 0,
			});
		}
		return rows;
	},
});

/**
 * The newest unread, not-snoozed inbox messages across the user's mailboxes
 * (plus the exact total unread count), for the desktop unread badge,
 * notification-rule filtering, and per-thread grouping. `total`
 * is the O(1) denormalized `mailFolders.unseenCount` total;
 * `messages` is a bounded, best-effort newest-first window used only for
 * category-aware toast decisions — it never drives `total`.
 * Minimal, plain-text fields only.
 */
// public: soft-auth — returns an empty peek for anonymous; access via loadAccessibleMailboxes (own + shared memberships)
export const newestUnreadInbox = publicQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const empty = {
			total: 0,
			messages: [] as Array<{
				messageId: Id<'mailMessages'>;
				threadId: Id<'mailThreads'>;
				fromName?: string;
				fromAddress: string;
				subject: string;
				category?: 'person' | 'newsletter' | 'notification' | 'receipt' | 'other';
				receivedAt: number;
			}>,
		};
		const session = await readSession(ctx);
		if (!session) return empty;
		// Clamp the window so a caller can't force an unbounded scan.
		const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 5)));
		const now = Date.now();
		// The caller's own mailboxes plus any shared mailbox they belong to; the
		// per-mailbox `status !== 'active'` guard below keeps the status filtering.
		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		let total = 0;
		const collected: (typeof empty)['messages'] = [];
		for (const mb of mailboxes) {
			if (mb.status !== 'active') continue;
			const inbox = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mb._id).eq('role', 'inbox'))
				.first();
			if (!inbox) continue;
			total += inbox.unseenCount;
			// Scan a bounded window of the newest messages and keep the visible
			// unread ones using the same bounded-window posture as notification reads.
			const recent = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', inbox._id))
				.order('desc')
				.take(limit + 20);
			// The smart-inbox `category` object lives on the thread, not the
			// message; dedupe thread reads within this bounded window (a thread
			// often has several unread messages) so we do at most one .get per
			// distinct thread.
			const threadCategory = new Map<
				Id<'mailThreads'>,
				'person' | 'newsletter' | 'notification' | 'receipt' | 'other' | undefined
			>();
			for (const m of recent) {
				if (m.flagSeen || isMessageSnoozed(m, now)) continue;
				let category = threadCategory.get(m.threadId);
				if (!threadCategory.has(m.threadId)) {
					const thread = await ctx.db.get(m.threadId);
					category = thread?.category?.label;
					threadCategory.set(m.threadId, category);
				}
				collected.push({
					messageId: m._id,
					threadId: m.threadId,
					fromName: m.fromName,
					fromAddress: m.fromAddress,
					subject: m.subject,
					category,
					receivedAt: m.receivedAt,
				});
			}
		}
		collected.sort((a, b) => b.receivedAt - a.receivedAt);
		return { total, messages: collected.slice(0, limit) };
	},
});
