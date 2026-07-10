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
import { provisionMailbox, canonicalAddress } from './mailbox';
import { markOnboardingStep } from '../auth/userOnboarding';
import { checkEmailDomainVerification } from '../domains/domains';
import { isDeliveryConfigured } from '../lib/sendProviders/capability';
import {
	throwForbidden,
	throwInvalidInput,
	throwInvalidState,
	throwAlreadyExists,
	throwNotFound,
} from '../_utils/errors';

const PURGE_CHUNK = 200;

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
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account || account.status === 'disconnected') return { configured: false as const };
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

// ── Post-import "switch your sending" (outbound-only, gated) ───────────────

/**
 * Prompt + settings state for the caller's own external mailbox's outbound
 * transport. After an import a mailbox sends through the user's own SMTP
 * (`preference: 'external'`); once their from-domain is verified on THIS
 * instance and a transport is configured, they can flip to `'instance'` so mail
 * ships from Owlat's reputation instead.
 *
 * `promptEligible` is true ONLY when every gate holds — import + knowledge
 * indexing complete, the from-domain is a VERIFIED sending domain here (so DKIM
 * aligns), and an instance transport is configured — and the mailbox is still on
 * its own SMTP. We NEVER offer the switch for an unverified domain (no spoofing
 * gmail.com). The Postbox → Sending section reuses this to render the reversible
 * toggle even after the prompt is gone.
 */
// public: soft-auth — returns { configured:false } for anonymous or hosted-only users.
export const sendingSwitchStatus = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return { configured: false as const };
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account || account.status === 'disconnected') return { configured: false as const };
		const mailbox = await ctx.db.get(account.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return { configured: false as const };

		const preference = mailbox.outboundPreference ?? 'external';
		const [domainCheck, transportConfigured, onboarding] = await Promise.all([
			checkEmailDomainVerification(ctx, mailbox.address),
			isDeliveryConfigured(ctx),
			ctx.db
				.query('userOnboarding')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', s.userId))
				.first(),
		]);
		const domainVerified = domainCheck.verified;
		// "import + knowledge indexing complete" — both stamps present.
		const importAndIndexingDone =
			!!onboarding && onboarding.importDone != null && onboarding.knowledgeIndexed != null;

		const promptEligible =
			preference === 'external' && importAndIndexingDone && domainVerified && transportConfigured;

		return {
			configured: true as const,
			mailboxId: mailbox._id,
			address: mailbox.address,
			domain: domainCheck.domain || mailbox.domain,
			preference,
			domainVerified,
			transportConfigured,
			promptEligible,
		};
	},
});

/**
 * Flip the caller's external mailbox between sending through their own SMTP
 * (`'external'`) and this deployment's transport (`'instance'`). Reversible any
 * time from Postbox → Sending. Switching TO `'instance'` is hard-gated: the
 * from-domain must be a verified sending domain on this instance (asserting the
 * MTA/SES identity exists so DKIM aligns) AND a transport must be configured. We
 * refuse an unverified domain outright. The switch to instance completes the
 * `sendingSwitched` onboarding step; reverting leaves it (the decision was made).
 */
// authz: self — operates on the caller's own external mailbox (by_user on s.userId).
export const setSendingPreference = authedMutation({
	args: { preference: v.union(v.literal('external'), v.literal('instance')) },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account) throwNotFound('External mail account');
		const mailbox = await ctx.db.get(account.mailboxId);
		if (!mailbox || mailbox.status !== 'active') throwNotFound('Mailbox');

		if (args.preference === 'instance') {
			// Gate 1 — verified from-domain. Never let mail ship from an identity
			// the instance can't DKIM-sign; this also blocks spoofing a domain we
			// don't control (e.g. gmail.com).
			const domainCheck = await checkEmailDomainVerification(ctx, mailbox.address);
			if (!domainCheck.verified) {
				throwInvalidInput(
					`Can't send "${mailbox.address}" from this instance yet — the domain "${domainCheck.domain || mailbox.domain}" isn't a verified sending domain here. Verify it under Settings → Domains first.`
				);
			}
			// Gate 2 — a transport actually exists to send through.
			if (!(await isDeliveryConfigured(ctx))) {
				throwInvalidState(
					"This instance has no outbound transport configured yet, so it can't send on your behalf. Set one up under Delivery first."
				);
			}
		}

		if ((mailbox.outboundPreference ?? 'external') === args.preference) {
			return { ok: true as const, preference: args.preference };
		}

		const now = Date.now();
		await ctx.db.patch(mailbox._id, { outboundPreference: args.preference, updatedAt: now });
		await ctx.db.insert('mailAuditLog', {
			mailboxId: mailbox._id,
			event:
				args.preference === 'instance'
					? 'sending.switched_to_instance'
					: 'sending.switched_to_external',
			occurredAt: now,
		});
		if (args.preference === 'instance') {
			await markOnboardingStep(ctx, s.userId, 'sendingSwitched');
		}
		return { ok: true as const, preference: args.preference };
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
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account) throwNotFound('External mail account');
		if (account.status === 'disconnected') return { ok: true };
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

		// One external account per user (v1).
		const existingForUser = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (existingForUser && existingForUser.status !== 'disconnected') {
			throwAlreadyExists(
				'You already have a connected external mail account. Disconnect it before connecting another.'
			);
		}
		// The address must not collide with an existing active mailbox.
		const existingMailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (existingMailbox && existingMailbox.status === 'active') {
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
		// into the instance transport ships through the MTA/SES path instead of
		// their own SMTP. The switch was gated on a verified from-domain +
		// configured transport (setSendingPreference), so the hosted path's DKIM
		// alignment holds. undefined preference keeps the original external SMTP.
		if (mailbox.outboundPreference === 'instance') {
			return { kind: 'hosted' as const };
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
