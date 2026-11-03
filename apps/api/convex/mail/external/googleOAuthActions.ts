'use node';

/**
 * Google sign-in for external mailboxes — the two public actions.
 *
 * `start` mints the PKCE pair + `state` nonce, records what the finished
 * authorization should DO, and hands back the URL to send the browser to.
 * `complete` is called by the callback PAGE (apps/web `/oauth/google/callback`)
 * with the `code` + `state` Google redirected back with: it consumes the state
 * row, trades the code for a refresh token, and drives exactly the same
 * session-bound internal mutation the app-password path uses
 * (`oauthConnect.ts`, shared with Microsoft sign-in).
 *
 * Because the callback is a page and not an HTTP route, the user's session is
 * present for the whole handshake. No token, code, or client secret is ever
 * logged or returned to the browser.
 *
 * App passwords remain the default path, including for Gmail: Google sign-in
 * is an optional extra an admin enables by configuring an OAuth client.
 */

import { v } from 'convex/values';
import { authedAction } from '../../lib/authedFunctions';
import { internal } from '../../_generated/api';
import { throwInvalidInput } from '../../_utils/errors';
import { oauthIntentValidator } from '../../schema/mailAccounts';
import { assertExternalEnabled } from './externalFeature';
import { OAUTH_STATE_TTL_MS, assertSafeReturnTo } from './oauthState';
import { landOAuthGrant, precheckOAuthIntent, toOAuthConnectFields } from './oauthConnect';
import {
	buildAuthorizationUrl,
	exchangeAuthorizationCode,
	googleRedirectUri,
	pkceChallenge,
	randomUrlSafeToken,
	requireGoogleOAuthClient,
} from './googleOAuthTokens';
import type { Id } from '../../_generated/dataModel';

/** Gmail's fixed IMAP/SMTP endpoints (see `OAuthServerPreset`). */
const GMAIL_PRESET = {
	imapHost: 'imap.gmail.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.gmail.com',
	smtpPort: 465,
	isSmtpSecure: true,
} as const;

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
// + assertExternalEnabled + the per-intent floor in `precheckOAuthIntent` (admin for
// connectShared/connectSeed, owner/admin via the shared query for updateShared);
// the enforcing copy of each floor lives in the internal mutations `complete`
// dispatches to.
export const start = authedAction({
	args: { intent: oauthIntentValidator, returnTo: v.string() },
	handler: async (ctx, args): Promise<{ authorizationUrl: string }> => {
		await assertExternalEnabled(ctx);
		assertSafeReturnTo(args.returnTo);
		const client = requireGoogleOAuthClient();
		const expectedAddress = await precheckOAuthIntent(ctx, args.intent);

		const state = randomUrlSafeToken();
		const codeVerifier = randomUrlSafeToken();
		await ctx.runMutation(internal.mail.external.googleOAuth._createStateInternal, {
			state,
			codeVerifier,
			intent: args.intent,
			returnTo: args.returnTo,
			expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
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
		// checkpoint: the single-use state is consumed before the code exchange,
		// and stays consumed when the exchange fails: a retry starts a fresh
		// handshake instead of replaying a spent code.
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
		const fields = toOAuthConnectFields({
			provider: 'google',
			preset: GMAIL_PRESET,
			email,
			secret: { oauthRefreshToken: refreshToken },
		});
		const mailboxId = await landOAuthGrant(ctx, stateRow.intent, fields);
		return { mailboxId, returnTo: stateRow.returnTo };
	},
});
