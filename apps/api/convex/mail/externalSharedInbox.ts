/**
 * External account connected AS A SHARED TEAM INBOX (issue #234) — the
 * external-transport twin of `mailboxMembers.createShared`.
 *
 * Split out of `externalAccounts.ts` (kept under the ~500 LOC cap): the personal
 * BYO-mailbox lifecycle there is per-user 1:1, whereas this path provisions a
 * `kind='external', scope='shared'` mailbox governed by `mailboxMembers`. It
 * reuses that file's `connectFieldsValidator` (the encrypted-envelope shape the
 * connect action hands over) and the shared provisioning helpers, so the two
 * connect paths never drift on address normalization or credential storage.
 *
 * Ownership / credential model (see the `scope` field on `externalMailAccounts`):
 *   - The connecting admin becomes the mailbox's canonical owner
 *     (`provisionMailbox` inserts the owner `mailboxMembers` row); initial
 *     `memberUserIds` are seeded as members. Access is transport-agnostic —
 *     `requireMailboxAccess` never inspects `kind`.
 *   - The credentials live on ONE `externalMailAccounts` row (encrypted at rest,
 *     decrypted only by the mail-sync worker) 1:1 with the mailbox, carrying
 *     `scope='shared'`. That discriminator excludes the account from the per-user
 *     "one live personal external account" limit and from the personal-external
 *     surfaces (getForCurrentUser / disconnect / purge / the move flow). `userId`
 *     records the connecting admin (credential custodian + audit); the org owns it.
 *
 * Credential rotation / repair + hard purge for a shared inbox (issue #234):
 *   - The personal `updateCredentials` / `purge` in `externalAccounts.ts` resolve
 *     the caller's LIVE PERSONAL account and so can never reach a team inbox. A
 *     shared inbox therefore needs its own ADMIN-gated twins, keyed by mailbox id:
 *       · `getSharedExternalAccount` (owner/admin) — the non-secret connection
 *         fields + live status/lastError, for the reconnect form's prefill and the
 *         admin auth_error badge.
 *       · `_updateCredentialsSharedInternal` (called by the connect action after
 *         encryption) — rotate the mailbox-linked account's credentials + reset it
 *         to `pending` so the worker re-validates a live (auth_error) inbox.
 *       · `purgeShared` — the hard cascade-delete for a removed team inbox (the
 *         personal `purge` is unreachable for shared), so the encrypted credential
 *         row + synced data don't linger forever.
 *
 *   Public:   getSharedExternalAccount, purgeShared
 *   Internal: _connectSharedInternal, _updateCredentialsSharedInternal (both
 *             called by externalAccountsActions after encryption).
 *
 * NO HISTORICAL BACKFILL (deliberate scope decision — issue #234): a connected
 * shared inbox starts empty and only receives mail that arrives from the connect
 * onward (the forward-sync worker seeds its cursor at `uidNext-1`). The historical
 * migration path (`mail/migration.ts`) is intentionally personal-only — it drives
 * onboarding side effects and resolves the caller's LIVE PERSONAL account — so a
 * team inbox never masks a user's own migration. Importing an external team
 * inbox's existing mail (an admin-gated migration keyed by `mailboxId`) is a
 * separate follow-up; the wizard success copy is honest about it
 * (`add-account.vue`: "Mail already in the account isn't imported").
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireAdminContext } from '../lib/sessionOrganization';
import { provisionMailbox, canonicalAddress, resolveDeliverableMailbox } from './mailbox';
import { connectFieldsValidator } from './externalAccounts';
import { insertExternalAccountRow, applyCredentialRotation } from './externalAccountShared';
import { seedSharedInboxRoster } from './mailboxMembers';
import { requireMailboxAccess } from './permissions';
import { isFeatureEnabled } from '../lib/featureFlags';
import {
	throwInvalidInput,
	throwAlreadyExists,
	throwForbidden,
	throwNotFound,
} from '../_utils/errors';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * Load the `scope='shared'`, `kind='external'` mailbox + its linked credential
 * account for an admin-gated repair/purge, or throw. Gated at the `owner` floor
 * of `requireMailboxAccess` (which also admits org owner/admin — the same floor
 * every team-inbox management surface uses). Refuses a personal or hosted mailbox
 * so these twins can only ever touch a shared external inbox.
 */
async function requireSharedExternalAccount(
	ctx: QueryCtx | MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<{ mailbox: Doc<'mailboxes'>; account: Doc<'externalMailAccounts'> }> {
	const access = await requireMailboxAccess(ctx, mailboxId, 'owner');
	if (!access.ok) {
		throwForbidden('You do not have permission to manage this inbox.');
	}
	const { mailbox } = access;
	if (mailbox.scope !== 'shared' || mailbox.kind !== 'external' || !mailbox.externalAccountId) {
		throwInvalidInput('This is not an external team inbox.');
	}
	const account = await ctx.db.get(mailbox.externalAccountId);
	if (!account) throwNotFound('External mail account');
	return { mailbox, account };
}

/**
 * Provision a shared external mailbox + its credential account + initial roster
 * in one motion. Admin-gated (a team inbox is org infrastructure, mirroring
 * `mailboxMembers.createShared`). Re-resolves the session propagated from the
 * calling action; the action has already encrypted the credentials.
 *
 * Unlike the personal `_connectInternal` there is NO one-live-per-user guard (a
 * user may own many shared inboxes) and NO `mailboxReady` onboarding stamp (a
 * team inbox is not the admin's personal mailbox).
 */
export const _connectSharedInternal = internalMutation({
	args: {
		...connectFieldsValidator,
		displayName: v.optional(v.string()),
		memberUserIds: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		// Admin floor (a team inbox is org infrastructure) — the returned context
		// carries the connecting admin's userId + activeOrganizationId; no second
		// session resolution needed.
		const s = await requireAdminContext(ctx);
		const address = canonicalAddress(args.emailAddress);
		const [, domain] = address.split('@');
		if (!domain) throwInvalidInput('Invalid email address');

		// The address must not collide with any existing active mailbox (hosted or
		// external) — resolve deterministically rather than trusting the oldest row.
		const existingMailbox = await resolveDeliverableMailbox(ctx, address);
		if (existingMailbox) {
			throwAlreadyExists(`A mailbox for ${address} already exists.`);
		}

		const now = Date.now();
		const mailboxId = await provisionMailbox(ctx, {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			address,
			domain,
			displayName: args.displayName ?? args.emailAddress,
			kind: 'external',
			scope: 'shared',
		});
		const accountId = await insertExternalAccountRow(ctx, {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			mailboxId,
			address,
			scope: 'shared',
			auditPrefix: 'shared ',
			fields: args,
			now,
		});
		// Validate + seed the initial roster (the owner membership was inserted by
		// provisionMailbox). A bogus member id throws and rolls the whole connect
		// back — Convex mutations are transactional — so nothing above survives.
		await seedSharedInboxRoster(ctx, {
			mailboxId,
			creatorUserId: s.userId,
			memberUserIds: args.memberUserIds,
			now,
		});
		return { mailboxId, externalAccountId: accountId };
	},
});

/**
 * The non-secret connection fields + live status of a shared external inbox's
 * credential account — the data the admin reconnect form prefills and the
 * auth_error badge reads. Owner/admin-gated; NEVER returns the encrypted
 * envelope. Returns `{ configured: false }` for a caller without access or a
 * mailbox that isn't a shared external inbox (soft-fail, like getForCurrentUser).
 */
export const getSharedExternalAccount = authedQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const access = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!access.ok) return { configured: false as const };
		const { mailbox } = access;
		if (mailbox.scope !== 'shared' || mailbox.kind !== 'external' || !mailbox.externalAccountId) {
			return { configured: false as const };
		}
		const account = await ctx.db.get(mailbox.externalAccountId);
		if (!account) return { configured: false as const };
		return {
			configured: true as const,
			mailboxId: mailbox._id,
			emailAddress: mailbox.address,
			imapHost: account.imapHost,
			imapPort: account.imapPort,
			isImapSecure: account.isImapSecure,
			smtpHost: account.smtpHost,
			smtpPort: account.smtpPort,
			isSmtpSecure: account.isSmtpSecure,
			imapUsername: account.imapUsername,
			smtpUsername: account.smtpUsername,
			status: account.status,
			lastError: account.lastError,
			lastSyncAt: account.lastSyncAt,
			lastConnectedAt: account.lastConnectedAt,
		};
	},
});

/**
 * Rotate / repair a shared external inbox's credentials + connection settings.
 * The admin-gated twin of `_updateCredentialsInternal` — that one resolves the
 * caller's LIVE PERSONAL account and can never reach a team inbox, so a rotated
 * app password would otherwise brick the shared inbox permanently. Re-resolves
 * the session propagated from the calling action; the action has already
 * encrypted the credentials. Resets the account to `pending` so the worker
 * re-validates with the new credentials on its next pass.
 */
export const _updateCredentialsSharedInternal = internalMutation({
	args: { ...connectFieldsValidator, mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		// authz: requireSharedExternalAccount → requireMailboxAccess(owner) + shared-external gate.
		const { account } = await requireSharedExternalAccount(ctx, args.mailboxId);
		const now = Date.now();
		await applyCredentialRotation(ctx, account._id, args, now);
		await ctx.db.insert('mailAuditLog', {
			mailboxId: account.mailboxId,
			event: 'external_account.credentials_updated',
			occurredAt: now,
		});
		return { mailboxId: account.mailboxId, externalAccountId: account._id };
	},
});

/**
 * Hard-purge a REMOVED shared external inbox: cascade-delete its synced data
 * (messages + storage blobs, folders, threads, drafts, labels, sync cursors) and
 * the account + mailbox rows, plus the membership roster. The personal `purge`
 * resolves the caller's live personal account, so it can never reach a team
 * inbox — without this, a removed shared inbox's encrypted credential row and
 * synced data would linger forever. Admin-gated (org infrastructure); works on a
 * mailbox in any status (a removed inbox is soft-deleted, which `requireMailboxAccess`
 * would refuse) — so it re-checks admin + shared-external scope by hand.
 */
export const purgeShared = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		// authz: requireAdminContext (team inbox = org infrastructure) + shared-external scope gate.
		const s = await requireAdminContext(ctx);
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox) throwNotFound('Team inbox');
		if (mailbox.organizationId !== s.activeOrganizationId) {
			throwForbidden('You do not have permission to manage this inbox.');
		}
		if (mailbox.scope !== 'shared' || mailbox.kind !== 'external' || !mailbox.externalAccountId) {
			throwInvalidInput('This is not an external team inbox.');
		}
		const now = Date.now();
		// A purge may be invoked directly on a still-ACTIVE inbox (the docstring
		// promises any status), so mirror `mailbox.remove`'s address teardown that a
		// prior `remove` would otherwise have done: evict the address from the routing
		// cache and, when Sealed Mail is on, revoke its E2EE address key. Without this,
		// purging a live shared inbox deletes the mailbox while other instances keep
		// sealing mail to a now-dead published address.
		await ctx.scheduler.runAfter(0, internal.mail.mailboxActions.removeFromCache, {
			address: mailbox.address,
		});
		if (await isFeatureEnabled(ctx, 'sealedMail')) {
			await ctx.scheduler.runAfter(0, internal.e2ee.lifecycle.deactivateAddressKeys, {
				address: mailbox.address,
			});
		}
		// Stop the worker syncing into a draining mailbox, then hide it.
		await ctx.db.patch(mailbox.externalAccountId, { status: 'disconnected', updatedAt: now });
		await ctx.db.patch(mailbox._id, { status: 'deleted', updatedAt: now });
		// Drop the roster + any un-accepted grants up front (bounded per inbox); the
		// scheduled cascade below handles the unbounded per-message data.
		for (const row of await ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailbox._id))
			.collect()) {
			await ctx.db.delete(row._id); // bounded: one team's roster
		}
		for (const grant of await ctx.db
			.query('pendingMailboxMembers')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
			.collect()) {
			await ctx.db.delete(grant._id); // bounded: open invites on one inbox
		}
		await ctx.scheduler.runAfter(0, internal.mail.externalAccounts._purgeChunk, {
			accountId: mailbox.externalAccountId,
			mailboxId: mailbox._id,
		});
		return { ok: true as const };
	},
});
