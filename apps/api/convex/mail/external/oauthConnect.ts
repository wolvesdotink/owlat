'use node';

/**
 * What a finished mailbox sign-in DOES, shared by Google and Microsoft.
 *
 * Both providers' `start` actions check the intent here before the browser
 * leaves for the consent screen, and both `complete` actions land the grant
 * through {@link landOAuthGrant}: the very same session-bound internal mutations
 * the app-password path uses. So an OAuth account is an ordinary
 * `externalMailAccounts` row that differs only in `authMethod: 'oauth2'`, its
 * `oauthProvider`, and what sits inside its encrypted envelope.
 */

import { internal, api } from '../../_generated/api';
import { encryptSecret } from '../../lib/credentialCrypto';
import { throwInvalidInput } from '../../_utils/errors';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import type { OAuthIntent, OAuthProvider } from './oauthState';

/**
 * A provider's fixed IMAP/SMTP endpoints. Never taken from the client: an OAuth
 * grant is only valid against the provider's own servers, so there is nothing
 * for a user to configure and nothing an attacker may redirect.
 */
export interface OAuthServerPreset {
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
}

/**
 * What goes inside the sealed envelope of an oauth2 row. `oauthRefreshTokenStoredAt`
 * is set only by providers that rotate refresh tokens (Microsoft), so the
 * refresh path can tell how old the stored one is.
 */
export interface OAuthEnvelopeSecret {
	oauthRefreshToken: string;
	oauthRefreshTokenStoredAt?: number;
}

/**
 * The connect fields for an OAuth account.
 *
 * The refresh token goes INSIDE the existing encrypted envelope — the same
 * `encryptSecret` every app password uses — so the feature adds no new
 * secret-bearing column on the account row.
 */
export function toOAuthConnectFields(params: {
	provider: OAuthProvider;
	preset: OAuthServerPreset;
	email: string;
	secret: OAuthEnvelopeSecret;
}) {
	const envelope = encryptSecret(JSON.stringify(params.secret));
	return {
		emailAddress: params.email,
		...params.preset,
		imapUsername: params.email,
		smtpUsername: params.email,
		authMethod: 'oauth2' as const,
		oauthProvider: params.provider,
		secretCiphertext: envelope.ciphertext,
		secretIv: envelope.iv,
		secretAuthTag: envelope.authTag,
		secretEnvelopeVersion: envelope.version,
	};
}

export type OAuthConnectFields = ReturnType<typeof toOAuthConnectFields>;

/**
 * Check the caller may actually carry out this intent, and resolve the address a
 * re-authorization must land on — used as the provider's `login_hint` so the
 * account picker pre-selects it. `null` for the connect intents, which have no
 * existing mailbox to match.
 *
 * Both halves run BEFORE the browser leaves for the provider, so a member
 * without the rights for a team inbox or a seed is refused here rather than
 * after consenting.
 */
export async function precheckOAuthIntent(
	ctx: ActionCtx,
	intent: OAuthIntent
): Promise<string | null> {
	if (intent.kind === 'update') {
		const account = await ctx.runQuery(api.mail.external.accounts.getForCurrentUser, {});
		if (!account.configured) {
			throwInvalidInput('You do not have a connected mailbox to reconnect.');
		}
		return account.emailAddress;
	}
	if (intent.kind === 'connectShared' || intent.kind === 'connectSeed') {
		// The admin floor these two land on is enforced by `_connectSharedInternal`
		// / `_connectSeedInternal` at `complete`. Assert it HERE as well so an
		// editor is told no before being sent through the consent screen —
		// granting Owlat access to their mailbox and only then being refused. Same
		// query the wrappers use, so there is one definition of "admin".
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});
		return null;
	}
	if (intent.kind === 'updateShared') {
		// Owner/admin gated inside the query; a caller without access reads as
		// "not configured" and never learns the inbox exists.
		const shared = await ctx.runQuery(api.mail.external.sharedInbox.getSharedExternalAccount, {
			mailboxId: intent.mailboxId,
		});
		if (!shared.configured) throwInvalidInput('This is not an external team inbox.');
		return shared.emailAddress;
	}
	return null;
}

/** Re-authorizing must land on the SAME mailbox, never a different account. */
function assertSameAddress(expected: string, actual: string): void {
	if (expected.toLowerCase() !== actual.toLowerCase()) {
		throwInvalidInput(
			`You signed in as ${actual}, but this mailbox is ${expected}. Sign in with ${expected} to reconnect it.`
		);
	}
}

/**
 * Carry out the intent recorded at `start` with the fields of a completed
 * grant. Each intent dispatches to the internal mutation that owns its role
 * floor, so the per-intent authorization lives in exactly one place for both
 * auth methods.
 */
export async function landOAuthGrant(
	ctx: ActionCtx,
	intent: OAuthIntent,
	fields: OAuthConnectFields
): Promise<Id<'mailboxes'>> {
	switch (intent.kind) {
		case 'connect': {
			const { mailboxId } = await ctx.runMutation(
				internal.mail.external.accounts._connectInternal,
				fields
			);
			return mailboxId;
		}
		case 'update': {
			const account = await ctx.runQuery(api.mail.external.accounts.getForCurrentUser, {});
			if (!account.configured) throwInvalidInput('You do not have a connected mailbox.');
			assertSameAddress(account.emailAddress, fields.emailAddress);
			const { mailboxId } = await ctx.runMutation(
				internal.mail.external.accounts._updateCredentialsInternal,
				fields
			);
			return mailboxId;
		}
		case 'connectShared': {
			const { mailboxId } = await ctx.runMutation(
				internal.mail.external.sharedInbox._connectSharedInternal,
				{ ...fields, displayName: intent.displayName, memberUserIds: intent.memberUserIds }
			);
			return mailboxId;
		}
		case 'updateShared': {
			const shared = await ctx.runQuery(api.mail.external.sharedInbox.getSharedExternalAccount, {
				mailboxId: intent.mailboxId,
			});
			if (!shared.configured) throwInvalidInput('This is not an external team inbox.');
			assertSameAddress(shared.emailAddress, fields.emailAddress);
			const { mailboxId } = await ctx.runMutation(
				internal.mail.external.sharedInbox._updateCredentialsSharedInternal,
				{ ...fields, mailboxId: intent.mailboxId }
			);
			return mailboxId;
		}
		case 'connectSeed': {
			const { mailboxId } = await ctx.runMutation(
				internal.mail.external.accountsSeed._connectSeedInternal,
				{ ...fields, seedProvider: intent.seedProvider }
			);
			return mailboxId;
		}
	}
}
