/**
 * Mailbox identity management — per-user personal mailboxes (Postbox).
 *
 * - Admin CRUD (org-scoped via getMutationContext)
 * - Provisioned mailboxes are pushed to the MTA's Redis cache
 *   (`mailboxActions.pushMailboxToCache`) so `findMailboxRoute()` resolves
 *   inbound recipients without a Convex round-trip per RCPT TO.
 *
 * The reads that render a mailbox's CONTENTS live beside this file:
 * `mailbox/queries.ts` (list views), `mailbox/messages.ts` (single message +
 * body), `mailbox/search.ts`.
 *
 * Distinct from CRM `contacts` and from the AI-shared `inboundMessages`
 * pipeline. See packages/shared/src/featureFlags.ts (`postbox` flag).
 */

import { v } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import { authedMutation, publicQuery } from '../../lib/authedFunctions';
import type { Id, Doc } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { requireAdminContext, getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import {
	throwForbidden,
	throwInvalidInput,
	throwAlreadyExists,
	throwNotFound,
} from '../../_utils/errors';
import { requireMailboxAccess, loadReadableMailbox } from '../permissions';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { normalizeEmail, parseAddress } from '@owlat/shared';
import { SYSTEM_FOLDER_NAMES, SYSTEM_FOLDER_ROLES, readSession } from './shared';

/**
 * The caller-visible personal mailbox for a member: their single `active`
 * mailbox, or null. Shared by the fresh-start surfaces (`mailboxRequest.request`,
 * `mailboxRequest.freshStartStatus`, `userOnboarding.completeFreshStart`) so
 * "does this member have a mailbox" means the SAME thing everywhere — an active
 * row, never a suspended/deleted one. A member whose only mailbox is suspended
 * still reaches the honest "ask an admin" escape hatch.
 *
 * A `scope='seed'` mailbox is skipped: a deliverability seed carries the
 * connecting ADMIN's `userId` (it has no other owner), but it is org
 * infrastructure, not their inbox. Counting one would tell
 * `mailboxRequest.freshStartStatus` / `userOnboarding.completeFreshStart` that
 * an admin who connected a seed already has a mailbox — a silent change to a
 * shipped flow.
 */
export async function getActiveMailboxForUser(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'mailboxes'> | null> {
	return await ctx.db
		.query('mailboxes')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.filter((q) => q.and(q.eq(q.field('status'), 'active'), q.neq(q.field('scope'), 'seed')))
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
		 * shared mailbox layers further member rows on top. 'seed' marks a
		 * deliverability seed mailbox — org infrastructure that is not anybody's
		 * inbox and is filtered out of every caller-visible mailbox surface.
		 */
		scope?: 'personal' | 'shared' | 'seed';
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

/**
 * Raw mailbox row by id, for Node actions that can't touch `ctx.db` directly
 * (`mailboxActions.pushMailboxToCache`, `aliasesActions`). Internal-only, so no
 * caller-facing access gate applies.
 */
export const getById = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => ctx.db.get(args.mailboxId),
});

export const remove = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const session = await requireAdminContext(ctx);
		// Admin role alone is not enough: bind the caller-supplied mailboxId to the
		// admin's own organization before deleting. A missing mailbox or one in
		// another org fails closed, so a mailboxId cannot delete a mailbox outside
		// the caller's org.
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox) throwNotFound('Mailbox');
		if (mailbox.organizationId !== session.activeOrganizationId) {
			throwForbidden('Mailbox not accessible');
		}
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
			// An external-backed mailbox (personal BYO or a shared team inbox) has a
			// live sync account; mark it `disconnected` so `listConnectableAccounts`
			// stops the mail-sync worker from syncing into a now-deleted mailbox. The
			// account row is retained for audit + the hard cascade-delete path (`purge`
			// for personal, `purgeShared` for a team inbox) — NOT for re-attach: a fresh
			// connect always provisions a new mailbox + account (the dup-check only sees
			// active rows), mirroring the soft `disconnect` mutation.
			if (mailbox.externalAccountId) {
				const account = await ctx.db.get(mailbox.externalAccountId);
				if (account && account.status !== 'disconnected') {
					const disconnectedAt = Date.now();
					await ctx.db.patch(mailbox.externalAccountId, {
						status: 'disconnected',
						updatedAt: disconnectedAt,
					});
					// Audit-trail parity with the soft `disconnect` mutation, which records
					// the same event — deleting an external-backed mailbox disconnects its
					// sync account, so the trail should show it.
					await ctx.db.insert('mailAuditLog', {
						mailboxId: args.mailboxId,
						event: 'external_account.disconnected',
						occurredAt: disconnectedAt,
					});
				}
			}
			await ctx.scheduler.runAfter(0, internal.mail.mailboxActions.removeFromCache, {
				address: mailbox.address,
			});
			// Sealed Mail (E6): revoke the mailbox address's E2EE key on deletion — stop
			// publishing it for sealing while retaining the row decrypt-only so historical
			// sealed mail still opens. Flag-gated the same way the mint on create is.
			if (await isFeatureEnabled(ctx, 'sealedMail')) {
				await ctx.scheduler.runAfter(0, internal.e2ee.lifecycle.deactivateAddressKeys, {
					address: mailbox.address,
				});
			}
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
