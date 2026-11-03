'use node';

/**
 * Google's OAuth 2.0 wire protocol — the half that needs Node.
 *
 * The authorization-URL shape, the authorization-code exchange, the `id_token`
 * read, and the worker-facing access-token refresh. PKCE, the token POST and
 * the access-token cache are shared with Microsoft sign-in
 * (`oauthTokenShared.ts`). Kept out of `googleOAuthActions.ts` so neither file
 * approaches the ~500 LOC cap, and out of `accountsActions.ts` so the refresh
 * path `getCredentialsForWorker` needs can be imported without pulling the
 * connect actions in behind it.
 *
 * NOTHING here is logged. Access tokens, refresh tokens, the authorization code
 * and the client secret never reach `console.*`; only taxonomy (`invalid_grant`,
 * an HTTP status) does.
 */

import { getOptional } from '../../lib/env';
import { throwInvalidInput } from '../../_utils/errors';
import {
	clearAccessTokenCache,
	markGrantRevoked,
	oauthRedirectUri,
	postTokenRequest,
	readCachedAccessToken,
	readJwtPayload,
	rememberAccessToken,
	type OAuthAccessTokenResult,
} from './oauthTokenShared';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

export { pkceChallenge, randomUrlSafeToken } from './oauthTokenShared';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * `https://mail.google.com/` is Google's full IMAP/SMTP scope — the only one
 * that authorizes SASL XOAUTH2 against `imap.gmail.com` / `smtp.gmail.com`.
 * `openid email` is what lets the exchange learn WHICH account the user picked
 * without a second API call.
 */
const SCOPES = 'https://mail.google.com/ openid email';

/** The issuer values Google stamps on an `id_token` (both spellings are current). */
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * What the account's `lastError` says once Google stops honouring the grant.
 * Written by the backend and deliberately NOT overwritten by the worker, which
 * has nothing more useful to say than the one instruction that resolves it.
 */
export const GOOGLE_AUTH_REVOKED_MESSAGE =
	'Google authorization was revoked. Reconnect with Google.';

export interface GoogleOAuthClient {
	clientId: string;
	clientSecret: string;
}

/** The configured client, or a clear "not configured" refusal. */
export function requireGoogleOAuthClient(): GoogleOAuthClient {
	const clientId = getOptional('GOOGLE_OAUTH_CLIENT_ID');
	const clientSecret = getOptional('GOOGLE_OAUTH_CLIENT_SECRET');
	if (!clientId || !clientSecret) {
		throwInvalidInput(
			'Google sign-in is not configured on this instance. Connect this mailbox with an app password, or ask an admin to configure a Google OAuth client.'
		);
	}
	return { clientId, clientSecret };
}

/** The redirect URI registered in Google Cloud Console (`oauthRedirectUri`). */
export function googleRedirectUri(): string {
	return oauthRedirectUri('google', 'Google sign-in');
}

/**
 * The URL the browser is sent to.
 *
 * `access_type=offline` + `prompt=consent` are what make Google return a REFRESH
 * token: without them a user who has already authorized this client gets an
 * access token only, and the connection would die in an hour with no way to
 * renew it. `login_hint` pre-selects the account on a re-authorize so the user
 * cannot accidentally reconnect a different mailbox.
 */
export function buildAuthorizationUrl(params: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	loginHint?: string;
}): string {
	const query = new URLSearchParams({
		client_id: params.clientId,
		redirect_uri: params.redirectUri,
		response_type: 'code',
		scope: SCOPES,
		access_type: 'offline',
		prompt: 'consent',
		include_granted_scopes: 'true',
		state: params.state,
		code_challenge: params.codeChallenge,
		code_challenge_method: 'S256',
	});
	if (params.loginHint) query.set('login_hint', params.loginHint);
	return `${AUTHORIZATION_ENDPOINT}?${query.toString()}`;
}

/** The `id_token` claims read below; each is checked for its type before use. */
interface GoogleIdTokenClaims {
	aud?: unknown;
	iss?: unknown;
	exp?: unknown;
	email?: unknown;
	email_verified?: unknown;
}

/**
 * Read the `id_token` payload (`readJwtPayload`, which explains why the
 * signature is not verified). The claim checks below are still made, because
 * they catch a MISCONFIGURED client (a token minted for someone else's client
 * id) and an unverified address.
 */
export function readVerifiedGoogleEmail(idToken: string, clientId: string): string {
	const claims: GoogleIdTokenClaims | null = readJwtPayload(idToken);
	if (!claims) throwInvalidInput('Google returned an unreadable sign-in token.');
	if (claims.aud !== clientId) {
		throwInvalidInput('Google returned a sign-in token for a different application.');
	}
	if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) {
		throwInvalidInput('Google returned a sign-in token from an unexpected issuer.');
	}
	// `exp` is seconds since the epoch. A token that is already expired means the
	// exchange raced something badly wrong (a replayed code, a clock far out of
	// step); refuse rather than connect a mailbox on a stale assertion.
	if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
		throwInvalidInput('Google returned an expired sign-in token. Please start again.');
	}
	// Google serializes this claim as a boolean or the string "true" depending on
	// the flow; treat only an affirmative as verified.
	if (claims.email_verified !== true && claims.email_verified !== 'true') {
		throwInvalidInput('This Google account does not have a verified email address.');
	}
	if (typeof claims.email !== 'string' || !claims.email) {
		throwInvalidInput('Google did not return an email address for this account.');
	}
	return claims.email.toLowerCase();
}

/**
 * Trade the authorization code for a refresh token + the signed-in address.
 *
 * A missing `refresh_token` is the one failure worth explaining: it means Google
 * decided this user had already granted the scopes and silently skipped the
 * consent screen, so there is nothing durable to store and the mailbox would
 * stop syncing within the hour.
 */
export async function exchangeAuthorizationCode(params: {
	client: GoogleOAuthClient;
	code: string;
	codeVerifier: string;
	redirectUri: string;
}): Promise<{ refreshToken: string; email: string }> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code: params.code,
		client_id: params.client.clientId,
		client_secret: params.client.clientSecret,
		redirect_uri: params.redirectUri,
		code_verifier: params.codeVerifier,
	});
	const token = await postTokenRequest(TOKEN_ENDPOINT, body);
	if (token.error) {
		console.warn('google oauth: authorization code exchange refused', { error: token.error });
		throwInvalidInput('Google refused this sign-in. Please start again.');
	}
	if (!token.refresh_token) {
		throwInvalidInput(
			'Google did not return a long-lived authorization. Open your Google Account → Security → Third-party access, remove Owlat, then connect again.'
		);
	}
	if (!token.id_token) {
		throwInvalidInput('Google did not say which account was signed in. Please start again.');
	}
	return {
		refreshToken: token.refresh_token,
		email: readVerifiedGoogleEmail(token.id_token, params.client.clientId),
	};
}

/** Drop every cached access token (tests). */
export function clearGoogleAccessTokenCache(): void {
	clearAccessTokenCache();
}

/**
 * Mint an access token for an oauth2 account from its stored refresh token.
 *
 * `revoked` means the grant is gone — a user who revoked Owlat in their Google
 * account, or a refresh token Google expired. Retrying cannot fix that, so the
 * account is flipped to `auth_error` with a message that names the one action
 * that does (reconnect), exactly as a wrong app password would be.
 *
 * A token is reused until a minute before it expires: first from this isolate's
 * memory, then from the sealed row a previous mint stored. Only when both miss
 * is Google asked for a new one.
 *
 * `envelopeIv` is the account row's `secretIv`; it only identifies which stored
 * envelope this refresh token came from, so neither cache tier can outlive a
 * rotation.
 */
export async function refreshGoogleAccessToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	refreshToken: string,
	envelopeIv: string
): Promise<OAuthAccessTokenResult> {
	const cached = await readCachedAccessToken(ctx, accountId, envelopeIv);
	if (cached) return { kind: 'token', ...cached };

	const client = requireGoogleOAuthClient();
	const token = await postTokenRequest(
		TOKEN_ENDPOINT,
		new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: client.clientId,
			client_secret: client.clientSecret,
		})
	);
	if (token.error === 'invalid_grant') {
		console.warn('google oauth: refresh token rejected (invalid_grant)', { accountId });
		await markGrantRevoked(ctx, accountId, envelopeIv, GOOGLE_AUTH_REVOKED_MESSAGE);
		return { kind: 'revoked' };
	}
	if (token.error || !token.access_token) {
		console.warn('google oauth: access-token refresh failed', {
			accountId,
			error: token.error ?? 'no_access_token',
		});
		return { kind: 'failed' };
	}
	const minted = {
		accessToken: token.access_token,
		expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
	};
	await rememberAccessToken(ctx, accountId, envelopeIv, minted);
	return { kind: 'token', ...minted };
}
