/**
 * Microsoft sign-in for external mailboxes — v8 (non-Node) surface.
 *
 * Connecting an Outlook.com, Hotmail or Microsoft 365 mailbox through the
 * Microsoft identity platform's authorization-code flow instead of an app
 * password, which Microsoft is retiring for IMAP/SMTP and which many work
 * tenants already refuse. It mirrors Google sign-in (`googleOAuth.ts`): the
 * REFRESH token sits in the account's encrypted envelope, and the mail-sync
 * worker authenticates to `outlook.office365.com` and Microsoft's SMTP submission
 * host with SASL XOAUTH2 using short-lived access tokens minted from it.
 *
 * App passwords are NOT replaced; the connect form only adds a Microsoft button
 * once an admin has registered an app and set its client id and secret.
 *
 * This file holds the instance-configuration read and the state-row wrappers.
 * Everything that touches the token endpoint or a plaintext token lives in the
 * `'use node'` siblings `microsoftOAuthActions.ts` and `microsoftOAuthTokens.ts`.
 *
 *   Public:   isConfigured
 *   Internal: _createStateInternal, _consumeStateInternal
 *   Helpers:  isMicrosoftConsumerDomain, isMicrosoftMxHost (the hosted-domain
 *             check `microsoftOAuthActions.isMicrosoftHosted` runs)
 *
 * Abandoned rows are swept by `googleOAuth._sweepExpiredInternal`, which covers
 * the whole table.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import { authedQuery } from '../../lib/authedFunctions';
import { getOptional, isEnvPresent } from '../../lib/env';
import { oauthIntentValidator } from '../../schema/mailAccounts';
import { consumeOAuthState, createOAuthState } from './oauthState';
import type { Doc } from '../../_generated/dataModel';

/** Env vars the instance operator must set for Microsoft sign-in to be offered. */
export const MICROSOFT_OAUTH_ENV_KEYS = [
	'MICROSOFT_OAUTH_CLIENT_ID',
	'MICROSOFT_OAUTH_CLIENT_SECRET',
] as const;

/**
 * `common` accepts personal Microsoft accounts and every work or school tenant,
 * which is what an app registered for "any organizational directory and
 * personal accounts" expects.
 */
export const DEFAULT_MICROSOFT_TENANT = 'common';

/**
 * A tenant is interpolated into the authority URL's PATH, so it is held to the
 * characters a tenant can actually contain: `common` / `organizations` /
 * `consumers`, a directory GUID, or a verified domain. Anything else (a slash, a
 * `?`, `@`) could point the flow at a different path or host.
 */
const TENANT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}\.)*[A-Za-z0-9-]{1,63}$/;

/**
 * The configured tenant, `DEFAULT_MICROSOFT_TENANT` when unset, or `null` when
 * the operator set something that is not a tenant.
 */
export function microsoftTenant(): string | null {
	const raw = getOptional('MICROSOFT_OAUTH_TENANT')?.trim();
	if (!raw) return DEFAULT_MICROSOFT_TENANT;
	return TENANT_PATTERN.test(raw) && raw.length <= 253 ? raw : null;
}

/** Whether this deployment has a usable Microsoft app registration configured. */
export function isMicrosoftOAuthConfigured(): boolean {
	return MICROSOFT_OAUTH_ENV_KEYS.every(isEnvPresent) && microsoftTenant() !== null;
}

/** Microsoft's own consumer mail domains (Outlook.com and its older names). */
const MICROSOFT_CONSUMER_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com']);

/**
 * Every MX host Microsoft receives mail on ends in this: a Microsoft 365
 * tenant's domain points at `<tenant>.mail.protection.outlook.com`, the consumer
 * domains at `*.olc.protection.outlook.com`.
 */
const MICROSOFT_MX_SUFFIX = '.protection.outlook.com';

export function isMicrosoftConsumerDomain(domain: string): boolean {
	return MICROSOFT_CONSUMER_DOMAINS.has(domain.toLowerCase());
}

/** Whether an MX exchange (`contoso-com.mail.protection.outlook.com.`) is Microsoft's. */
export function isMicrosoftMxHost(exchange: string): boolean {
	return exchange.trim().toLowerCase().replace(/\.$/, '').endsWith(MICROSOFT_MX_SUFFIX);
}

/**
 * Whether this instance can offer Microsoft sign-in. Returns a boolean only —
 * never the client id, the secret or the tenant.
 */
// all-members: whether the operator registered a Microsoft app is a property of
// the instance, not of anyone's data — every member who can reach the connect
// form needs it to know which branch to render.
// token-safe: returns a boolean computed from env presence; reads no table.
export const isConfigured = authedQuery({
	args: {},
	handler: async () => ({ configured: isMicrosoftOAuthConfigured() }),
});

/** Record one in-flight Microsoft authorization for the caller (`createOAuthState`). */
// authz: delegated — internal only, and it re-resolves the caller's own session
// (propagated from the calling action) rather than trusting an id in its args.
export const _createStateInternal = internalMutation({
	args: {
		state: v.string(),
		codeVerifier: v.string(),
		intent: oauthIntentValidator,
		returnTo: v.string(),
		expiresAt: v.number(),
	},
	handler: async (ctx, args) => await createOAuthState(ctx, 'microsoft', args),
});

/**
 * Consume one Microsoft authorization by its `state` nonce
 * (`consumeOAuthState`): single use, and `null` for a row that is not the
 * caller's, not in their active organization, not a Microsoft one, or expired.
 */
// authz: internal only; re-resolves the caller's own session and refuses any
// state row that is not theirs, in their current organization.
export const _consumeStateInternal = internalMutation({
	args: { state: v.string() },
	handler: async (ctx, args): Promise<Doc<'externalMailOAuthStates'> | null> =>
		await consumeOAuthState(ctx, 'microsoft', args.state),
});
