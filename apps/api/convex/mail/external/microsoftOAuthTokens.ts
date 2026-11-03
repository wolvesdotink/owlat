'use node';

/**
 * The Microsoft identity platform's OAuth 2.0 wire protocol — the half that
 * needs Node.
 *
 * The authorization-URL shape, the authorization-code exchange, the `id_token`
 * read, and the worker-facing access-token refresh, including keeping the
 * stored refresh token current. PKCE, the token POST and the access-token cache
 * are shared with Google sign-in (`oauthTokenShared.ts`).
 *
 * NOTHING here is logged beyond taxonomy: access tokens, refresh tokens, the
 * authorization code and the client secret never reach `console.*`.
 */

import { internal } from '../../_generated/api';
import { encryptSecret } from '../../lib/credentialCrypto';
import { getOptional } from '../../lib/env';
import { throwInvalidInput } from '../../_utils/errors';
import { microsoftTenant } from './microsoftOAuth';
import {
	markGrantRevoked,
	oauthRedirectUri,
	postTokenRequest,
	readCachedAccessToken,
	readJwtPayload,
	rememberAccessToken,
	type OAuthAccessTokenResult,
} from './oauthTokenShared';
import type { OAuthEnvelopeSecret, OAuthServerPreset } from './oauthConnect';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

const AUTHORITY = 'https://login.microsoftonline.com';

/**
 * The two delegated Exchange Online permissions SASL XOAUTH2 needs, one per
 * protocol. They belong to the `outlook.office.com` resource, which serves
 * personal and work accounts alike. A token request may name only one resource,
 * so the OpenID scopes are the only others that can ride along.
 */
const MAIL_SCOPES = [
	'https://outlook.office.com/IMAP.AccessAsUser.All',
	'https://outlook.office.com/SMTP.Send',
];

/**
 * `offline_access` is what makes Microsoft return a refresh token. `openid email
 * profile` put the signed-in address into the `id_token`, so the exchange learns
 * which account was picked without a call to another resource.
 */
const AUTHORIZE_SCOPES = [...MAIL_SCOPES, 'offline_access', 'openid', 'email', 'profile'].join(' ');
const REFRESH_SCOPES = [...MAIL_SCOPES, 'offline_access'].join(' ');

/** The directory id Microsoft stamps on every personal (consumer) account's token. */
export const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refresh-token errors that mean the grant is gone for good: revoked, expired,
 * the password changed, or a policy (MFA, conditional access, consent withdrawn)
 * now demands the user sign in again. Only the user reconnecting fixes these.
 */
const REVOKED_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required']);

/**
 * Microsoft issues a new refresh token on every refresh, and each one lives 90
 * days from its own issue. Keeping the first one forever would cut the mailbox
 * off three months after it was connected. Writing every new one would rewrite
 * the account row every hour, so the stored token is replaced once it is a week
 * old: far inside its lifetime, and rare enough to cost nothing.
 */
const REFRESH_TOKEN_ROTATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What the account's `lastError` says once Microsoft stops honouring the grant.
 * Written by the backend and deliberately NOT overwritten by the worker.
 */
export const MICROSOFT_AUTH_REVOKED_MESSAGE =
	'Microsoft authorization was revoked or has expired. Reconnect with Microsoft.';

/**
 * Microsoft's IMAP and SMTP hosts for OAuth. Personal accounts submit through
 * `smtp-mail.outlook.com`, work and school accounts through `smtp.office365.com`;
 * both use STARTTLS on 587 (the mail-sync worker refuses to send without it).
 */
const MICROSOFT_365_PRESET: OAuthServerPreset = {
	imapHost: 'outlook.office365.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.office365.com',
	smtpPort: 587,
	isSmtpSecure: false,
};
const OUTLOOK_COM_PRESET: OAuthServerPreset = {
	...MICROSOFT_365_PRESET,
	smtpHost: 'smtp-mail.outlook.com',
};

/** The server preset for an account in this directory. */
export function microsoftPresetForTenant(tenantId: string): OAuthServerPreset {
	return tenantId.toLowerCase() === MICROSOFT_CONSUMER_TENANT_ID
		? OUTLOOK_COM_PRESET
		: MICROSOFT_365_PRESET;
}

export interface MicrosoftOAuthClient {
	clientId: string;
	clientSecret: string;
	tenant: string;
}

/** The configured app registration, or a clear "not configured" refusal. */
export function requireMicrosoftOAuthClient(): MicrosoftOAuthClient {
	const clientId = getOptional('MICROSOFT_OAUTH_CLIENT_ID');
	const clientSecret = getOptional('MICROSOFT_OAUTH_CLIENT_SECRET');
	if (!clientId || !clientSecret) {
		throwInvalidInput(
			'Microsoft sign-in is not configured on this instance. Connect this mailbox with an app password, or ask an admin to register a Microsoft app.'
		);
	}
	const tenant = microsoftTenant();
	if (!tenant) {
		throwInvalidInput(
			'Microsoft sign-in is misconfigured on this instance: MICROSOFT_OAUTH_TENANT is not a tenant id or domain.'
		);
	}
	return { clientId, clientSecret, tenant };
}

/** The redirect URI registered with the Microsoft app (`oauthRedirectUri`). */
export function microsoftRedirectUri(): string {
	return oauthRedirectUri('microsoft', 'Microsoft sign-in');
}

function tokenEndpoint(tenant: string): string {
	return `${AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

/**
 * The URL the browser is sent to.
 *
 * `prompt=select_account` shows the account picker even when the browser is
 * already signed in, so a user with a personal and a work account chooses which
 * one to connect instead of getting whichever session is open. `login_hint`
 * pre-selects the address on a re-authorization.
 */
export function buildMicrosoftAuthorizationUrl(params: {
	client: MicrosoftOAuthClient;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	loginHint?: string;
}): string {
	const query = new URLSearchParams({
		client_id: params.client.clientId,
		redirect_uri: params.redirectUri,
		response_type: 'code',
		response_mode: 'query',
		scope: AUTHORIZE_SCOPES,
		prompt: 'select_account',
		state: params.state,
		code_challenge: params.codeChallenge,
		code_challenge_method: 'S256',
	});
	if (params.loginHint) query.set('login_hint', params.loginHint);
	return `${AUTHORITY}/${encodeURIComponent(params.client.tenant)}/oauth2/v2.0/authorize?${query.toString()}`;
}

/** The `id_token` claims read below; each is checked for its type before use. */
interface MicrosoftIdTokenClaims {
	aud?: unknown;
	iss?: unknown;
	tid?: unknown;
	exp?: unknown;
	email?: unknown;
	preferred_username?: unknown;
}

function asAddress(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().toLowerCase();
	return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Whether a directory id is one the configured tenant admits. `common` admits
 * every directory; `organizations` every one but the consumer directory;
 * `consumers` only that one; a GUID only itself. A tenant given as a domain
 * cannot be mapped to its id here, and the authority already enforces it.
 */
function tenantAdmits(tenant: string, tenantId: string): boolean {
	const tid = tenantId.toLowerCase();
	const configured = tenant.toLowerCase();
	if (configured === 'common') return true;
	if (configured === 'organizations') return tid !== MICROSOFT_CONSUMER_TENANT_ID;
	if (configured === 'consumers') return tid === MICROSOFT_CONSUMER_TENANT_ID;
	if (GUID_PATTERN.test(configured)) return tid === configured;
	return true;
}

/**
 * Read the `id_token` payload (`readJwtPayload`, which explains why the
 * signature is not verified) and check the claims that catch a misconfigured
 * app or a token from a directory this instance does not admit.
 *
 * The address comes from `email`, else `preferred_username` (the sign-in name,
 * on a work account its UPN, whose domain the tenant had to verify). Microsoft
 * does not vouch for `email` the way Google's `email_verified` does, and that is
 * acceptable here: the address only names the mailbox the token is presented
 * for, and Exchange refuses an XOAUTH2 login for a mailbox the signed-in user
 * has no access to, so a wrong claim yields a mailbox that cannot sync, never
 * access to someone else's.
 */
export function readMicrosoftIdentity(
	idToken: string,
	client: Pick<MicrosoftOAuthClient, 'clientId' | 'tenant'>
): { email: string; tenantId: string } {
	const claims: MicrosoftIdTokenClaims | null = readJwtPayload(idToken);
	if (!claims) throwInvalidInput('Microsoft returned an unreadable sign-in token.');
	if (claims.aud !== client.clientId) {
		throwInvalidInput('Microsoft returned a sign-in token for a different application.');
	}
	// Every v2.0 token names its directory twice: `tid`, and inside `iss`. A
	// mismatch, or a shape other than this, is not a token this flow asked for.
	const tid = claims.tid;
	if (
		typeof tid !== 'string' ||
		!GUID_PATTERN.test(tid) ||
		claims.iss !== `${AUTHORITY}/${tid}/v2.0`
	) {
		throwInvalidInput('Microsoft returned a sign-in token from an unexpected issuer.');
	}
	if (!tenantAdmits(client.tenant, tid)) {
		throwInvalidInput(
			'This Microsoft account belongs to an organization this instance does not accept.'
		);
	}
	// `exp` is seconds since the epoch; an already-expired token means something
	// went badly wrong (a replayed code, a clock far out of step).
	if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
		throwInvalidInput('Microsoft returned an expired sign-in token. Please start again.');
	}
	const email = asAddress(claims.email) ?? asAddress(claims.preferred_username);
	if (!email) {
		throwInvalidInput('Microsoft did not return an email address for this account.');
	}
	return { email, tenantId: tid };
}

/**
 * Whether the access token covers both mail protocols. A tenant policy can
 * grant fewer scopes than were asked for, and a mailbox that can read but not
 * send (or the reverse) would fail later with a far less helpful message.
 * Microsoft lists scopes with or without the resource prefix, so only the last
 * path segment is compared. An answer without `scope` is accepted: it says
 * nothing either way, and the first login reports a real shortfall.
 */
function coversMailScopes(scope: string | undefined): boolean {
	if (scope === undefined) return true;
	const granted = new Set(
		scope
			.split(/\s+/)
			.filter(Boolean)
			.map((s) => s.slice(s.lastIndexOf('/') + 1).toLowerCase())
	);
	return granted.has('imap.accessasuser.all') && granted.has('smtp.send');
}

/** Trade the authorization code for a refresh token + the signed-in identity. */
export async function exchangeMicrosoftAuthorizationCode(params: {
	client: MicrosoftOAuthClient;
	code: string;
	codeVerifier: string;
	redirectUri: string;
}): Promise<{ refreshToken: string; email: string; tenantId: string }> {
	const token = await postTokenRequest(
		tokenEndpoint(params.client.tenant),
		new URLSearchParams({
			grant_type: 'authorization_code',
			code: params.code,
			client_id: params.client.clientId,
			client_secret: params.client.clientSecret,
			redirect_uri: params.redirectUri,
			code_verifier: params.codeVerifier,
		})
	);
	if (token.error) {
		console.warn('microsoft oauth: authorization code exchange refused', { error: token.error });
		throwInvalidInput('Microsoft refused this sign-in. Please start again.');
	}
	if (!coversMailScopes(token.scope)) {
		throwInvalidInput(
			'Microsoft did not grant Owlat access to both reading and sending mail. If this is a work or school account, ask your administrator to allow IMAP and SMTP access for Owlat.'
		);
	}
	if (!token.refresh_token) {
		throwInvalidInput(
			'Microsoft did not return a long-lived authorization. Start again and allow Owlat to stay connected.'
		);
	}
	if (!token.id_token) {
		throwInvalidInput('Microsoft did not say which account was signed in. Please start again.');
	}
	const identity = readMicrosoftIdentity(token.id_token, params.client);
	return { refreshToken: token.refresh_token, ...identity };
}

/**
 * Seal a newer refresh token into the account's envelope, if the envelope is
 * still the one it was minted from. Answers the new envelope's IV, or `null`
 * when nothing was written (a reconnect or disconnect got there first, or the
 * write failed). Best-effort: the token in hand stays valid for 90 days.
 */
async function storeRotatedRefreshToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	expectedIv: string,
	refreshToken: string
): Promise<string | null> {
	try {
		const secret: OAuthEnvelopeSecret = {
			oauthRefreshToken: refreshToken,
			oauthRefreshTokenStoredAt: Date.now(),
		};
		const sealed = encryptSecret(JSON.stringify(secret));
		// checkpoint: the rotated grant stands on its own; the access token stored
		// after it is a cache, and losing that write costs one extra refresh.
		const { rotated } = await ctx.runMutation(
			internal.mail.external.accessTokenStore._rotateRefreshTokenInternal,
			{
				accountId,
				expectedIv,
				ciphertext: sealed.ciphertext,
				iv: sealed.iv,
				authTag: sealed.authTag,
				version: sealed.version,
			}
		);
		return rotated ? sealed.iv : null;
	} catch {
		console.warn('microsoft oauth: could not store the rotated refresh token', { accountId });
		return null;
	}
}

/**
 * Mint an access token for a Microsoft oauth2 account from its stored refresh
 * token.
 *
 * `revoked` means the grant is gone (see {@link REVOKED_ERRORS}); the account is
 * flipped to `auth_error` with the one instruction that fixes it. A token is
 * reused from either cache tier until a minute before it expires. When the
 * refresh answer carries a newer refresh token and the stored one is due for
 * replacement, the envelope is re-sealed and the access token is cached under
 * the new envelope's IV, which is the one the next credential fetch will read.
 */
export async function refreshMicrosoftAccessToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	secret: OAuthEnvelopeSecret,
	envelopeIv: string
): Promise<OAuthAccessTokenResult> {
	const cached = await readCachedAccessToken(ctx, accountId, envelopeIv);
	if (cached) return { kind: 'token', ...cached };

	const client = requireMicrosoftOAuthClient();
	const token = await postTokenRequest(
		tokenEndpoint(client.tenant),
		new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: secret.oauthRefreshToken,
			client_id: client.clientId,
			client_secret: client.clientSecret,
			scope: REFRESH_SCOPES,
		})
	);
	if (token.error && REVOKED_ERRORS.has(token.error)) {
		console.warn('microsoft oauth: refresh token rejected', { accountId, error: token.error });
		await markGrantRevoked(ctx, accountId, envelopeIv, MICROSOFT_AUTH_REVOKED_MESSAGE);
		return { kind: 'revoked' };
	}
	if (token.error || !token.access_token) {
		console.warn('microsoft oauth: access-token refresh failed', {
			accountId,
			error: token.error ?? 'no_access_token',
		});
		return { kind: 'failed' };
	}
	const minted = {
		accessToken: token.access_token,
		expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
	};
	let liveIv = envelopeIv;
	const storedAt = secret.oauthRefreshTokenStoredAt;
	if (
		token.refresh_token &&
		token.refresh_token !== secret.oauthRefreshToken &&
		(storedAt === undefined || Date.now() - storedAt >= REFRESH_TOKEN_ROTATE_AFTER_MS)
	) {
		liveIv =
			(await storeRotatedRefreshToken(ctx, accountId, envelopeIv, token.refresh_token)) ??
			envelopeIv;
	}
	await rememberAccessToken(ctx, accountId, liveIv, minted);
	return { kind: 'token', ...minted };
}
