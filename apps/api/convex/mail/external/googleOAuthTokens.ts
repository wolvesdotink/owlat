'use node';

/**
 * Google's OAuth 2.0 wire protocol — the half that needs Node.
 *
 * PKCE generation (`node:crypto`), the authorization-URL shape, the
 * authorization-code exchange, the `id_token` read, and the worker-facing
 * access-token refresh. Kept out of `googleOAuthActions.ts` so neither file
 * approaches the ~500 LOC cap, and out of `accountsActions.ts` so the refresh
 * path `getCredentialsForWorker` needs can be imported without pulling the
 * connect actions in behind it.
 *
 * NOTHING here is logged. Access tokens, refresh tokens, the authorization code
 * and the client secret never reach `console.*`; only taxonomy (`invalid_grant`,
 * an HTTP status) does.
 */

import { createHash, randomBytes } from 'node:crypto';
import { internal } from '../../_generated/api';
import { getOptional } from '../../lib/env';
import { throwInvalidInput } from '../../_utils/errors';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

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

/** Refresh an access token this long before it actually expires. */
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

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

/**
 * The redirect URI, which must match the one registered in Google Cloud Console
 * byte for byte. `SITE_URL` may or may not carry a trailing slash depending on
 * how the operator wrote it, and `https://x.example//oauth/google/callback` is a
 * DIFFERENT URI to Google — strip it.
 */
export function googleRedirectUri(): string {
	const siteUrl = getOptional('SITE_URL');
	if (!siteUrl) {
		throwInvalidInput('SITE_URL is not configured on this instance, so Google sign-in cannot run.');
	}
	return `${siteUrl.replace(/\/+$/, '')}/oauth/google/callback`;
}

function base64url(bytes: Buffer): string {
	return bytes.toString('base64url');
}

/** A 43-character base64url nonce — the `state` parameter and the PKCE verifier. */
export function randomUrlSafeToken(): string {
	return base64url(randomBytes(32));
}

/** S256 PKCE challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
	return base64url(createHash('sha256').update(verifier).digest());
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

interface GoogleTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	id_token?: string;
	error?: string;
	error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
	const res = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString(),
	});
	let parsed: GoogleTokenResponse;
	try {
		parsed = (await res.json()) as GoogleTokenResponse;
	} catch {
		parsed = { error: `http_${res.status}` };
	}
	return parsed;
}

/**
 * Read the `id_token` payload.
 *
 * The signature is deliberately NOT verified, and that is sound here: this token
 * did not arrive from a browser — we just received it as the response body of a
 * server-to-server POST we made ourselves to Google's token endpoint over TLS.
 * There is no path for an attacker to substitute one without breaking TLS, which
 * is the same assumption every other statement in that response rests on. The
 * claim checks below are still made, because they catch a MISCONFIGURED client
 * (a token minted for someone else's client id) and an unverified address.
 */
export function readVerifiedGoogleEmail(idToken: string, clientId: string): string {
	const segments = idToken.split('.');
	if (segments.length !== 3) throwInvalidInput('Google returned an unreadable sign-in token.');
	let claims: {
		aud?: string;
		iss?: string;
		exp?: number;
		email?: string;
		email_verified?: boolean | string;
	};
	try {
		// A payload that parses to something other than an object (`null`, a bare
		// string or number) would otherwise sail past JSON.parse and only blow up
		// on the first property read — a TypeError that escapes this try and
		// surfaces as a 500 instead of the invalid-input refusal below.
		const decoded: unknown = JSON.parse(
			Buffer.from(segments[1] ?? '', 'base64url').toString('utf8')
		);
		if (typeof decoded !== 'object' || decoded === null) throw new Error('not an object');
		claims = decoded;
	} catch {
		throwInvalidInput('Google returned an unreadable sign-in token.');
	}
	if (claims.aud !== clientId) {
		throwInvalidInput('Google returned a sign-in token for a different application.');
	}
	if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) {
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
	if (!claims.email) throwInvalidInput('Google did not return an email address for this account.');
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
	const token = await postToken(body);
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

/**
 * Warm-isolate cache of minted access tokens, keyed by account AND by the
 * envelope the refresh token came out of.
 *
 * Convex may reuse a Node isolate across invocations, in which case the worker's
 * repeated credential fetches reuse one token instead of spending a Google token
 * request each time. A cold isolate is simply a miss — never a correctness
 * difference — so nothing depends on this surviving.
 *
 * The envelope's IV is part of the key because it is re-randomized on every
 * write: a reconnect (new grant, new refresh token, same account id) therefore
 * lands on a different key, instead of being served the previous grant's token
 * for up to an hour after the user re-authorized precisely to get a live one.
 */
const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/** Drop a cached token (tests, and any path that learns the grant is dead). */
export function clearGoogleAccessTokenCache(): void {
	accessTokenCache.clear();
}

export interface GoogleAccessToken {
	accessToken: string;
	expiresAt: number;
}

/**
 * What minting an access token produced.
 *
 * `revoked` is kept apart from `failed` all the way out to the worker: a revoked
 * grant is TERMINAL (only the user reconnecting fixes it, and the account has
 * already been flipped to `auth_error` with that instruction), while `failed` is
 * a Google hiccup or a network blip that the next retry may well survive.
 * Collapsing the two into one `null` is what let a retry loop overwrite the
 * actionable message with a generic error and then spin forever.
 */
export type GoogleAccessTokenResult =
	| ({ kind: 'token' } & GoogleAccessToken)
	| { kind: 'revoked' }
	| { kind: 'failed' };

/**
 * Mint an access token for an oauth2 account from its stored refresh token.
 *
 * `revoked` means the grant is gone — a user who revoked Owlat in their Google
 * account, or a refresh token Google expired. Retrying cannot fix that, so the
 * account is flipped to `auth_error` with a message that names the one action
 * that does (reconnect), exactly as a wrong app password would be.
 *
 * `envelopeIv` is the account row's `secretIv`; it only identifies which stored
 * envelope this refresh token came from, so the cache cannot outlive a rotation.
 */
export async function refreshGoogleAccessToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	refreshToken: string,
	envelopeIv: string
): Promise<GoogleAccessTokenResult> {
	const cacheKey = `${accountId}:${envelopeIv}`;
	const cached = accessTokenCache.get(cacheKey);
	if (cached && cached.expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_SKEW_MS) {
		return { kind: 'token', ...cached };
	}

	const client = requireGoogleOAuthClient();
	const token = await postToken(
		new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: client.clientId,
			client_secret: client.clientSecret,
		})
	);
	if (token.error === 'invalid_grant') {
		accessTokenCache.delete(cacheKey);
		console.warn('google oauth: refresh token rejected (invalid_grant)', { accountId });
		await ctx.runMutation(internal.mail.external.accounts.setSyncStatus, {
			accountId,
			status: 'auth_error',
			lastError: GOOGLE_AUTH_REVOKED_MESSAGE,
		});
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
	accessTokenCache.set(cacheKey, minted);
	return { kind: 'token', ...minted };
}
