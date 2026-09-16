'use node';

/**
 * External mailbox accounts — Node-runtime surface (crypto + worker creds).
 *
 * Runs in Convex's Node.js runtime (`'use node'`) because credential
 * encryption uses `node:crypto` (via lib/credentialCrypto). All DB work is
 * delegated to internal queries/mutations in the sibling v8 file
 * `accounts.ts`; the BetterAuth session propagates from these public
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

import { v, type Infer } from 'convex/values';
import { internalAction } from '../../_generated/server';
import { authedAction } from '../../lib/authedFunctions';
import { destinationProviderValidator } from '../../delivery/deliverabilityValidators';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { encryptSecret, decryptSecret } from '../../lib/credentialCrypto';
import { getMailSyncConfig } from '../mtaClient';
import { throwInvalidInput } from '../../_utils/errors';
import { assertExternalEnabled } from './externalFeature';
import { refreshGoogleAccessToken } from './googleOAuthTokens';

interface ProtocolTestResult {
	ok: boolean;
	error?: string;
}
interface ConnectionTestResult {
	imap: ProtocolTestResult;
	smtp: ProtocolTestResult;
}

/** Plaintext credential bundle handed to the mail-sync worker. */
export interface WorkerCredentials {
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
	/**
	 * SASL XOAUTH2 bearer tokens, present INSTEAD of the passwords on an `oauth2`
	 * account (Google sign-in). Short-lived and minted per request from the stored
	 * refresh token — they are never persisted, so the worker always receives a
	 * live one and the two password fields are empty strings on that path.
	 */
	imapAccessToken?: string;
	smtpAccessToken?: string;
}

/**
 * What a worker credential fetch produced.
 *
 * `auth_revoked` is its own outcome rather than one more flavour of "no
 * credentials": the account has ALREADY been marked `auth_error` here, with the
 * message that tells the user to reconnect, and no amount of retrying will
 * change the answer. The worker keys off that to stop its connect loop and leave
 * the message alone, instead of overwriting it with a generic error and
 * re-asking Google for a token it will never get every few seconds.
 *
 * `missing` covers a deleted row and an undecryptable envelope; `refresh_failed`
 * a transient refusal from Google's token endpoint. Both are worth retrying.
 */
export type WorkerCredentialsResult =
	| { kind: 'credentials'; credentials: WorkerCredentials }
	| { kind: 'unavailable'; reason: 'missing' | 'auth_revoked' | 'refresh_failed' };

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

function validateShape(args: { emailAddress: string; imapHost: string; smtpHost: string }): void {
	if (!args.emailAddress.includes('@')) throwInvalidInput('Enter a valid email address.');
	if (!args.imapHost.trim()) throwInvalidInput('IMAP host is required.');
	if (!args.smtpHost.trim()) throwInvalidInput('SMTP host is required.');
	// NB: do NOT reject `isImapSecure/isSmtpSecure === false` here. That flag is
	// imapflow's (IMAP) / the mail-sync SMTP client's (@owlat/smtp-client)
	// *implicit-TLS* switch; `false` on ports 587/143 is the
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

type CredentialArgs = Infer<ReturnType<typeof v.object<typeof credentialArgs>>>;

/**
 * Map the public credential args → the internal connect-fields shape every
 * persistence mutation takes (non-secret IMAP/SMTP settings + the encrypted
 * password envelope). The single source of truth reused by `connect`,
 * `connectShared`, `updateCredentials`, and `updateCredentialsShared` so the
 * 12-field mapping (incl. `username → imapUsername` and the `authMethod`) never
 * drifts across the four call sites — a new field (e.g. an `oauth` authMethod)
 * is a one-line change here instead of a four-site shotgun edit.
 */
function toConnectFields(args: CredentialArgs) {
	return {
		emailAddress: args.emailAddress,
		imapHost: args.imapHost,
		imapPort: args.imapPort,
		isImapSecure: args.isImapSecure,
		smtpHost: args.smtpHost,
		smtpPort: args.smtpPort,
		isSmtpSecure: args.isSmtpSecure,
		imapUsername: args.username,
		smtpUsername: args.smtpUsername,
		// An app-password write is always a 'password' row, including when it
		// REPAIRS an account that was previously connected with Google sign-in:
		// `applyCredentialRotation` writes both fields, so the row's auth method
		// and the contents of its envelope move together.
		authMethod: 'password' as const,
		oauthProvider: undefined,
		...encodeEnvelope(args.password, args.smtpPassword),
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
		return await ctx.runMutation(
			internal.mail.external.accounts._connectInternal,
			toConnectFields(args)
		);
	},
});

/**
 * Connect a DELIVERABILITY SEED mailbox: validate -> encrypt -> persist, with
 * `purpose: 'seed'` and the mailbox provider recorded.
 *
 * Same validation and the same sealed-credential envelope as `connect` — a
 * seed is an ordinary external account that happens to exist so Owlat can mail
 * itself and see where the copy lands. Entirely optional: an install with zero
 * seeds sends normally and every delivery screen renders cleanly (D2).
 */
// authz: seed mailbox connect — the enforced floor is ADMIN. authedAction +
// assertExternalEnabled here; the admin floor (requireAdminContext) and
// persistence live in internal._connectSeedInternal, mirroring the shared
// team-inbox twin below — a seed is org infrastructure, and connecting one
// makes every campaign the org sends deliver a full copy into it.
export const connectSeed = authedAction({
	args: { ...credentialArgs, seedProvider: destinationProviderValidator },
	handler: async (
		ctx,
		args
	): Promise<{ mailboxId: Id<'mailboxes'>; externalAccountId: Id<'externalMailAccounts'> }> => {
		await assertExternalEnabled(ctx);
		validateShape(args);
		return await ctx.runMutation(internal.mail.external.accountsSeed._connectSeedInternal, {
			...toConnectFields(args),
			seedProvider: args.seedProvider,
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
		return await ctx.runMutation(internal.mail.external.sharedInbox._connectSharedInternal, {
			...toConnectFields(args),
			displayName: args.displayName,
			memberUserIds: args.memberUserIds,
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
			internal.mail.external.sharedInbox._updateCredentialsSharedInternal,
			{ ...toConnectFields(args), mailboxId: args.mailboxId }
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
		return await ctx.runMutation(
			internal.mail.external.accounts._updateCredentialsInternal,
			toConnectFields(args)
		);
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
 * never logs the plaintext.
 *
 * Always answers with a {@link WorkerCredentialsResult} discriminant rather than
 * `credentials | null`, so the worker can tell a revoked Google grant (stop, the
 * user must act) from a transient miss (back off and retry).
 */
export const getCredentialsForWorker = internalAction({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args): Promise<WorkerCredentialsResult> => {
		const row = await ctx.runQuery(internal.mail.external.accounts._getRowInternal, {
			accountId: args.accountId,
		});
		if (!row) return { kind: 'unavailable', reason: 'missing' };

		// An OAuth account carries a refresh token where a password row carries
		// passwords. Mint a short-lived access token from it and hand the worker
		// that instead. A grant the user revoked comes back as `revoked` — the
		// account is already `auth_error` by then — and is reported as such, so the
		// worker stops rather than retrying something only the user can fix.
		if (row.authMethod === 'oauth2') {
			let refreshToken: string | undefined;
			try {
				refreshToken = (
					JSON.parse(
						decryptSecret({
							ciphertext: row.secretCiphertext,
							iv: row.secretIv,
							authTag: row.secretAuthTag,
							version: row.secretEnvelopeVersion,
						})
					) as { oauthRefreshToken?: string }
				).oauthRefreshToken;
			} catch {
				return { kind: 'unavailable', reason: 'missing' };
			}
			if (!refreshToken) return { kind: 'unavailable', reason: 'missing' };
			const token = await refreshGoogleAccessToken(ctx, row._id, refreshToken, row.secretIv);
			if (token.kind !== 'token') {
				return {
					kind: 'unavailable',
					reason: token.kind === 'revoked' ? 'auth_revoked' : 'refresh_failed',
				};
			}
			return {
				kind: 'credentials',
				credentials: {
					imapHost: row.imapHost,
					imapPort: row.imapPort,
					isImapSecure: row.isImapSecure,
					smtpHost: row.smtpHost,
					smtpPort: row.smtpPort,
					isSmtpSecure: row.isSmtpSecure,
					imapUsername: row.imapUsername,
					smtpUsername: row.smtpUsername ?? row.imapUsername,
					imapPassword: '',
					smtpPassword: '',
					imapAccessToken: token.accessToken,
					smtpAccessToken: token.accessToken,
				},
			};
		}

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
			return { kind: 'unavailable', reason: 'missing' };
		}
		return {
			kind: 'credentials',
			credentials: {
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
			},
		};
	},
});
