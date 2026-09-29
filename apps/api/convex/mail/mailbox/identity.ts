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
import { adminQuery, publicQuery } from '../../lib/authedFunctions';
import { postboxMutation } from '../_helpers';
import type { Id, Doc } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { requireAdminContext, getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import {
	throwForbidden,
	throwInvalidInput,
	throwAlreadyExists,
	throwNotFound,
} from '../../_utils/errors';
import {
	requireMailboxAccess,
	loadReadableMailbox,
	loadAccessibleMailboxes,
	personalMailEnabled,
} from '../permissions';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { extractEmail } from '../../lib/emailAddress';
import { SYSTEM_FOLDER_NAMES, readSession } from './shared';
import { SYSTEM_FOLDER_ROLES } from '../../lib/validators/mail';
import { findAddressClaim } from './addressResolution';
import { stopExternalAccountSync } from '../external/accountTeardown';
import { startEmptyMailboxCounters } from '../messageCounters';

/**
 * The caller-visible personal mailbox for a member: their single `active`
 * mailbox, or null. Shared by the fresh-start surfaces (`mailboxRequest.request`,
 * `mailboxRequest.freshStartStatus`, `userOnboarding.completeFreshStart`) so
 * "does this member have a mailbox" means the SAME thing everywhere — an active
 * row, never a suspended/deleted one. A member whose only mailbox is suspended
 * still reaches the honest "ask an admin" escape hatch.
 *
 * Only a PERSONAL mailbox counts. A deliverability seed or a team inbox carries
 * the connecting or owning member's `userId`, but it is org infrastructure, not
 * their inbox. Counting one would tell `mailboxRequest.freshStartStatus` /
 * `userOnboarding.completeFreshStart` that an admin who connected a seed, or
 * whose own mailbox became a team inbox (`mail/teamInboxConversion.ts`), still
 * has a mailbox of their own.
 */
export async function getActiveMailboxForUser(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'mailboxes'> | null> {
	return await ctx.db
		.query('mailboxes')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.filter((q) =>
			q.and(
				q.eq(q.field('status'), 'active'),
				q.neq(q.field('scope'), 'seed'),
				q.neq(q.field('scope'), 'shared')
			)
		)
		.first();
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
	// at provision time; shared mailboxes add further rows later. (Mailboxes
	// that predate the table were given theirs by a one-shot backfill.)
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
		const folderId = await ctx.db.insert('mailFolders', {
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
		// A new mailbox holds no mail: its counters (plan 3.1) start out exact.
		if (role === 'inbox') await startEmptyMailboxCounters(ctx, mailboxId, folderId);
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
 * Canonicalize + validate an address, reject one a mailbox already claims, and
 * provision the row. The shared body behind the admin `create` (personal) path
 * and `mailboxMembers.createShared` (team) path so the two never drift on
 * address normalization, the claim check (`findAddressClaim`), or the
 * provisioning call. Callers own their own auth gate and any scope-specific
 * checks (e.g. verified-domain).
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
	const address = extractEmail(args.address);
	const [, domain] = address.split('@');
	if (!domain) {
		throwInvalidInput('Invalid email address');
	}

	if (await findAddressClaim(ctx, address)) {
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

export const create = postboxMutation({
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

/**
 * The caller's own mailboxes plus the shared inboxes they are an explicit
 * member of, in `active` or `suspended` status (never soft-deleted). Built on
 * `loadAccessibleMailboxes`, the one enumeration of "my mailboxes", so it has
 * the same seed exclusion, org scoping and personal-mail floor as the Postbox
 * switcher. Owners and admins get their own set here too; the org-wide admin
 * list is `listOrgMailboxes`.
 */
// public: soft-auth — returns empty for anonymous; access via loadAccessibleMailboxes (own + shared memberships)
export const list = publicQuery({
	args: {},
	handler: async (ctx) => {
		const session = await readSession(ctx);
		if (!session) return [];
		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		// Active rows first, own mailboxes ahead of team inboxes within each
		// status: Postbox and quick-create default to `list[0]`, which should be
		// the caller's own live inbox rather than a paused one.
		return [
			...mailboxes.filter((m) => m.status === 'active'),
			...mailboxes.filter((m) => m.status === 'suspended'),
		];
	},
});

/**
 * Every active or suspended mailbox in the admin's active organization, for
 * the admin rename/delete list in Preferences. Deliverability seed mailboxes
 * are left out: they are managed from the seed screen, and deleting one here
 * would orphan its account row.
 */
// authz: adminQuery floor (organization:manage); rows scoped to the caller's active organization
export const listOrgMailboxes = adminQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		// Same soft floor as `list`: no personal-mail capability, no mailboxes.
		if (!(await personalMailEnabled(ctx))) return [];
		// Two `by_status` index reads (active + suspended) skip deleted rows at
		// the DB layer.
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
		return [...active, ...suspended].filter(
			(m) => m.organizationId === session.activeOrganizationId && m.scope !== 'seed'
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

export const remove = postboxMutation({
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
			// live sync account. The shared teardown marks it `disconnected` (so
			// `listConnectableAccounts` stops the mail-sync worker from syncing into a
			// now-deleted mailbox), drops the stored password, cancels any running
			// import, and records the same `external_account.disconnected` audit event
			// the member-facing `disconnect` writes. The account row itself is kept for
			// the audit trail and the hard cascade-delete path (`purge` for personal,
			// `purgeShared` for a team inbox). Note that the OWNER of a personal
			// mailbox removed this way can reconnect the same address and get this
			// mailbox, and its retained mail, back (`_connectInternal` re-attaches a
			// soft-deleted mailbox they own); an admin who means the mail to be gone
			// wants the purge, not this.
			if (mailbox.externalAccountId) {
				const account = await ctx.db.get(mailbox.externalAccountId);
				if (account && account.status !== 'disconnected') {
					await stopExternalAccountSync(ctx, account, { now: Date.now(), reason: 'admin' });
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
export const setDisplayName = postboxMutation({
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
