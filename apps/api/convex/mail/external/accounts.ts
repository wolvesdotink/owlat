/**
 * External mailbox accounts (BYO IMAP/SMTP) — v8 runtime surface.
 *
 * Lets a user connect their own existing mailbox (Gmail, Fastmail, a company
 * server) so they get personal mail (send + receive) WITHOUT registering a
 * sending domain. The connected account owns a `mailboxes` row with
 * kind='external'; the inbox UI then reads it like any other mailbox.
 *
 * This file holds the v8 (non-Node) surface: user-facing queries/mutations and
 * the worker-facing internal functions. Crypto + the plaintext credential path
 * live in the sibling `'use node'` file `accountsActions.ts`.
 *
 * The same machinery also backs a SHARED team inbox — connecting an external
 * account provisions a `kind='external', scope='shared'` mailbox (access
 * governed by `mailboxMembers`) instead of a personal 1:1 account. That path
 * lives in the sibling `mail/external/sharedInbox.ts` (it reuses the shared
 * `connectFieldsValidator` from `accountShared.ts`). Whether an account is personal is decided
 * by its MAILBOX's `scope`, never by the account row (see `personalAccount.ts`),
 * so a personal mailbox that becomes a team inbox (`mail/teamInboxConversion.ts`)
 * leaves the personal-external surfaces below in the same write.
 *
 * A third path — the DELIVERABILITY SEED mailbox — lives in the sibling
 * `mail/external/accountsSeed.ts`. It reuses the shared `connectFieldsValidator`
 * and the same sealed envelope, but a seed is not an inbox at all: the
 * `purpose='seed'` discriminator keeps it off every personal-external surface
 * below and out of `listConnectableAccounts`.
 *
 *   Public:   getForCurrentUser, disconnect, purge
 *   Internal: _connectInternal, _updateCredentialsInternal (called by the
 *             connect actions after encryption), _getRowInternal,
 *             listConnectableAccounts, setSyncStatus
 *
 * What DISCONNECTING does — forgetting the password, cancelling a running
 * import, hiding the mailbox — and the purge cascade both live in the sibling
 * `mail/external/accountTeardown.ts`, shared with the seed and team-inbox paths.
 *
 * The outbound transport decision for a mailbox (hosted MTA vs the user's own
 * SMTP) lives in the sibling `mail/outboundTransport.ts`, not here — it is not
 * external-account-specific and is shared with the onboarding "first send" gate.
 *
 * Read queries NEVER return the encrypted credential envelope — only the
 * mail-sync worker decrypts, via getCredentialsForWorker in the actions file.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { authedMutation, publicQuery } from '../../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { assertFeatureEnabled } from '../../lib/featureFlags';
import { provisionMailbox, canonicalAddress, resolveDeliverableMailbox } from '../mailbox/identity';
import {
	personalAccounts,
	getLivePersonalExternalAccountForUser,
	findRetainedPersonalAccount,
} from './personalAccount';
import {
	connectFieldsValidator,
	insertExternalAccountRow,
	applyCredentialRotation,
	CONNECTABLE_ACCOUNT_STATUSES,
} from './accountShared';
import { stopExternalAccountSync, prepareAccountPurge } from './accountTeardown';
import { markOnboardingStep } from '../../auth/userOnboarding';
import {
	throwForbidden,
	throwInvalidInput,
	throwAlreadyExists,
	throwNotFound,
} from '../../_utils/errors';

const accountStatusValidator = v.union(
	v.literal('pending'),
	v.literal('connected'),
	v.literal('auth_error'),
	v.literal('error'),
	v.literal('disconnected')
);

// ── Public: the connecting user's own account ─────────────────────────────

/**
 * The current user's connected external account, or `{ configured: false }`.
 * NEVER returns the encrypted credential fields.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
// authz: self-scoped — reads only the session user's own external account.
export const getForCurrentUser = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return { configured: false as const };
		// The LIVE personal account, not the caller's oldest row: a completed move
		// leaves a disconnected archive that would otherwise mask the reconnected
		// account. A shared team inbox the caller connected is not their own mailbox.
		const account = await getLivePersonalExternalAccountForUser(ctx, s.userId);
		if (!account) {
			// Nothing syncing — but a disconnected mailbox may still be holding the
			// mail it kept. The settings card offers exactly two things for that
			// state (reconnect, or delete what was kept), and it can only offer them
			// if it knows the mailbox is there.
			const retained = await findRetainedPersonalAccount(ctx, s.userId, { forDeletion: true });
			if (!retained) return { configured: false as const };
			return {
				configured: false as const,
				retained: {
					emailAddress: retained.mailbox.address,
					imapHost: retained.account.imapHost,
					imapUsername: retained.account.imapUsername,
					disconnectedAt: retained.account.updatedAt,
					// Whether reconnecting this address re-opens THIS mailbox. False
					// when an admin retired it: connecting again is allowed and
					// provisions a fresh mailbox, but the mail kept here does not come
					// back with it, so the screen must not promise that it will.
					canReattach: retained.account.adminRetiredAt === undefined,
				},
			};
		}
		const mailbox = await ctx.db.get(account.mailboxId);
		return {
			configured: true as const,
			_id: account._id,
			mailboxId: account.mailboxId,
			emailAddress: mailbox?.address ?? account.imapUsername,
			imapHost: account.imapHost,
			imapPort: account.imapPort,
			isImapSecure: account.isImapSecure,
			smtpHost: account.smtpHost,
			smtpPort: account.smtpPort,
			isSmtpSecure: account.isSmtpSecure,
			imapUsername: account.imapUsername,
			smtpUsername: account.smtpUsername,
			// How the account authenticates, so the connect form can offer
			// "Reconnect with Google" instead of a password field. Never a credential.
			authMethod: account.authMethod,
			oauthProvider: account.oauthProvider,
			status: account.status,
			lastError: account.lastError,
			lastSyncAt: account.lastSyncAt,
			lastConnectedAt: account.lastConnectedAt,
		};
	},
});

/**
 * Soft-disconnect: stop syncing, forget the stored password, and hide the
 * mailbox, while RETAINING the messages already synced. Reconnecting the same
 * address re-attaches this mailbox (see `_connectInternal`), so the retained
 * mail comes back rather than sitting in a row nobody can reach. Use `purge` to
 * delete the data instead of keeping it.
 */
// authz: self — disconnects only the caller's own external account (resolved by userId).
export const disconnect = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		// Disconnect the LIVE account, not the caller's oldest row — otherwise a
		// completed move's disconnected archive would swallow the call while the
		// reconnected account keeps syncing.
		const account = await getLivePersonalExternalAccountForUser(ctx, s.userId);
		if (!account) {
			// Nothing live to disconnect. Idempotent when an archived/disconnected
			// PERSONAL row already exists; a genuine miss (no personal account at all,
			// even if the caller connected a shared team inbox) is a not-found.
			const rows = await ctx.db
				.query('externalMailAccounts')
				.withIndex('by_user', (q) => q.eq('userId', s.userId))
				.collect(); // bounded: a handful of the caller's own account rows
			if ((await personalAccounts(ctx, rows)).length > 0) {
				return { ok: true, cancelledMigration: false };
			}
			throwNotFound('External mail account');
		}
		const { cancelledMigration } = await stopExternalAccountSync(ctx, account, {
			now: Date.now(),
			reason: 'member',
		});
		return { ok: true, cancelledMigration };
	},
});

/**
 * Hard delete: disconnect AND cascade-delete all synced data (messages + their
 * storage blobs, folders, threads, drafts, labels, app passwords, memberships,
 * sync cursors, migration records, the account and mailbox rows). Runs in
 * self-scheduling chunks so a large mailbox does not exceed a single mutation's
 * limits. The cascade itself is `accountTeardown._purgeChunk`.
 */
// authz: self — purges only the caller's own external account (resolved by userId).
export const purge = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		// The LIVE personal account, or else the exact mailbox `getForCurrentUser`
		// reports as retained — the two resolutions have to agree, because the only
		// screen that calls this shows one address and offers one button.
		//
		// They did not. This used to fall back to the caller's NEWEST personal row
		// with no state filter, which on a second disconnected row deleted a
		// different mailbox than the one named on screen, and on a completed move
		// deleted the read-only archive this docstring promises to keep. A shared
		// team inbox is org infrastructure and is never reachable through this
		// personal path either way.
		const live = await getLivePersonalExternalAccountForUser(ctx, s.userId);
		const account =
			live ?? (await findRetainedPersonalAccount(ctx, s.userId, { forDeletion: true }))?.account;
		if (!account) throwNotFound('External mail account');
		// Stop the worker (so it isn't syncing into a draining mailbox), then cascade.
		await prepareAccountPurge(ctx, account, Date.now());
		await ctx.scheduler.runAfter(0, internal.mail.external.accountTeardown._purgeChunk, {
			accountId: account._id,
			mailboxId: account.mailboxId,
		});
		return { ok: true };
	},
});

// ── Internal: write path (called by the connect/update actions) ────────────
// The argument shape every persistence mutation here takes lives beside the row
// writers in `accountShared.ts` (`connectFieldsValidator`), re-exported below so
// the sibling connect paths keep importing one name.

export { connectFieldsValidator };

/**
 * Insert the account row + provision its external mailbox. Re-resolves the
 * session (propagated from the calling action) for ownership; the action has
 * already encrypted the credentials.
 */
export const _connectInternal = internalMutation({
	args: connectFieldsValidator,
	handler: async (ctx, args) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.activeOrganizationId || !s.role) throwForbidden('Not authenticated');
		const address = canonicalAddress(args.emailAddress);
		const [, domain] = address.split('@');
		if (!domain) throwInvalidInput('Invalid email address');

		// One LIVE external account per user (v1). A completed move's disconnected
		// archive row doesn't count — check for a live account by state, not the
		// oldest row, so a reconnect after a move isn't blocked by (nor slips past)
		// the archive.
		const liveAccount = await getLivePersonalExternalAccountForUser(ctx, s.userId);
		if (liveAccount) {
			throwAlreadyExists(
				'You already have a connected external mail account. Disconnect it before connecting another.'
			);
		}
		// The address must not collide with any existing active mailbox (hosted or
		// an external archive left by a completed move) — resolve deterministically
		// rather than trusting whichever row is oldest.
		const existingMailbox = await resolveDeliverableMailbox(ctx, address);
		if (existingMailbox) {
			throwAlreadyExists(`A mailbox for ${address} already exists.`);
		}

		const now = Date.now();
		// Reconnecting an address this person disconnected re-opens THAT mailbox,
		// with the mail it kept, rather than starting a second one beside it. The
		// row's own organization has to be the caller's active one: everything else
		// in this handler takes the org off the session, and a row carrying another
		// one is not this tenant's to revive.
		const retained = await findRetainedPersonalAccount(ctx, s.userId, { address });
		if (retained && retained.account.organizationId === s.activeOrganizationId) {
			await applyCredentialRotation(ctx, retained.account._id, args, now);
			await ctx.db.patch(retained.mailbox._id, { status: 'active', updatedAt: now });
			await ctx.db.insert('mailAuditLog', {
				mailboxId: retained.mailbox._id,
				event: 'external_account.reconnected',
				details: address,
				occurredAt: now,
			});
			await markOnboardingStep(ctx, s.userId, 'mailboxReady');
			return { mailboxId: retained.mailbox._id, externalAccountId: retained.account._id };
		}
		const mailboxId = await provisionMailbox(ctx, {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			address,
			domain,
			displayName: args.emailAddress,
			kind: 'external',
		});
		const accountId = await insertExternalAccountRow(ctx, {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			mailboxId,
			address,
			fields: args,
			now,
		});
		await markOnboardingStep(ctx, s.userId, 'mailboxReady');
		return { mailboxId, externalAccountId: accountId };
	},
});

/** Re-enter / change credentials + connection settings for the existing account. */
export const _updateCredentialsInternal = internalMutation({
	args: connectFieldsValidator,
	handler: async (ctx, args) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		// Re-enter credentials for the LIVE account only. Post-move, the oldest row
		// is the read-only archive — patching it (new host/username/ciphertext + a
		// reset to 'pending') would make listConnectableAccounts resume syncing into
		// the demoted mailbox, cross-contaminating archived history. Re-entering
		// credentials for an archive is meaningless (reconnect is the path), so a
		// missing live account is a not-found.
		const account = await getLivePersonalExternalAccountForUser(ctx, s.userId);
		if (!account) throwNotFound('External mail account');
		const now = Date.now();
		await applyCredentialRotation(ctx, account._id, args, now);
		// If it was soft-disconnected, re-activate the mailbox.
		const mailbox = await ctx.db.get(account.mailboxId);
		if (mailbox && mailbox.status === 'deleted') {
			await ctx.db.patch(account.mailboxId, { status: 'active', updatedAt: now });
		}
		return { mailboxId: account.mailboxId, externalAccountId: account._id };
	},
});

/** Full row incl. ciphertext — internal only, for the worker-credential action. */
export const _getRowInternal = internalQuery({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => ctx.db.get(args.accountId),
});

// ── Internal: the mail-sync worker surface (admin-key only) ────────────────

/**
 * Accounts the worker should hold a connection for. Excludes `auth_error`
 * (waiting on the user to fix credentials) and `disconnected`. No secrets — the
 * worker fetches the password per-account via getCredentialsForWorker.
 *
 * SEED mailboxes are excluded outright. A seed is not a user inbox: it exists
 * only so the deliverability prober can look for its own shadow copies, and
 * `schema/mail.ts` promises that "its mail is never indexed". Handing one to
 * the inbound AccountManager would open an IMAP IDLE connection to the
 * operator's personal consumer mailbox and ingest its entire contents — blobs
 * and `mailMessages` rows — into Convex as an ordinary Postbox mailbox, plus
 * re-ingest every shadow copy as inbound mail and race the prober's sweep on
 * `\Seen`. The prober selects its own accounts via `by_purpose`.
 */
export const listConnectableAccounts = internalQuery({
	args: {},
	handler: async (ctx) => {
		const groups = await Promise.all(
			CONNECTABLE_ACCOUNT_STATUSES.map(
				(status) =>
					ctx.db
						.query('externalMailAccounts')
						.withIndex('by_status', (q) => q.eq('status', status))
						.collect() // bounded: connectable accounts per single-org deployment (tens)
			)
		);
		return groups
			.flat()
			.filter((a) => a.purpose !== 'seed')
			.map((a) => ({
				accountId: a._id,
				mailboxId: a.mailboxId,
				imapHost: a.imapHost,
				imapPort: a.imapPort,
				isImapSecure: a.isImapSecure,
				imapUsername: a.imapUsername,
				status: a.status,
			}));
	},
});

/** Worker writes connection/sync status here. */
export const setSyncStatus = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		status: accountStatusValidator,
		lastError: v.optional(v.string()),
		markSynced: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const account = await ctx.db.get(args.accountId);
		if (!account) return;
		// Disconnection is the member's decision, never the worker's observation of
		// one. A connection already in its reconnect backoff keeps reporting for up
		// to a reconcile tick after the account is torn down, and its very next
		// report is `error` — "credentials unavailable", because the teardown just
		// dropped them. Letting that land would put the row back into a connectable
		// status with no password, permanently: the worker would keep retrying, the
		// mailbox would stay hidden, and the one-live-account guard would refuse the
		// reconnect that could fix it.
		if (account.status === 'disconnected') return;
		const now = Date.now();
		const patch: Record<string, unknown> = { status: args.status, updatedAt: now };
		if (args.status === 'connected') {
			patch['lastConnectedAt'] = now;
			patch['lastError'] = undefined;
			patch['lastErrorAt'] = undefined;
		}
		if (args.status === 'auth_error' || args.status === 'error') {
			patch['lastError'] = args.lastError;
			patch['lastErrorAt'] = now;
		}
		if (args.markSynced) patch['lastSyncAt'] = now;
		await ctx.db.patch(args.accountId, patch);
	},
});
