'use node';

/**
 * Google sign-in for external mailboxes — the two public actions.
 *
 * `start` mints the PKCE pair + `state` nonce, records what the finished
 * authorization should DO, and hands back the URL to send the browser to.
 * `complete` is called by the callback PAGE (apps/web `/oauth/google/callback`)
 * with the `code` + `state` Google redirected back with: it consumes the state
 * row, trades the code for a refresh token, and drives exactly the same
 * session-bound internal mutation the app-password path uses — so a Google
 * account lands as an ordinary `externalMailAccounts` row that differs only in
 * `authMethod: 'oauth2'` and what sits inside its encrypted envelope.
 *
 * Because the callback is a page and not an HTTP route, the user's session is
 * present for the whole handshake. No token, code, or client secret is ever
 * logged or returned to the browser.
 *
 * App passwords remain fully supported, including for Gmail: this is the
 * recommended path, not the only one.
 */

import { v } from 'convex/values';
import { authedAction } from '../../lib/authedFunctions';
import { internal, api } from '../../_generated/api';
import { encryptSecret } from '../../lib/credentialCrypto';
import { throwInvalidInput } from '../../_utils/errors';
import { assertExternalEnabled } from './externalFeature';
import {
	GOOGLE_OAUTH_STATE_TTL_MS,
	assertSafeReturnTo,
	googleOAuthIntentValidator,
	type GoogleOAuthIntent,
} from './googleOAuth';
import {
	buildAuthorizationUrl,
	exchangeAuthorizationCode,
	googleRedirectUri,
	pkceChallenge,
	randomUrlSafeToken,
	requireGoogleOAuthClient,
} from './googleOAuthTokens';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

/**
 * Gmail's fixed IMAP/SMTP endpoints. Hard-coded rather than taken from the
 * client: an OAuth grant is only valid against Google's own servers, so there is
 * nothing for a user to configure and nothing an attacker may redirect.
 */
const GMAIL_PRESET = {
	imapHost: 'imap.gmail.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.gmail.com',
	smtpPort: 465,
	isSmtpSecure: true,
} as const;

/**
 * The connect fields for an OAuth account.
 *
 * The refresh token goes INSIDE the existing encrypted envelope — the same
 * `encryptSecret` every app password uses — so the whole feature adds no new
 * encrypt site, no new decrypt site, and no new secret-bearing column.
 */
function toOAuthConnectFields(email: string, refreshToken: string) {
	const envelope = encryptSecret(JSON.stringify({ oauthRefreshToken: refreshToken }));
	return {
		emailAddress: email,
		...GMAIL_PRESET,
		imapUsername: email,
		smtpUsername: email,
		authMethod: 'oauth2' as const,
		oauthProvider: 'google' as const,
		secretCiphertext: envelope.ciphertext,
		secretIv: envelope.iv,
		secretAuthTag: envelope.authTag,
		secretEnvelopeVersion: envelope.version,
	};
}

/**
 * Check the caller may actually carry out this intent, and resolve the address a
 * re-authorization must land on — used as Google's `login_hint` so the account
 * picker pre-selects it. `null` for the connect intents, which have no existing
 * mailbox to match.
 *
 * Both halves run BEFORE the browser leaves for Google, so a member without the
 * rights for a team inbox or a seed is refused here rather than after consenting.
 */
async function precheckIntent(ctx: ActionCtx, intent: GoogleOAuthIntent): Promise<string | null> {
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
		// editor is told no before being sent through Google's consent screen —
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

/**
 * Begin a Google authorization. Returns the URL the browser must be sent to.
 *
 * The `intent` is pinned HERE, at the moment the user asked for it, and stored
 * server-side: the callback carries only `code` + `state`, so a tampered
 * callback URL cannot turn a "reconnect my own mailbox" consent into "connect a
 * team inbox". The per-intent authorization (admin floor for a team inbox or a
 * seed, owner/admin for a shared re-authorization) is owned by the very same
 * internal mutations the app-password path calls, at `complete` time, and is
 * ALSO asserted here so a member who cannot perform the intent never reaches
 * Google's consent screen.
 */
// authz: external mailbox connect/reauthorize — authedAction (authenticated member)
// + assertExternalEnabled + the per-intent floor in `precheckIntent` (admin for
// connectShared/connectSeed, owner/admin via the shared query for updateShared);
// the enforcing copy of each floor lives in the internal mutations `complete`
// dispatches to.
export const start = authedAction({
	args: { intent: googleOAuthIntentValidator, returnTo: v.string() },
	handler: async (ctx, args): Promise<{ authorizationUrl: string }> => {
		await assertExternalEnabled(ctx);
		assertSafeReturnTo(args.returnTo);
		const client = requireGoogleOAuthClient();
		const expectedAddress = await precheckIntent(ctx, args.intent);

		const state = randomUrlSafeToken();
		const codeVerifier = randomUrlSafeToken();
		await ctx.runMutation(internal.mail.external.googleOAuth._createStateInternal, {
			state,
			codeVerifier,
			intent: args.intent,
			returnTo: args.returnTo,
			expiresAt: Date.now() + GOOGLE_OAUTH_STATE_TTL_MS,
		});

		return {
			authorizationUrl: buildAuthorizationUrl({
				clientId: client.clientId,
				redirectUri: googleRedirectUri(),
				state,
				codeChallenge: pkceChallenge(codeVerifier),
				...(expectedAddress ? { loginHint: expectedAddress } : {}),
			}),
		};
	},
});

/** Re-authorizing must land on the SAME mailbox, never a different account. */
function assertSameAddress(expected: string, actual: string): void {
	if (expected.toLowerCase() !== actual.toLowerCase()) {
		throwInvalidInput(
			`You signed in as ${actual}, but this mailbox is ${expected}. Sign in with ${expected} to reconnect it.`
		);
	}
}

/**
 * Finish the authorization the callback page received.
 *
 * Every failure deletes the state row (the consume is unconditional), so a
 * retry always starts a fresh handshake rather than replaying a spent code.
 */
// authz: external mailbox connect/reauthorize — authedAction + assertExternalEnabled;
// the state row is bound to the caller's own session, and each intent dispatches
// to the internal mutation that owns its role floor.
export const complete = authedAction({
	args: { code: v.string(), state: v.string() },
	handler: async (ctx, args): Promise<{ mailboxId: Id<'mailboxes'>; returnTo: string }> => {
		await assertExternalEnabled(ctx);
		const stateRow = await ctx.runMutation(
			internal.mail.external.googleOAuth._consumeStateInternal,
			{ state: args.state }
		);
		if (!stateRow) throwInvalidInput('This Google sign-in link has expired. Start again.');

		const client = requireGoogleOAuthClient();
		const { refreshToken, email } = await exchangeAuthorizationCode({
			client,
			code: args.code,
			codeVerifier: stateRow.codeVerifier,
			redirectUri: googleRedirectUri(),
		});
		const fields = toOAuthConnectFields(email, refreshToken);
		const intent = stateRow.intent;

		let mailboxId: Id<'mailboxes'>;
		switch (intent.kind) {
			case 'connect': {
				({ mailboxId } = await ctx.runMutation(
					internal.mail.external.accounts._connectInternal,
					fields
				));
				break;
			}
			case 'update': {
				const account = await ctx.runQuery(api.mail.external.accounts.getForCurrentUser, {});
				if (!account.configured) throwInvalidInput('You do not have a connected mailbox.');
				assertSameAddress(account.emailAddress, email);
				({ mailboxId } = await ctx.runMutation(
					internal.mail.external.accounts._updateCredentialsInternal,
					fields
				));
				break;
			}
			case 'connectShared': {
				({ mailboxId } = await ctx.runMutation(
					internal.mail.external.sharedInbox._connectSharedInternal,
					{
						...fields,
						displayName: intent.displayName,
						memberUserIds: intent.memberUserIds,
					}
				));
				break;
			}
			case 'updateShared': {
				const shared = await ctx.runQuery(api.mail.external.sharedInbox.getSharedExternalAccount, {
					mailboxId: intent.mailboxId,
				});
				if (!shared.configured) throwInvalidInput('This is not an external team inbox.');
				assertSameAddress(shared.emailAddress, email);
				({ mailboxId } = await ctx.runMutation(
					internal.mail.external.sharedInbox._updateCredentialsSharedInternal,
					{ ...fields, mailboxId: intent.mailboxId }
				));
				break;
			}
			case 'connectSeed': {
				({ mailboxId } = await ctx.runMutation(
					internal.mail.external.accountsSeed._connectSeedInternal,
					{ ...fields, seedProvider: intent.seedProvider }
				));
				break;
			}
		}

		return { mailboxId, returnTo: stateRow.returnTo };
	},
});
