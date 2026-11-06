/**
 * The mail-sync worker's account calls (`mail/external/accounts`,
 * `mail/external/accountsActions`): which accounts to hold connections for,
 * their credentials, and the connection status it writes back.
 */

import { v } from 'convex/values';
import { defineEndpoint } from '../contract';
import { externalAccountStatusValidator, externalSendPathValidator } from '../fields';

const workerCredentialsFields = {
	imapHost: v.string(),
	imapPort: v.number(),
	isImapSecure: v.boolean(),
	smtpHost: v.string(),
	smtpPort: v.number(),
	isSmtpSecure: v.boolean(),
	imapUsername: v.string(),
	smtpUsername: v.string(),
	imapPassword: v.string(),
	smtpPassword: v.string(),
	imapAccessToken: v.optional(v.string()),
	smtpAccessToken: v.optional(v.string()),
	graphAccessToken: v.optional(v.string()),
	sendPath: v.optional(externalSendPathValidator),
};

/**
 * The plaintext credential bundle. On an `oauth2` account the two access tokens
 * stand in for the passwords, which are then empty strings.
 *
 * `sendPath` is set on Microsoft sign-in accounts only, and says how the
 * account submitted its last successful send. `graphAccessToken` is a Microsoft
 * Graph token for `Mail.Send`, present when the grant covers that scope: a
 * token request names one resource, so it cannot be the token the IMAP and SMTP
 * logins use.
 */
export const workerCredentialsValidator = v.object(workerCredentialsFields);

/**
 * The pre-OAuth answer to a successful fetch: the bare bundle, told apart from
 * the current shape by having NO `kind`. Declaring `kind` here, as an optional
 * `null` (the closest a Convex validator comes to "never"), is what makes a value
 * with a malformed discriminant fail, instead of passing as a legacy bundle
 * under a consumer's permissive object check.
 */
const legacyWorkerCredentialsValidator = v.object({
	...workerCredentialsFields,
	kind: v.optional(v.null()),
});

/**
 * Why a credential fetch produced none. `auth_revoked` and `disconnected` are
 * terminal (only the user reconnecting changes the answer); `missing` and
 * `refresh_failed` are worth retrying.
 */
export const credentialsUnavailableReasonValidator = v.union(
	v.literal('missing'),
	v.literal('disconnected'),
	v.literal('auth_revoked'),
	v.literal('refresh_failed')
);

const workerCredentialsResultValidator = v.union(
	v.object({ kind: v.literal('credentials'), credentials: workerCredentialsValidator }),
	v.object({ kind: v.literal('unavailable'), reason: credentialsUnavailableReasonValidator })
);

/**
 * The ONLY call that returns plaintext credentials. The backend answers with
 * the discriminated result; the worker also accepts the pre-OAuth shape, `null`
 * on a miss and a bare bundle on success, which an older backend still answers
 * with during a rolling deploy (`fetchWorkerCredentials` maps both).
 */
export const getCredentialsForWorker = defineEndpoint({
	path: 'mail/external/accountsActions:getCredentialsForWorker',
	kind: 'action',
	args: { accountId: v.id('externalMailAccounts') },
	returns: workerCredentialsResultValidator,
	accepts: v.union(
		...workerCredentialsResultValidator.members,
		legacyWorkerCredentialsValidator,
		v.null()
	),
});

/** The accounts to hold connections for (seed mailboxes excluded). */
export const listConnectableAccounts = defineEndpoint({
	path: 'mail/external/accounts:listConnectableAccounts',
	kind: 'query',
	args: {},
	returns: v.array(
		v.object({
			accountId: v.id('externalMailAccounts'),
			mailboxId: v.id('mailboxes'),
			imapHost: v.string(),
			imapPort: v.number(),
			isImapSecure: v.boolean(),
			imapUsername: v.string(),
			status: v.union(v.literal('pending'), v.literal('connected'), v.literal('error')),
		})
	),
});

/**
 * Record how a Microsoft sign-in account sends: 'graph' once SMTP AUTH was
 * refused and Graph took the message, 'smtp' when SMTP works again. The worker
 * calls it only when the path changed, and treats a backend without it as a
 * no-op.
 */
export const setSendPath = defineEndpoint({
	path: 'mail/external/accounts:setSendPath',
	kind: 'mutation',
	args: {
		accountId: v.id('externalMailAccounts'),
		sendPath: externalSendPathValidator,
	},
	returns: v.null(),
});

/** Connection / sync status write-back. */
export const setSyncStatus = defineEndpoint({
	path: 'mail/external/accounts:setSyncStatus',
	kind: 'mutation',
	args: {
		accountId: v.id('externalMailAccounts'),
		status: externalAccountStatusValidator,
		lastError: v.optional(v.string()),
		markSynced: v.optional(v.boolean()),
	},
	returns: v.null(),
});
