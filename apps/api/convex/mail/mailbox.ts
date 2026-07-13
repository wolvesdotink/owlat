/**
 * Mailbox identity management — per-user personal mailboxes (Postbox).
 *
 * - Admin CRUD (org-scoped via getMutationContext)
 * - Provisioned mailboxes are pushed to the MTA's Redis cache
 *   (`mailboxActions.pushMailboxToCache`) so `findMailboxRoute()` resolves
 *   inbound recipients without a Convex round-trip per RCPT TO.
 *
 * Distinct from CRM `contacts` and from the AI-shared `inboundMessages`
 * pipeline. See packages/shared/src/featureFlags.ts (`postbox` flag).
 */

import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import type { Id, Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { requireAdminContext, getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import {
	throwForbidden,
	throwInvalidInput,
	throwAlreadyExists,
	throwNotFound,
} from '../_utils/errors';
import {
	requireMailboxAccess,
	requireMessageAccess,
	loadReadableMailbox,
	loadAccessibleMailboxes,
} from './permissions';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { isFeatureEnabled } from '../lib/featureFlags';
import { normalizeEmail, parseAddress } from '@owlat/shared';

/**
 * The caller-visible personal mailbox for a member: their single `active`
 * mailbox, or null. Shared by the fresh-start surfaces (`mailboxRequest.request`,
 * `mailboxRequest.freshStartStatus`, `userOnboarding.completeFreshStart`) so
 * "does this member have a mailbox" means the SAME thing everywhere — an active
 * row, never a suspended/deleted one. A member whose only mailbox is suspended
 * still reaches the honest "ask an admin" escape hatch.
 */
export async function getActiveMailboxForUser(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'mailboxes'> | null> {
	return await ctx.db
		.query('mailboxes')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.filter((q) => q.eq(q.field('status'), 'active'))
		.first();
}

/**
 * Resolve the single authoritative mailbox that owns an address for inbound
 * delivery and IMAP/SMTP auth. A "move" (mail/mailboxMove.ts) intentionally
 * leaves TWO active rows on one address: the old external one — now a read-only
 * archive, `kind='external'` — and the new live `kind='hosted'` mailbox. A bare
 * `by_address` + `.first()` returns the OLDEST row, i.e. the archive, which
 * would silently swallow all post-cutover inbound mail. Prefer the non-external
 * (hosted/local) row so the live mailbox always wins; fall back to the sole
 * active row otherwise. Returns `null` when no active mailbox claims the address.
 */
export async function resolveDeliverableMailbox(
	ctx: QueryCtx | MutationCtx,
	address: string
): Promise<Doc<'mailboxes'> | null> {
	const rows = await ctx.db
		.query('mailboxes')
		.withIndex('by_address', (q) => q.eq('address', address))
		.collect(); // bounded: at most an external archive + its hosted successor
	const active = rows.filter((m) => m.status === 'active');
	if (active.length === 0) return null;
	// The hosted/local mailbox is authoritative on the MTA; the external row is a
	// read-only archive that must never receive new mail.
	return active.find((m) => m.kind !== 'external') ?? active[0] ?? null;
}

const SYSTEM_FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive'] as const;
type FolderRole = (typeof SYSTEM_FOLDER_ROLES)[number];

const SYSTEM_FOLDER_NAMES: Record<FolderRole, string> = {
	inbox: 'INBOX',
	sent: 'Sent',
	drafts: 'Drafts',
	trash: 'Trash',
	spam: 'Spam',
	archive: 'Archive',
};

/**
 * Strip "Name <addr>" framing and lowercase, via the shared `parseAddress` so
 * mailbox keys agree with every other address derivation. Falls back to a
 * lowercased trim when no address is present (preserving the prior behavior of
 * returning the input for non-address strings).
 */
export function canonicalAddress(raw: string): string {
	return parseAddress(raw)?.address ?? normalizeEmail(raw);
}

/**
 * Is `domain` a sending domain this instance has fully VERIFIED? The one truth
 * for the invariant the reservation flow hinges on: a hosted mailbox may only be
 * stood up on a verified domain (inbound mail could not arrive otherwise), and
 * the fresh-start guard reads a reservation as "activates when your domain
 * verifies" until this returns true. A missing domains row counts as unverified.
 */
export async function isDomainVerified(
	ctx: QueryCtx | MutationCtx,
	domain: string
): Promise<boolean> {
	const domainRow = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', domain))
		.first();
	return domainRow?.status === 'verified';
}

/**
 * Insert a `mailboxes` row, provision the six system folders, and schedule
 * the MTA cache push. Caller is responsible for the dup-check and any
 * permission gating. Returns the new mailbox id.
 *
 * Shared by `create` (admin path) and `pendingMailbox.claimForInvitation`
 * (post-accept path) so the two stay in sync.
 */
export async function provisionMailbox(
	ctx: MutationCtx,
	args: {
		userId: string;
		organizationId: string;
		address: string;
		domain: string;
		displayName?: string;
		quotaBytes?: number;
		/** undefined ⇒ 'hosted'. 'external' skips the MTA cache push (see below). */
		kind?: 'hosted' | 'external';
		/**
		 * Sharing model. undefined ⇒ 'personal' (a single user's mailbox).
		 * 'shared' marks a team inbox whose access is governed by explicit
		 * `mailboxMembers` rows (see mail/mailboxMembers.ts). The creator's
		 * implicit 'owner' membership is inserted here regardless of scope; a
		 * shared mailbox layers further member rows on top.
		 */
		scope?: 'personal' | 'shared';
		externalAccountId?: Id<'externalMailAccounts'>;
	}
): Promise<Id<'mailboxes'>> {
	const now = Date.now();
	const kind = args.kind ?? 'hosted';
	const mailboxId = await ctx.db.insert('mailboxes', {
		userId: args.userId,
		organizationId: args.organizationId,
		address: args.address,
		domain: args.domain,
		displayName: args.displayName,
		kind,
		scope: args.scope,
		externalAccountId: args.externalAccountId,
		status: 'active',
		quotaBytes: args.quotaBytes,
		usedBytes: 0,
		uidValidity: now,
		createdAt: now,
		updatedAt: now,
	});

	// The implicit 'owner' membership — the access model's single source of
	// truth (mail/permissions.ts). Every mailbox carries exactly this one row
	// at provision time; shared mailboxes add further rows later. Mirrors the
	// backfill in migrations/0034 so new and pre-existing mailboxes agree.
	await ctx.db.insert('mailboxMembers', {
		mailboxId,
		authUserId: args.userId,
		role: 'owner',
		addedBy: args.userId, // self — the implicit owner predates member management
		createdAt: now,
	});

	// Sealed Mail (E1): mint + publish an E2EE keypair for the new address so
	// other instances can seal mail to it. Flag-gated (`sealedMail`, default OFF)
	// and offloaded to the Node keygen plane; a no-op when the flag is off.
	if (await isFeatureEnabled(ctx, 'sealedMail')) {
		// Mint the singleton instance signing identity on first use (idempotent),
		// so `/.well-known/owlat.json` can be signed as soon as any address key is
		// published — otherwise the manifest would 404 until an admin ran backfill.
		await ctx.scheduler.runAfter(0, internal.e2ee.keysNode.ensureInstanceIdentity, {});
		await ctx.scheduler.runAfter(0, internal.e2ee.keysNode.mintForAddress, {
			address: args.address,
		});
	}

	for (const role of SYSTEM_FOLDER_ROLES) {
		await ctx.db.insert('mailFolders', {
			mailboxId,
			name: SYSTEM_FOLDER_NAMES[role],
			role,
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	}

	// External mailboxes are NOT authoritative on the local MTA — mail for an
	// external address is delivered by the user's own provider and synced in by
	// apps/mail-sync. Pushing them to the MTA mailbox cache would make the local
	// MTA wrongly claim the address. Hosted mailboxes still push.
	if (kind !== 'external') {
		await ctx.scheduler.runAfter(0, internal.mail.mailboxActions.pushMailboxToCache, {
			mailboxId,
		});
	}

	return mailboxId;
}

/**
 * Canonicalize + validate an address, reject a duplicate mailbox, and provision
 * the row. The shared body behind the admin `create` (personal) path and
 * `mailboxMembers.createShared` (team) path so the two never drift on address
 * normalization, the `by_address` dup-check, or the provisioning call. Callers
 * own their own auth gate and any scope-specific checks (e.g. verified-domain).
 */
export async function createProvisionedMailbox(
	ctx: MutationCtx,
	args: {
		userId: string;
		organizationId: string;
		address: string;
		displayName?: string;
		quotaBytes?: number;
		scope?: 'personal' | 'shared';
	}
): Promise<Id<'mailboxes'>> {
	const address = canonicalAddress(args.address);
	const [, domain] = address.split('@');
	if (!domain) {
		throwInvalidInput('Invalid email address');
	}

	const existing = await ctx.db
		.query('mailboxes')
		.withIndex('by_address', (q) => q.eq('address', address))
		.first();
	if (existing) {
		throwAlreadyExists(`Mailbox ${address} already exists`);
	}

	return provisionMailbox(ctx, {
		userId: args.userId,
		organizationId: args.organizationId,
		address,
		domain,
		displayName: args.displayName,
		quotaBytes: args.quotaBytes,
		scope: args.scope,
	});
}

export const create = authedMutation({
	args: {
		userId: v.string(),
		address: v.string(),
		displayName: v.optional(v.string()),
		quotaBytes: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const sessionWithOrg = await getBetterAuthSessionWithRole(ctx);
		if (!sessionWithOrg?.activeOrganizationId) {
			throwForbidden('No active organization');
		}
		return createProvisionedMailbox(ctx, {
			userId: args.userId,
			organizationId: sessionWithOrg.activeOrganizationId,
			address: args.address,
			displayName: args.displayName,
			quotaBytes: args.quotaBytes,
		});
	},
});

async function readSession(ctx: Parameters<typeof getBetterAuthSessionWithRole>[0]) {
	const s = await getBetterAuthSessionWithRole(ctx);
	if (!s || !s.activeOrganizationId || !s.role) return null;
	return {
		userId: s.userId,
		role: s.role,
		activeOrganizationId: s.activeOrganizationId,
	};
}

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: {},
	handler: async (ctx) => {
		const session = await readSession(ctx);
		if (!session) return [];
		// Use `by_status` to skip deleted rows at the DB layer. Two index
		// reads (active + suspended) is still cheaper than a full scan
		// followed by an in-memory filter.
		const [active, suspended] = await Promise.all([
			ctx.db
				.query('mailboxes')
				.withIndex('by_status', (q) => q.eq('status', 'active'))
				.collect(), // bounded: active mailboxes (single-org: member roster, few)
			ctx.db
				.query('mailboxes')
				.withIndex('by_status', (q) => q.eq('status', 'suspended'))
				.collect(), // bounded: suspended mailboxes (single-org: member roster, few)
		]);
		const visible = [...active, ...suspended];
		if (session.role === 'owner' || session.role === 'admin') {
			return visible;
		}
		// An editor sees their own mailboxes plus any shared mailbox they are an
		// explicit member of (org membership alone grants nothing). Filtering the
		// already-loaded `visible` set keeps the `by_status` (active/suspended)
		// filtering intact; personal mailboxes carry no non-owner members, so
		// this is bit-for-bit the old owner-only filter for them.
		const memberIds = new Set(
			(
				await ctx.db
					.query('mailboxMembers')
					.withIndex('by_user', (q) => q.eq('authUserId', session.userId))
					.collect()
			) // bounded: shared mailboxes one user belongs to
				.map((row) => row.mailboxId)
		);
		// `visible` comes from the org-agnostic `by_status` index, so a membership
		// row is only allowed to surface a mailbox inside the caller's active org —
		// mirrors the org-boundary defense-in-depth on `requireMailboxAccess` /
		// `loadAccessibleMailboxes` so a stale/mis-seeded row can't cross an org.
		return visible.filter(
			(m) =>
				m.userId === session.userId ||
				(memberIds.has(m._id) && m.organizationId === session.activeOrganizationId)
		);
	},
});

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const get = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		return loadReadableMailbox(ctx, args.mailboxId);
	},
});

export const remove = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const mailbox = await ctx.db.get(args.mailboxId);
		await ctx.db.patch(args.mailboxId, {
			status: 'deleted',
			updatedAt: Date.now(),
		});
		// Cascade-clean any un-claimed team-inbox membership grants pointing at this
		// inbox: the mailbox is gone, so an accept would only drop them anyway.
		const pendingGrants = await ctx.db
			.query('pendingMailboxMembers')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: a handful of pending invitees per inbox at most
		for (const grant of pendingGrants) {
			await ctx.db.delete(grant._id);
		}
		if (mailbox) {
			await ctx.scheduler.runAfter(0, internal.mail.mailboxActions.removeFromCache, {
				address: mailbox.address,
			});
		}
		return { success: true };
	},
});

/**
 * Edit a provisioned mailbox's display name after creation. Gated by
 * `requireMailboxAccess` at the `owner` floor (org owner/admin, the mailbox's
 * own user, or an explicit owner-role member) — the display name is a
 * mailbox-wide setting, so a plain shared-mailbox member cannot change it.
 * The address is immutable (it's the routing key pushed to the MTA cache);
 * only the human-facing `displayName` can change. An empty/blank value clears
 * it back to "(no display name)".
 */
export const setDisplayName = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		displayName: v.string(),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) {
			if (owned.reason === 'mailbox_missing') throwNotFound('Mailbox');
			throwForbidden('Mailbox not accessible');
		}
		const trimmed = args.displayName.trim();
		await ctx.db.patch(args.mailboxId, {
			displayName: trimmed || undefined,
			updatedAt: Date.now(),
		});
		return { success: true };
	},
});

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

/** List messages in a mailbox (most-recent first), for the webmail UI. */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listMessages = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		folderRole: v.optional(v.string()),
		folderId: v.optional(v.id('mailFolders')),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const empty = { messages: [] as Doc<'mailMessages'>[], hasMore: false };
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return empty;

		const now = Date.now();
		const limit = Math.min(args.limit ?? 50, 500);
		// A message is hidden from its origin folder while snoozedUntil is in the
		// future; the wakeup cron clears the flag to float it back.
		const isSnoozed = (m: { snoozedUntil?: number }) => isMessageSnoozed(m, now);

		// Virtual "Snoozed" view — mailbox-scoped, range-scanned on snoozedUntil so
		// older snoozed mail stays reachable (no fixed recent-window cap).
		if (args.folderRole === 'snoozed') {
			const raw = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_snoozed', (q) =>
					q.eq('mailboxId', args.mailboxId).gt('snoozedUntil', now)
				)
				.take(limit + 1);
			const hasMore = raw.length > limit;
			const messages = raw.slice(0, limit).sort((a, b) => b.receivedAt - a.receivedAt);
			return { messages, hasMore };
		}

		// Custom-folder view, addressed directly by id — custom IMAP folders carry
		// no role, so the sidebar links them here (the by_folder index, like the
		// role path below, just keyed on the folder id). Ownership re-checked.
		if (args.folderId) {
			const folder = await ctx.db.get(args.folderId);
			if (!folder || folder.mailboxId !== args.mailboxId) return empty;
			const raw = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', folder._id))
				.order('desc')
				.take(limit + 1);
			return {
				messages: await attachThreadFollowUps(
					ctx,
					raw.slice(0, limit).filter((m) => !isSnoozed(m))
				),
				hasMore: raw.length > limit,
			};
		}

		// Folder-scoped view, indexed by arrival (no mailbox-wide overfetch). The
		// extra row drives a reliable hasMore even after the snooze filter.
		if (args.folderRole) {
			const folder = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('role', args.folderRole as FolderRole)
				)
				.first();
			if (!folder) return empty;
			const raw = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', folder._id))
				.order('desc')
				.take(limit + 1);
			return {
				messages: await attachThreadFollowUps(
					ctx,
					raw.slice(0, limit).filter((m) => !isSnoozed(m))
				),
				hasMore: raw.length > limit,
			};
		}

		// No folder (label view): whole mailbox by arrival.
		const raw = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(limit + 1);
		return {
			messages: await attachThreadFollowUps(
				ctx,
				raw.slice(0, limit).filter((m) => !isSnoozed(m))
			),
			hasMore: raw.length > limit,
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
 * Total unread mail in the caller's own Postbox inbox(es) — the count behind
 * the desktop dock/taskbar badge and new-mail notifications. Scoped to the
 * caller's mailboxes even for admins (this is a personal badge, not an org
 * aggregate). Reads the denormalized `mailFolders.unseenCount`, so it stays
 * O(mailboxes-per-user) regardless of message volume.
 */
/**
 * The single newest unread, not-snoozed inbox message across the user's
 * mailboxes — for a desktop "new mail" notification that can deep-link/triage.
 * Minimal fields only.
 */
// public: soft-auth — returns null for anonymous; access via loadAccessibleMailboxes (own + shared memberships)
export const latestInboxUnread = publicQuery({
	args: {},
	handler: async (ctx) => {
		const session = await readSession(ctx);
		if (!session) return null;
		const now = Date.now();
		// The caller's own mailboxes plus any shared mailbox they belong to; the
		// per-mailbox `status !== 'active'` guard below keeps the status filtering.
		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		let best: {
			messageId: Id<'mailMessages'>;
			fromName?: string;
			fromAddress: string;
			subject: string;
			receivedAt: number;
		} | null = null;
		for (const mb of mailboxes) {
			if (mb.status !== 'active') continue;
			const inbox = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mb._id).eq('role', 'inbox'))
				.first();
			if (!inbox) continue;
			const recent = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', inbox._id))
				.order('desc')
				.take(20); // bounded: scan the 20 newest for the latest visible unread
			const hit = recent.find((m) => !m.flagSeen && !isMessageSnoozed(m, now));
			if (hit && (!best || hit.receivedAt > best.receivedAt)) {
				best = {
					messageId: hit._id,
					fromName: hit.fromName,
					fromAddress: hit.fromAddress,
					subject: hit.subject,
					receivedAt: hit.receivedAt,
				};
			}
		}
		return best;
	},
});

// public: soft-auth — returns 0 for anonymous; access via loadAccessibleMailboxes (own + shared memberships)
export const inboxUnreadCount = publicQuery({
	args: {},
	handler: async (ctx) => {
		const session = await readSession(ctx);
		if (!session) return 0;
		// The caller's own mailboxes plus any shared mailbox they belong to; the
		// per-mailbox `status !== 'active'` guard below keeps the status filtering.
		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		let unread = 0;
		for (const mb of mailboxes) {
			if (mb.status !== 'active') continue;
			const inbox = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mb._id).eq('role', 'inbox'))
				.first();
			if (inbox) unread += inbox.unseenCount;
		}
		return unread;
	},
});

/**
 * Every mailbox the caller can actually reach — their own personal mailbox(es)
 * plus any shared/team inbox they explicitly belong to — with its label, scope,
 * and inbox unread total. This is the SINGLE source for the Postbox sidebar
 * switcher and the Cmd-K "switch mailbox" entries: sections, labels, and badges
 * all derive from one accessible+active set, so an admin never sees a teammate's
 * private inbox or a shared inbox they don't belong to advertised as a switch
 * target (unlike `list`, which returns every org mailbox for owners/admins).
 * Suspended/deleted rows are filtered out here, so there are no dead-end targets.
 *
 * O(1) per mailbox: reads the denormalized `mailFolders.unseenCount`, same
 * source as `inboxUnreadCount`. Read state is a single shared truth per message,
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
 * is the O(1) denormalized unread count (same source as `inboxUnreadCount`);
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
			// unread ones (mirrors latestInboxUnread's take-window posture).
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
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const getMessageBody = publicQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const message = await loadReadableMessage(ctx, args.messageId);
		if (!message) return null;
		return {
			htmlInline: message.htmlBodyInline ?? null,
			textInline: message.textBodyInline ?? null,
			htmlUrl: message.htmlBodyStorageId
				? await ctx.storage.getUrl(message.htmlBodyStorageId)
				: null,
			textUrl: message.textBodyStorageId
				? await ctx.storage.getUrl(message.textBodyStorageId)
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
export const getMessageRawUrl = publicQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const message = await loadReadableMessage(ctx, args.messageId);
		if (!message) return null;
		return await ctx.storage.getUrl(message.rawStorageId);
	},
});

/** Free-text + structured search across messages in a mailbox. */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const search = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		// Pre-parsed query payload; the web side calls
		// `parseSearchQuery(rawText)` before calling us so the parser
		// stays close to the UI.
		text: v.string(),
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
	},
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return [];

		// Resolve folder if `in:role` was specified
		let folderId: import('../_generated/dataModel').Id<'mailFolders'> | undefined;
		if (args.folderRole) {
			const folder = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('role', args.folderRole as FolderRole)
				)
				.first();
			folderId = folder?._id;
			if (!folderId) return [];
		}

		// Resolve label by name
		let labelId: import('../_generated/dataModel').Id<'mailLabels'> | undefined;
		if (args.labelName) {
			const label = await ctx.db
				.query('mailLabels')
				.withIndex('by_mailbox_and_name', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('name', args.labelName as string)
				)
				.first();
			labelId = label?._id;
			if (!labelId) return [];
		}

		const limit = Math.min(args.limit ?? 50, 200);
		let messages;

		if (args.text) {
			// Full-text via Convex search index
			messages = await ctx.db
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
				.take(limit * 2);
		} else {
			// No text → fall back to time-ordered scan over the mailbox
			messages = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
				.order('desc')
				.take(limit * 4);
		}

		// Final filters that the search index couldn't express
		const filtered = messages.filter((m) => {
			if (folderId && m.folderId !== folderId) return false;
			if (args.from && !m.fromAddress.includes(args.from)) return false;
			if (args.to && !m.toAddresses.some((a) => a.includes(args.to as string))) return false;
			if (args.subject && !m.subject.toLowerCase().includes(args.subject)) return false;
			if (args.hasAttachment !== undefined && m.hasAttachments !== args.hasAttachment) return false;
			if (args.flagSeen !== undefined && m.flagSeen !== args.flagSeen) return false;
			if (args.flagFlagged !== undefined && m.flagFlagged !== args.flagFlagged) return false;
			if (labelId && !m.labelIds.includes(labelId)) return false;
			if (args.beforeMs !== undefined && m.receivedAt >= args.beforeMs) return false;
			if (args.afterMs !== undefined && m.receivedAt <= args.afterMs) return false;
			return true;
		});

		return filtered.slice(0, limit);
	},
});
