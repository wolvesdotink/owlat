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
 * live in the sibling `'use node'` file `externalAccountsActions.ts`.
 *
 *   Public:   getForCurrentUser, disconnect, purge
 *   Internal: _connectInternal, _updateCredentialsInternal (called by the
 *             connect action after encryption), _getRowInternal,
 *             listConnectableAccounts, setSyncStatus, resolveOutboundTransport
 *             (the mail-sync worker / outbound dispatcher surface, admin-key only)
 *
 * Read queries NEVER return the encrypted credential envelope — only the
 * mail-sync worker decrypts, via getCredentialsForWorker in the actions file.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { provisionMailbox, canonicalAddress, resolveDeliverableMailbox } from './mailbox';
import { markOnboardingStep } from '../auth/userOnboarding';
import { checkEmailDomainVerification } from '../domains/domains';
import { getMtaConfig } from './mtaClient';
import {
	throwForbidden,
	throwInvalidInput,
	throwAlreadyExists,
	throwNotFound,
} from '../_utils/errors';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

const PURGE_CHUNK = 200;

/**
 * The user's single LIVE external account — the one still connected/syncing.
 *
 * A user has at most one non-`disconnected` account (the connect guard enforces
 * it), but a completed "move my mailbox here" leaves a `disconnected` archive
 * row behind that COEXISTS with a freshly-connected account. `by_user` +
 * `.first()` returns the OLDEST row, so after a move it hands back the archive
 * and the live account is missed. Resolve by state instead: skip `disconnected`
 * rows and return the (unique) live one, or `null` when none is live.
 */
export async function getLiveExternalAccountForUser(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'externalMailAccounts'> | null> {
	const accounts = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.collect(); // bounded: ≤ 1 live + at most a handful of archived rows per user
	return accounts.find((a) => a.status !== 'disconnected') ?? null;
}

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
export const getForCurrentUser = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return { configured: false as const };
		// The LIVE account, not the caller's oldest row: a completed move leaves a
		// disconnected archive that would otherwise mask the reconnected account.
		const account = await getLiveExternalAccountForUser(ctx, s.userId);
		if (!account) return { configured: false as const };
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
			status: account.status,
			lastError: account.lastError,
			lastSyncAt: account.lastSyncAt,
			lastConnectedAt: account.lastConnectedAt,
		};
	},
});

/**
 * Soft-disconnect: stop syncing and hide the mailbox, but RETAIN the synced
 * messages (re-connect can re-attach). Use `purge` to also delete the data.
 */
export const disconnect = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		// Disconnect the LIVE account, not the caller's oldest row — otherwise a
		// completed move's disconnected archive would swallow the call while the
		// reconnected account keeps syncing.
		const account = await getLiveExternalAccountForUser(ctx, s.userId);
		if (!account) {
			// Nothing live to disconnect. Idempotent when an archived/disconnected row
			// already exists; a genuine miss (no account at all) is a not-found.
			const existing = await ctx.db
				.query('externalMailAccounts')
				.withIndex('by_user', (q) => q.eq('userId', s.userId))
				.first();
			if (existing) return { ok: true };
			throwNotFound('External mail account');
		}
		const now = Date.now();
		await ctx.db.patch(account._id, { status: 'disconnected', updatedAt: now });
		// Hide from the inbox UI (requireMailboxAccess refuses non-active rows).
		await ctx.db.patch(account.mailboxId, { status: 'deleted', updatedAt: now });
		await ctx.db.insert('mailAuditLog', {
			mailboxId: account.mailboxId,
			event: 'external_account.disconnected',
			occurredAt: now,
		});
		return { ok: true };
	},
});

/**
 * Hard delete: disconnect AND cascade-delete all synced data (messages + their
 * storage blobs, folders, threads, drafts, labels, sync cursors, the account
 * and mailbox rows). Runs in self-scheduling chunks so a large mailbox does not
 * exceed a single mutation's limits.
 */
// authz: self — purges only the caller's own external account (by_user on s.userId).
export const purge = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account) throwNotFound('External mail account');
		const now = Date.now();
		// Mark disconnected first so the worker stops syncing into a draining mailbox.
		await ctx.db.patch(account._id, { status: 'disconnected', updatedAt: now });
		await ctx.db.patch(account.mailboxId, { status: 'deleted', updatedAt: now });
		await ctx.scheduler.runAfter(0, internal.mail.externalAccounts._purgeChunk, {
			accountId: account._id,
			mailboxId: account.mailboxId,
		});
		return { ok: true };
	},
});

/**
 * One purge step: delete up to PURGE_CHUNK messages (and their storage blobs),
 * re-scheduling itself while messages remain. Once messages are drained, delete
 * the remaining per-mailbox rows and the account/mailbox themselves.
 */
export const _purgeChunk = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		mailboxId: v.id('mailboxes'),
	},
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.take(PURGE_CHUNK);
		for (const m of messages) {
			await ctx.storage.delete(m.rawStorageId).catch(() => undefined);
			if (m.textBodyStorageId) await ctx.storage.delete(m.textBodyStorageId).catch(() => undefined);
			if (m.htmlBodyStorageId) await ctx.storage.delete(m.htmlBodyStorageId).catch(() => undefined);
			await ctx.db.delete(m._id);
		}
		if (messages.length === PURGE_CHUNK) {
			await ctx.scheduler.runAfter(0, internal.mail.externalAccounts._purgeChunk, args);
			return;
		}

		// Messages drained — delete the rest. Each set is small per mailbox.
		const folders = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: per-mailbox folder set
		for (const f of folders) await ctx.db.delete(f._id);

		const threads = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', args.mailboxId))
			.take(1000); // bounded: drained after messages; capped defensively
		for (const t of threads) await ctx.db.delete(t._id);

		const drafts = await ctx.db
			.query('mailDrafts')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: per-mailbox drafts
		for (const d of drafts) await ctx.db.delete(d._id);

		const labels = await ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: per-mailbox labels
		for (const l of labels) await ctx.db.delete(l._id);

		const syncRows = await ctx.db
			.query('externalMailFolderSync')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.collect(); // bounded: per-account folder cursors (≤ a handful)
		for (const sr of syncRows) await ctx.db.delete(sr._id);

		// A staged "move my mailbox here" job points at this account — drop it too,
		// so its move row (and the terminal truth getLatestCallerMove surfaces from
		// it) doesn't linger as the newest move after the account is gone.
		const moves = await ctx.db
			.query('mailboxMoves')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.collect(); // bounded: ≤ 1 move per account
		for (const mv of moves) await ctx.db.delete(mv._id);

		await ctx.db.delete(args.accountId);
		await ctx.db.delete(args.mailboxId);
	},
});

// ── Internal: write path (called by the connect/update actions) ────────────

const connectFieldsValidator = {
	emailAddress: v.string(),
	imapHost: v.string(),
	imapPort: v.number(),
	isImapSecure: v.boolean(),
	smtpHost: v.string(),
	smtpPort: v.number(),
	isSmtpSecure: v.boolean(),
	imapUsername: v.string(),
	smtpUsername: v.optional(v.string()),
	authMethod: v.literal('password'),
	secretCiphertext: v.string(),
	secretIv: v.string(),
	secretAuthTag: v.string(),
	secretEnvelopeVersion: v.number(),
};

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
		const liveAccount = await getLiveExternalAccountForUser(ctx, s.userId);
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
		const mailboxId = await provisionMailbox(ctx, {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			address,
			domain,
			displayName: args.emailAddress,
			kind: 'external',
		});
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			mailboxId,
			imapHost: args.imapHost,
			imapPort: args.imapPort,
			isImapSecure: args.isImapSecure,
			smtpHost: args.smtpHost,
			smtpPort: args.smtpPort,
			isSmtpSecure: args.isSmtpSecure,
			authMethod: args.authMethod,
			imapUsername: args.imapUsername,
			smtpUsername: args.smtpUsername,
			secretCiphertext: args.secretCiphertext,
			secretIv: args.secretIv,
			secretAuthTag: args.secretAuthTag,
			secretEnvelopeVersion: args.secretEnvelopeVersion,
			status: 'pending',
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId, updatedAt: now });
		await markOnboardingStep(ctx, s.userId, 'mailboxReady');
		await ctx.db.insert('mailAuditLog', {
			mailboxId,
			event: 'external_account.connected',
			details: `${address} (imap ${args.imapHost}:${args.imapPort}, smtp ${args.smtpHost}:${args.smtpPort})`,
			occurredAt: now,
		});
		return { mailboxId, externalAccountId: accountId };
	},
});

/** Re-enter / change credentials + connection settings for the existing account. */
export const _updateCredentialsInternal = internalMutation({
	args: connectFieldsValidator,
	handler: async (ctx, args) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account) throwNotFound('External mail account');
		const now = Date.now();
		await ctx.db.patch(account._id, {
			imapHost: args.imapHost,
			imapPort: args.imapPort,
			isImapSecure: args.isImapSecure,
			smtpHost: args.smtpHost,
			smtpPort: args.smtpPort,
			isSmtpSecure: args.isSmtpSecure,
			authMethod: args.authMethod,
			imapUsername: args.imapUsername,
			smtpUsername: args.smtpUsername,
			secretCiphertext: args.secretCiphertext,
			secretIv: args.secretIv,
			secretAuthTag: args.secretAuthTag,
			secretEnvelopeVersion: args.secretEnvelopeVersion,
			// Reset to pending so the worker re-validates with the new creds.
			status: 'pending',
			lastError: undefined,
			updatedAt: now,
		});
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
 */
export const listConnectableAccounts = internalQuery({
	args: {},
	handler: async (ctx) => {
		const groups = await Promise.all(
			(['pending', 'connected', 'error'] as const).map(
				(status) =>
					ctx.db
						.query('externalMailAccounts')
						.withIndex('by_status', (q) => q.eq('status', status))
						.collect() // bounded: connectable accounts per single-org deployment (tens)
			)
		);
		return groups.flat().map((a) => ({
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

/**
 * Outbound transport decision for a mailbox. Returns `{kind:'hosted'}` for
 * Owlat-hosted mailboxes (MTA path) or `{kind:'external', smtp…}` (mail-sync
 * worker path). Never returns the password.
 */
export const resolveOutboundTransport = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox || mailbox.kind !== 'external' || !mailbox.externalAccountId) {
			return { kind: 'hosted' as const };
		}
		// Post-import "switch your sending": an external mailbox whose owner opted
		// into the instance transport ships through the hosted MTA path instead of
		// their own SMTP. The switch was gated on a verified from-domain + a
		// configured MTA (setSendingPreference), but the domain could have been
		// unverified/deleted or the transport removed since. Re-assert the gate
		// HERE so the DKIM-alignment claim stays true over time: if the instance
		// can no longer sign this from-domain, fall back to the user's own SMTP
		// rather than ship misaligned (or, on a torn-down MTA, silently dropped)
		// mail. undefined preference keeps the original external SMTP.
		if (mailbox.outboundPreference === 'instance') {
			const domainCheck = await checkEmailDomainVerification(ctx, mailbox.address);
			if (domainCheck.verified && getMtaConfig() !== null) {
				return { kind: 'hosted' as const };
			}
		}
		const account = await ctx.db.get(mailbox.externalAccountId);
		if (!account) return { kind: 'hosted' as const };
		return {
			kind: 'external' as const,
			externalAccountId: account._id,
			smtpHost: account.smtpHost,
			smtpPort: account.smtpPort,
			isSmtpSecure: account.isSmtpSecure,
			smtpUsername: account.smtpUsername ?? account.imapUsername,
			fromAddress: mailbox.address,
		};
	},
});
