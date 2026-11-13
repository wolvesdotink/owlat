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

import type { mailCategoryLabelValidator } from '../../lib/literalValidators';
import { v, type Infer } from 'convex/values';
import { publicQuery } from '../../lib/authedFunctions';
import { mailSortOrderValidator } from '../../lib/validators/mailSettings';
import type { Id } from '../../_generated/dataModel';
import { loadReadableMailbox, loadAccessibleMailboxes } from '../permissions';
import { isMessageSnoozed } from '../../lib/mailSnooze';
import { isThreadMuted } from '../../lib/mailMute';
import { readSession } from './shared';
import type { FolderRole } from '../../lib/validators/mail';
import { providerHostOf, providerOf, readRoleFolders, type InboxProvider } from './accessibleRow';
import { attachThreadState, type MailListRow, type RowThreadState } from './rowThreadState';
import type { SenderLogoField } from '../senderLogos/cache';
import type { ThreadListRow } from './threadListRow';
import { readThreadList } from './threadListRead';
import { readLabelPage } from '../labelMessageIndex';

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
		const empty = {
			messages: [] as Array<MailListRow & RowThreadState & SenderLogoField>,
			hasMore: false,
			nextCursor: null,
		};
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
			return { messages: await attachThreadState(ctx, messages), hasMore, nextCursor: null };
		}

		// Folder addressed directly by id. Custom IMAP folders carry no role, so
		// the sidebar links them here, and the client also sends the id of a role
		// folder once `listFolders` has resolved it.
		//
		// The folder DOC is deliberately not read. IMAP bookkeeping (modseq,
		// counts) patches it on every delivery and flag change, and reading it
		// would make this subscription re-run page 1 whenever any message in the
		// folder is marked read. Ownership is checked on the rows instead: a
		// folder belongs to one mailbox, so every message filed in it carries
		// that mailbox's id, and a page holding any other mailbox's row means
		// the id was not this mailbox's folder.
		if (args.folderId) {
			const folderId = args.folderId;
			const page = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', folderId))
				.order(order)
				.paginate(pagination);
			if (page.page.some((m) => m.mailboxId !== args.mailboxId)) return empty;
			return {
				messages: await attachThreadState(
					ctx,
					page.page.filter((m) => !isSnoozed(m))
				),
				hasMore: !page.isDone,
				nextCursor: page.isDone ? null : page.continueCursor,
			};
		}

		// Folder-scoped view by role, indexed by arrival (no mailbox-wide
		// overfetch). Resolving the role reads the folder doc, so this
		// subscription also re-runs on the folder's IMAP bookkeeping writes;
		// clients that already hold the folder id send `folderId` instead.
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
				messages: await attachThreadState(
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
			messages: await attachThreadState(
				ctx,
				page.page.filter((m) => !isSnoozed(m))
			),
			hasMore: !page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

/**
 * How deep into a mailbox's recent history the label view scans while the
 * mailbox's label rows (`mail/labelMessageIndex.ts`) are not backfilled yet.
 * Convex has no element-containment index for array fields (an index over
 * `labelIds` matches whole-array equality only), so that fallback reads the
 * mailbox's newest messages off `by_mailbox_and_received` and filters
 * membership in-query; anything older is out of its view.
 */
const LABEL_SCAN_WINDOW = 1000;

/**
 * Server-side label view — messages carrying one label, newest first,
 * snoozed rows hidden. Backs `/dashboard/postbox/label/[labelId]`.
 *
 * Once the mailbox's label rows are ready it reads only the label's rows and
 * their messages, keyset-paged: `nextCursor` resumes after the page, and
 * `hasMore` means more visible matches follow. Until then it falls back to the
 * bounded scan of the newest {@link LABEL_SCAN_WINDOW} messages, which ignores
 * `cursor`, returns `nextCursor: null`, and sets `hasMore` when matches exist
 * beyond the slice inside that window.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listByLabel = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		labelId: v.id('mailLabels'),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const empty = {
			messages: [] as Array<MailListRow & RowThreadState & SenderLogoField>,
			hasMore: false,
			nextCursor: null as string | null,
		};
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return empty;

		// The label must belong to this mailbox — an id from another mailbox must
		// never serve (or leak) rows.
		const label = await ctx.db.get(args.labelId);
		if (!label || label.mailboxId !== args.mailboxId) return empty;

		const now = Date.now();
		const limit = Math.min(Math.max(1, args.limit ?? 200), LABEL_SCAN_WINDOW);

		const indexed = await readLabelPage(ctx.db, args.mailboxId, args.labelId, {
			limit,
			cursor: args.cursor,
			now,
		});
		if (indexed) {
			return { ...indexed, messages: await attachThreadState(ctx, indexed.messages) };
		}

		// Not backfilled yet: the bounded scan of the mailbox's newest messages.
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
			messages: await attachThreadState(ctx, matching.slice(0, limit)),
			hasMore: matching.length > limit,
			nextCursor: null,
		};
	},
});

/**
 * Conversation list — one row per thread that has a message in the folder,
 * newest first, snoozed threads (newest message snoozed) hidden. Rows are
 * projected (`threadListRow.ts`); the read is {@link readThreadList}.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listThreads = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		folderRole: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return { threads: [] as ThreadListRow[], hasMore: false };
		return await readThreadList(ctx, args);
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
 * target. `identity.list` reads the same `loadAccessibleMailboxes` set but keeps
 * suspended rows and returns full mailbox docs. Suspended/deleted rows are
 * filtered out here, so there are no dead-end targets.
 *
 * Constant work per mailbox: its six system folders by role (the Inbox's
 * denormalized `mailFolders.unseenCount` is the badge) and, for a connected
 * mailbox, its account row for the provider (`accessibleRow.ts`). Read state is
 * a single shared truth per message, so every member of a shared inbox sees the
 * same count.
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
			address: string;
			scope: 'personal' | 'shared';
			/** Backed by a connected IMAP account rather than hosted here. */
			isConnected: boolean;
			colorSlot: number | null;
			/** An icon key or one emoji the owner picked (`appearance.ts`). */
			mark: string | null;
			/** The provider of a connected Gmail or Microsoft account. */
			provider: InboxProvider | null;
			unread: number;
			/**
			 * Each system folder by role, which All inboxes and the unified
			 * folders (`allInboxes.ts`) read by id. Null where the mailbox has none.
			 */
			folderIds: Record<FolderRole, Id<'mailFolders'> | null>;
			/**
			 * The IMAP host a connected mailbox syncs from, lowercased: what the
			 * unified folders narrow by provider on. Null for a hosted mailbox.
			 */
			providerHost: string | null;
		}> = [];
		for (const mb of mailboxes) {
			if (mb.status !== 'active') continue;
			const { folderIds, inboxUnread } = await readRoleFolders(ctx, mb._id);
			const displayName = mb.displayName?.trim();
			const account =
				mb.kind === 'external' && mb.externalAccountId
					? await ctx.db.get(mb.externalAccountId)
					: null;
			rows.push({
				mailboxId: mb._id,
				label: displayName && displayName.length > 0 ? displayName : mb.address,
				address: mb.address,
				scope: mb.scope === 'shared' ? 'shared' : 'personal',
				isConnected: mb.kind === 'external',
				colorSlot: mb.colorSlot ?? null,
				mark: mb.mark ?? null,
				provider: providerOf(account),
				unread: inboxUnread,
				folderIds,
				providerHost: providerHostOf(account),
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
 *
 * `mailboxId` narrows both to one accessible mailbox (the desktop tray). One the
 * caller cannot read or that is not active gets the empty peek with
 * `unavailable`, not an error: the id is a device setting that can outlive both.
 */
// public: soft-auth — returns an empty peek for anonymous; access via loadAccessibleMailboxes (own + shared memberships)
export const newestUnreadInbox = publicQuery({
	args: { limit: v.optional(v.number()), mailboxId: v.optional(v.id('mailboxes')) },
	handler: async (ctx, args) => {
		const empty = {
			total: 0,
			messages: [] as Array<{
				messageId: Id<'mailMessages'>;
				threadId: Id<'mailThreads'>;
				fromName?: string;
				fromAddress: string;
				subject: string;
				category?: Infer<typeof mailCategoryLabelValidator>;
				/** Muted conversation (mail/mute.ts) — never fires a desktop toast. */
				muted?: boolean;
				/**
				 * Thread armed with "notify me when they reply" (mail/threadAlerts.ts)
				 * — pierces the people-only scope AND quiet hours.
				 */
				alerted?: boolean;
				/**
				 * A live one-time code (mail/signInCodes.ts) the desktop notification
				 * offers to copy. Only that it exists: the value stays on the message.
				 */
				hasSignInCode?: boolean;
				receivedAt: number;
			}>,
			/** Set when `mailboxId` names a mailbox the caller cannot read or that is not active. */
			unavailable: undefined as true | undefined,
		};
		const unavailable = { ...empty, unavailable: true as const };
		const session = await readSession(ctx);
		if (!session) return args.mailboxId ? unavailable : empty;
		// Clamp the window so a caller can't force an unbounded scan.
		const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 5)));
		const now = Date.now();
		// The caller's own mailboxes plus any shared mailbox they belong to; the
		// per-mailbox `status !== 'active'` guard below keeps the status filtering.
		const accessible = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		// Not active (deleted, suspended, or disconnected, which soft-deletes it)
		// counts as unreadable, so the tray falls back to all inboxes.
		const mailboxes = args.mailboxId
			? accessible.filter((mb) => mb._id === args.mailboxId && mb.status === 'active')
			: accessible;
		if (args.mailboxId && mailboxes.length === 0) return unavailable;
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
			const threadState = new Map<
				Id<'mailThreads'>,
				{
					category?: Infer<typeof mailCategoryLabelValidator>;
					muted: boolean;
					alerted: boolean;
				}
			>();
			for (const m of recent) {
				if (m.flagSeen || isMessageSnoozed(m, now)) continue;
				let state = threadState.get(m.threadId);
				if (!state) {
					const thread = await ctx.db.get(m.threadId);
					state = {
						category: thread?.category?.label,
						muted: isThreadMuted(thread),
						alerted: thread?.notifyOnReplyAt != null,
					};
					threadState.set(m.threadId, state);
				}
				collected.push({
					messageId: m._id,
					threadId: m.threadId,
					fromName: m.fromName,
					fromAddress: m.fromAddress,
					subject: m.subject,
					category: state.category,
					muted: state.muted,
					alerted: state.alerted,
					...(m.signInCode?.kind === 'code' && m.signInCode.expiresAt > now
						? { hasSignInCode: true }
						: {}),
					receivedAt: m.receivedAt,
				});
			}
		}
		collected.sort((a, b) => b.receivedAt - a.receivedAt);
		return { ...empty, total, messages: collected.slice(0, limit) };
	},
});
