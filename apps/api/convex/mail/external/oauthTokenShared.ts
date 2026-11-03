'use node';

/**
 * The OAuth 2.0 pieces Google and Microsoft sign-in share, in the Node runtime.
 *
 * PKCE generation (`node:crypto`), the form POST to a token endpoint, the
 * redirect URI built off `SITE_URL`, and the two-tier cache of minted access
 * tokens. Each provider's own wire details (endpoints, scopes, the `id_token`
 * claims it stamps, which refusals mean "revoked") stay in
 * `googleOAuthTokens.ts` / `microsoftOAuthTokens.ts`.
 *
 * NOTHING here is logged beyond taxonomy: access tokens, refresh tokens, the
 * authorization code and the client secret never reach `console.*`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { v, type Infer } from 'convex/values';
import { validatorDecoder } from '@owlat/worker-protocol/decodeJson';
import { internal } from '../../_generated/api';
import { decryptSecret, encryptSecret } from '../../lib/credentialCrypto';
import { getOptional } from '../../lib/env';
import { FETCH_TIMEOUTS, fetchWithTimeout } from '../../lib/fetchWithTimeout';
import { throwInvalidInput } from '../../_utils/errors';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

/** Refresh an access token this long before it actually expires. */
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

/** A 43-character base64url nonce — the `state` parameter and the PKCE verifier. */
export function randomUrlSafeToken(): string {
	return randomBytes(32).toString('base64url');
}

/** S256 PKCE challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
	return createHash('sha256').update(verifier).digest().toString('base64url');
}

/**
 * The redirect URI for a provider's callback page, which must match the one
 * registered with the provider byte for byte. `SITE_URL` may or may not carry a
 * trailing slash depending on how the operator wrote it, and
 * `https://x.example//oauth/google/callback` is a DIFFERENT URI to the provider —
 * strip it.
 */
export function oauthRedirectUri(provider: 'google' | 'microsoft', label: string): string {
	const siteUrl = getOptional('SITE_URL');
	if (!siteUrl) {
		throwInvalidInput(`SITE_URL is not configured on this instance, so ${label} cannot run.`);
	}
	return `${siteUrl.replace(/\/+$/, '')}/oauth/${provider}/callback`;
}

/**
 * A token endpoint's answer: the tokens on success, `error` on a refusal. Both
 * providers speak this RFC 6749 shape; `scope` is what Microsoft actually
 * granted, which may be narrower than what was asked for.
 */
const tokenResponseValidator = v.object({
	access_token: v.optional(v.string()),
	refresh_token: v.optional(v.string()),
	expires_in: v.optional(v.number()),
	id_token: v.optional(v.string()),
	scope: v.optional(v.string()),
	error: v.optional(v.string()),
	error_description: v.optional(v.string()),
});
export type OAuthTokenResponse = Infer<typeof tokenResponseValidator>;
const decodeTokenResponse = validatorDecoder(tokenResponseValidator);

/** POST a form to a token endpoint and decode the answer. Never throws on a refusal. */
export async function postTokenRequest(
	endpoint: string,
	body: URLSearchParams
): Promise<OAuthTokenResponse> {
	const res = await fetchWithTimeout(
		endpoint,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		},
		FETCH_TIMEOUTS.thirdPartyApi
	);
	let answer: unknown;
	try {
		answer = await res.json();
	} catch {
		return { error: `http_${res.status}` };
	}
	// A body in another shape is a failure with its own taxonomy entry, never a
	// token: no field of it is read, and none of it is logged.
	const parsed = decodeTokenResponse(answer);
	return parsed.ok ? parsed.value : { error: 'malformed_response' };
}

/**
 * Read a JWT's payload as an object, or `null`.
 *
 * The signature is deliberately NOT verified, and that is sound for the one
 * caller shape this serves: an `id_token` that arrived as the response body of a
 * server-to-server POST we made ourselves to the provider's token endpoint over
 * TLS. There is no path for an attacker to substitute one without breaking TLS,
 * which is the same assumption every other statement in that response rests on.
 * A payload that parses to something other than an object (`null`, a bare
 * string or number) is `null` too, so a claim read can never throw a TypeError
 * that surfaces as a 500.
 */
export function readJwtPayload(token: string): Record<string, unknown> | null {
	const segments = token.split('.');
	if (segments.length !== 3) return null;
	try {
		const decoded: unknown = JSON.parse(
			Buffer.from(segments[1] ?? '', 'base64url').toString('utf8')
		);
		if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
		return decoded as Record<string, unknown>;
	} catch {
		return null;
	}
}

export interface OAuthAccessToken {
	accessToken: string;
	expiresAt: number;
}

/**
 * What minting an access token produced.
 *
 * `revoked` is kept apart from `failed` all the way out to the worker: a revoked
 * grant is TERMINAL (only the user reconnecting fixes it, and the account has
 * already been flipped to `auth_error` with that instruction), while `failed` is
 * a provider hiccup or a network blip that the next retry may well survive.
 * Collapsing the two into one `null` is what let a retry loop overwrite the
 * actionable message with a generic error and then spin forever.
 */
export type OAuthAccessTokenResult =
	| ({ kind: 'token' } & OAuthAccessToken)
	| { kind: 'revoked' }
	| { kind: 'failed' };

/**
 * Warm-isolate cache of minted access tokens, keyed by account AND by the
 * envelope the refresh token came out of.
 *
 * The first of two tiers. Convex may reuse a Node isolate across invocations,
 * in which case the worker's repeated credential fetches reuse one token without
 * even a database read. A cold isolate falls through to the sealed
 * `externalMailAccessTokens` row (`accessTokenStore.ts`), and only a miss there
 * spends a token request.
 *
 * The envelope's IV is part of the key because it is re-randomized on every
 * write: a reconnect (new grant, new refresh token, same account id) therefore
 * lands on a different key, instead of being served the previous grant's token
 * for up to an hour after the user re-authorized precisely to get a live one.
 */
const accessTokenCache = new Map<string, OAuthAccessToken>();

/** Drop every cached token (tests, and any path that learns a grant is dead). */
export function clearAccessTokenCache(): void {
	accessTokenCache.clear();
}

function cacheKey(accountId: Id<'externalMailAccounts'>, envelopeIv: string): string {
	return `${accountId}:${envelopeIv}`;
}

function isFresh(expiresAt: number): boolean {
	return expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_SKEW_MS;
}

/**
 * A still-fresh token for this account and envelope: first from this isolate's
 * memory, then from the sealed row a previous mint stored. `null` means the
 * caller has to ask the provider.
 */
export async function readCachedAccessToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	envelopeIv: string
): Promise<OAuthAccessToken | null> {
	const key = cacheKey(accountId, envelopeIv);
	const cached = accessTokenCache.get(key);
	if (cached && isFresh(cached.expiresAt)) return cached;
	const stored = await readStoredAccessToken(ctx, accountId, envelopeIv);
	if (stored) accessTokenCache.set(key, stored);
	return stored;
}

/** Keep a freshly minted token in both tiers. */
export async function rememberAccessToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	envelopeIv: string,
	minted: OAuthAccessToken
): Promise<void> {
	accessTokenCache.set(cacheKey(accountId, envelopeIv), minted);
	await storeAccessToken(ctx, accountId, envelopeIv, minted);
}

/**
 * The grant behind this envelope is gone: forget its token in both tiers and
 * park the account on `auth_error` with the one instruction that fixes it.
 */
export async function markGrantRevoked(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	envelopeIv: string,
	message: string
): Promise<void> {
	accessTokenCache.delete(cacheKey(accountId, envelopeIv));
	await ctx.runMutation(internal.mail.external.accessTokenStore._clearStoredAccessToken, {
		accountId,
	});
	await ctx.runMutation(internal.mail.external.accounts.setSyncStatus, {
		accountId,
		status: 'auth_error',
		lastError: message,
	});
}

/**
 * The stored token for this account and envelope, when it is still fresh.
 *
 * Any problem reading or opening it is a cache miss, never an error: the worst
 * outcome is one extra token request.
 */
async function readStoredAccessToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	envelopeIv: string
): Promise<OAuthAccessToken | null> {
	try {
		const row = await ctx.runQuery(internal.mail.external.accessTokenStore._getStoredAccessToken, {
			accountId,
		});
		if (!row || row.sourceIv !== envelopeIv || !isFresh(row.expiresAt)) return null;
		const accessToken = decryptSecret({
			ciphertext: row.ciphertext,
			iv: row.iv,
			authTag: row.authTag,
			version: row.version,
		});
		return { accessToken, expiresAt: row.expiresAt };
	} catch {
		console.warn('mailbox oauth: stored access token unreadable, minting a new one', {
			accountId,
		});
		return null;
	}
}

/**
 * Seal and persist a freshly minted token. Best-effort: the caller already has
 * a live token, and a failed write only means the next cold call mints again.
 */
async function storeAccessToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	envelopeIv: string,
	minted: OAuthAccessToken
): Promise<void> {
	try {
		const sealed = encryptSecret(minted.accessToken);
		await ctx.runMutation(internal.mail.external.accessTokenStore._storeAccessToken, {
			accountId,
			sourceIv: envelopeIv,
			ciphertext: sealed.ciphertext,
			iv: sealed.iv,
			authTag: sealed.authTag,
			version: sealed.version,
			expiresAt: minted.expiresAt,
		});
	} catch {
		console.warn('mailbox oauth: could not store the minted access token', { accountId });
	}
}
