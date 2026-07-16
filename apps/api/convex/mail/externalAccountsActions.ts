'use node';

/**
 * External mailbox accounts — Node-runtime surface (crypto + worker creds).
 *
 * Runs in Convex's Node.js runtime (`'use node'`) because credential
 * encryption uses `node:crypto` (via lib/credentialCrypto). All DB work is
 * delegated to internal queries/mutations in the sibling v8 file
 * `externalAccounts.ts`; the BetterAuth session propagates from these public
 * actions into those internal calls.
 *
 *   Public:   connect, connectShared, updateCredentials, updateCredentialsShared,
 *             testConnection
 *   Internal: getCredentialsForWorker (the ONLY function that returns plaintext
 *             credentials — internal/admin-key only, never exposed publicly)
 *
 * Live IMAP/SMTP validation is delegated to the apps/mail-sync worker's /test
 * endpoint, so the heavy protocol libraries stay out of the Convex bundle.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { encryptSecret, decryptSecret } from '../lib/credentialCrypto';
import { getMailSyncConfig } from './mtaClient';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';

interface ProtocolTestResult {
	ok: boolean;
	error?: string;
}
interface ConnectionTestResult {
	imap: ProtocolTestResult;
	smtp: ProtocolTestResult;
}

/** Plaintext credential bundle handed to the mail-sync worker. */
interface WorkerCredentials {
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
	imapUsername: string;
	smtpUsername: string;
	imapPassword: string;
	smtpPassword: string;
}

const credentialArgs = {
	emailAddress: v.string(),
	imapHost: v.string(),
	imapPort: v.number(),
	isImapSecure: v.boolean(),
	smtpHost: v.string(),
	smtpPort: v.number(),
	isSmtpSecure: v.boolean(),
	/** IMAP login; also used for SMTP unless smtpUsername is given. */
	username: v.string(),
	password: v.string(),
	smtpUsername: v.optional(v.string()),
	smtpPassword: v.optional(v.string()),
};

/** Actions can't read `ctx.db`; resolve flags via the internal mirror query. */
async function assertExternalEnabled(ctx: ActionCtx): Promise<void> {
	const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
	if (!flags['mail.external']) {
		throwForbidden(
			'Feature "mail.external" is disabled on this Owlat instance. An admin can enable it from Settings → Features.',
			{ feature: 'mail.external' }
		);
	}
}

function validateShape(args: { emailAddress: string; imapHost: string; smtpHost: string }): void {
	if (!args.emailAddress.includes('@')) throwInvalidInput('Enter a valid email address.');
	if (!args.imapHost.trim()) throwInvalidInput('IMAP host is required.');
	if (!args.smtpHost.trim()) throwInvalidInput('SMTP host is required.');
	// NB: do NOT reject `isImapSecure/isSmtpSecure === false` here. That flag is
	// nodemailer/imapflow's *implicit-TLS* switch; `false` on ports 587/143 is the
	// standard STARTTLS configuration (iCloud, Outlook.com, …), not cleartext.
	// TLS is enforced where the connection is actually made: the mail-sync worker
	// forces STARTTLS (or implicit TLS) for every non-loopback host and fails the
	// connection otherwise, so the password never crosses the wire in the clear.
	// See apps/mail-sync/src/tls.ts.
}

function encodeEnvelope(password: string, smtpPassword?: string) {
	const envelope = encryptSecret(
		JSON.stringify({ imapPassword: password, smtpPassword: smtpPassword ?? password })
	);
	return {
		secretCiphertext: envelope.ciphertext,
		secretIv: envelope.iv,
		secretAuthTag: envelope.authTag,
		secretEnvelopeVersion: envelope.version,
	};
}

/** Connect a new external account: validate → encrypt → persist (status pending). */
// authz: external mailbox connect — authedAction (authenticated member) +
// assertExternalEnabled gate; persistence in internal._connectInternal.
export const connect = authedAction({
	args: credentialArgs,
	handler: async (
		ctx,
		args
	): Promise<{ mailboxId: Id<'mailboxes'>; externalAccountId: Id<'externalMailAccounts'> }> => {
		await assertExternalEnabled(ctx);
		validateShape(args);
		return await ctx.runMutation(internal.mail.externalAccounts._connectInternal, {
			emailAddress: args.emailAddress,
			imapHost: args.imapHost,
			imapPort: args.imapPort,
			isImapSecure: args.isImapSecure,
			smtpHost: args.smtpHost,
			smtpPort: args.smtpPort,
			isSmtpSecure: args.isSmtpSecure,
			imapUsername: args.username,
			smtpUsername: args.smtpUsername,
			authMethod: 'password',
			...encodeEnvelope(args.password, args.smtpPassword),
		});
	},
});

/**
 * Connect an external account AS A SHARED TEAM INBOX: validate → encrypt →
 * persist a `kind='external', scope='shared'` mailbox with the connecting admin
 * as owner and `memberUserIds` seeded as members. The external-transport twin of
 * `mailboxMembers.createShared`, reusing the same encryption path as `connect`.
 */
// authz: shared external inbox connect — authedAction + assertExternalEnabled here;
// the ADMIN floor + org-member validation + persistence live in
// internal._connectSharedInternal (a team inbox is org infrastructure).
export const connectShared = authedAction({
	args: {
		...credentialArgs,
		displayName: v.optional(v.string()),
		memberUserIds: v.array(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ mailboxId: Id<'mailboxes'>; externalAccountId: Id<'externalMailAccounts'> }> => {
		await assertExternalEnabled(ctx);
		validateShape(args);
		return await ctx.runMutation(internal.mail.externalSharedInbox._connectSharedInternal, {
			emailAddress: args.emailAddress,
			imapHost: args.imapHost,
			imapPort: args.imapPort,
			isImapSecure: args.isImapSecure,
			smtpHost: args.smtpHost,
			smtpPort: args.smtpPort,
			isSmtpSecure: args.isSmtpSecure,
			imapUsername: args.username,
			smtpUsername: args.smtpUsername,
			authMethod: 'password',
			displayName: args.displayName,
			memberUserIds: args.memberUserIds,
			...encodeEnvelope(args.password, args.smtpPassword),
		});
	},
});

/**
 * Rotate / repair the credentials of an external account connected AS A SHARED
 * TEAM INBOX (issue #234): validate → encrypt → persist against the mailbox's
 * linked account, resetting it to `pending` so the worker re-validates. The
 * admin-gated twin of `updateCredentials` — the personal path resolves the
 * caller's live personal account and can never reach a team inbox, so a rotated
 * app password would otherwise brick the shared inbox forever.
 */
// authz: shared external inbox credential update — authedAction + assertExternalEnabled here;
// the ADMIN floor + shared-external scope gate + persistence live in
// internal._updateCredentialsSharedInternal.
export const updateCredentialsShared = authedAction({
	args: { ...credentialArgs, mailboxId: v.id('mailboxes') },
	handler: async (
		ctx,
		args
	): Promise<{ mailboxId: Id<'mailboxes'>; externalAccountId: Id<'externalMailAccounts'> }> => {
		await assertExternalEnabled(ctx);
		validateShape(args);
		return await ctx.runMutation(
			internal.mail.externalSharedInbox._updateCredentialsSharedInternal,
			{
				mailboxId: args.mailboxId,
				emailAddress: args.emailAddress,
				imapHost: args.imapHost,
				imapPort: args.imapPort,
				isImapSecure: args.isImapSecure,
				smtpHost: args.smtpHost,
				smtpPort: args.smtpPort,
				isSmtpSecure: args.isSmtpSecure,
				imapUsername: args.username,
				smtpUsername: args.smtpUsername,
				authMethod: 'password',
				...encodeEnvelope(args.password, args.smtpPassword),
			}
		);
	},
});

/** Re-enter / change credentials for the existing account. */
// authz: external mailbox credential update — authedAction + assertExternalEnabled;
// persistence in internal._updateCredentialsInternal.
export const updateCredentials = authedAction({
	args: credentialArgs,
	handler: async (
		ctx,
		args
	): Promise<{ mailboxId: Id<'mailboxes'>; externalAccountId: Id<'externalMailAccounts'> }> => {
		await assertExternalEnabled(ctx);
		validateShape(args);
		return await ctx.runMutation(internal.mail.externalAccounts._updateCredentialsInternal, {
			emailAddress: args.emailAddress,
			imapHost: args.imapHost,
			imapPort: args.imapPort,
			isImapSecure: args.isImapSecure,
			smtpHost: args.smtpHost,
			smtpPort: args.smtpPort,
			isSmtpSecure: args.isSmtpSecure,
			imapUsername: args.username,
			smtpUsername: args.smtpUsername,
			authMethod: 'password',
			...encodeEnvelope(args.password, args.smtpPassword),
		});
	},
});

/**
 * Live IMAP+SMTP credential check, delegated to the mail-sync worker's /test
 * endpoint (which owns the protocol libraries). Persists nothing. Returns a
 * soft failure when the worker is not configured/reachable.
 */
// all-members: live IMAP/SMTP credential check, persists nothing.
export const testConnection = authedAction({
	args: credentialArgs,
	handler: async (ctx, args): Promise<ConnectionTestResult> => {
		await assertExternalEnabled(ctx);
		validateShape(args);
		const mailSync = getMailSyncConfig();
		if (!mailSync) {
			const error = 'The mail sync service is not configured on this instance.';
			return { imap: { ok: false, error }, smtp: { ok: false, error } };
		}
		try {
			const res = await fetch(`${mailSync.baseUrl}/test`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mailSync.apiKey}` },
				body: JSON.stringify({
					imap: {
						host: args.imapHost,
						port: args.imapPort,
						secure: args.isImapSecure,
						username: args.username,
						password: args.password,
					},
					smtp: {
						host: args.smtpHost,
						port: args.smtpPort,
						secure: args.isSmtpSecure,
						username: args.smtpUsername ?? args.username,
						password: args.smtpPassword ?? args.password,
					},
				}),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				const error = text || `Mail sync service returned HTTP ${res.status}`;
				return { imap: { ok: false, error }, smtp: { ok: false, error } };
			}
			return (await res.json()) as ConnectionTestResult;
		} catch (e) {
			const error = e instanceof Error ? e.message : 'Connection test failed.';
			return { imap: { ok: false, error }, smtp: { ok: false, error } };
		}
	},
});

// ── Internal: the ONLY plaintext-credential path (worker, admin-key only) ──

/**
 * Decrypt and return an account's IMAP+SMTP credentials for the mail-sync
 * worker. Internal action (decryption needs Node). Never exposed publicly and
 * never logs the plaintext. Returns null if the row is missing or undecryptable.
 */
export const getCredentialsForWorker = internalAction({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args): Promise<WorkerCredentials | null> => {
		const row = await ctx.runQuery(internal.mail.externalAccounts._getRowInternal, {
			accountId: args.accountId,
		});
		if (!row) return null;
		let creds: { imapPassword: string; smtpPassword?: string };
		try {
			creds = JSON.parse(
				decryptSecret({
					ciphertext: row.secretCiphertext,
					iv: row.secretIv,
					authTag: row.secretAuthTag,
					version: row.secretEnvelopeVersion,
				})
			);
		} catch {
			return null;
		}
		return {
			imapHost: row.imapHost,
			imapPort: row.imapPort,
			isImapSecure: row.isImapSecure,
			smtpHost: row.smtpHost,
			smtpPort: row.smtpPort,
			isSmtpSecure: row.isSmtpSecure,
			imapUsername: row.imapUsername,
			smtpUsername: row.smtpUsername ?? row.imapUsername,
			imapPassword: creds.imapPassword,
			smtpPassword: creds.smtpPassword ?? creds.imapPassword,
		};
	},
});
