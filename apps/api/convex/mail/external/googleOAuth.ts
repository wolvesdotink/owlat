/**
 * Google sign-in for external mailboxes — v8 (non-Node) surface.
 *
 * Connecting a Gmail / Google Workspace mailbox through Google's own
 * authorization-code flow instead of an app password. The user consents once in
 * Google's UI; we store the resulting REFRESH token inside the same encrypted
 * envelope every external account already uses, and the mail-sync worker
 * authenticates to `imap.gmail.com` / `smtp.gmail.com` with SASL XOAUTH2 using
 * short-lived access tokens minted from it.
 *
 * App passwords are NOT replaced. They remain the path for every other
 * provider and the default path for Gmail too — the connect form always renders
 * the password fields, and only adds a Google sign-in button beneath them once
 * an admin has configured a Google OAuth client.
 *
 * This file holds the pieces that must run in the v8 isolate: the "is this
 * instance configured" query the connect form reads, and the state-row
 * lifecycle the two-leg handshake needs (shared with Microsoft sign-in through
 * `oauthState.ts`). Everything that touches `node:crypto`,
 * Google's token endpoint, or a plaintext token lives in the `'use node'`
 * siblings `googleOAuthActions.ts` (the `start` / `complete` actions) and
 * `googleOAuthTokens.ts` (the wire helpers + the worker's access-token refresh).
 *
 *   Public:   isConfigured
 *   Internal: _createStateInternal, _consumeStateInternal, _sweepExpiredInternal
 *
 * The callback itself is a PAGE in apps/web, not an HTTP route: it runs with the
 * user's session, so `complete` is an ordinary authed action and the existing
 * session-bound connect/update mutations are reused unchanged.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import { authedQuery } from '../../lib/authedFunctions';
import { isEnvPresent } from '../../lib/env';
import { oauthIntentValidator } from '../../schema/mailAccounts';
import {
	OAUTH_STATE_TTL_MS,
	consumeOAuthState,
	createOAuthState,
	type OAuthIntent,
} from './oauthState';
import type { Doc } from '../../_generated/dataModel';

export { assertSafeReturnTo } from './oauthState';

/** What a completed Google authorization should do (shared with Microsoft). */
export type GoogleOAuthIntent = OAuthIntent;

/** How long a started authorization may sit unfinished. */
export const GOOGLE_OAUTH_STATE_TTL_MS = OAUTH_STATE_TTL_MS;

/** Env vars the instance operator must set for Google sign-in to be offered. */
export const GOOGLE_OAUTH_ENV_KEYS = [
	'GOOGLE_OAUTH_CLIENT_ID',
	'GOOGLE_OAUTH_CLIENT_SECRET',
] as const;

/** Whether this deployment has a Google OAuth client configured. */
export function isGoogleOAuthConfigured(): boolean {
	return GOOGLE_OAUTH_ENV_KEYS.every(isEnvPresent);
}

/**
 * Whether this instance can offer Google sign-in. Returns a boolean only —
 * never the client id or secret.
 */
// all-members: whether the operator configured a Google OAuth client is a
// property of the instance, not of anyone's data — every member who can reach
// the connect form needs it to know which branch to render.
// token-safe: returns a boolean computed from env presence; reads no table.
export const isConfigured = authedQuery({
	args: {},
	handler: async () => ({ configured: isGoogleOAuthConfigured() }),
});

/** Record one in-flight Google authorization for the caller (`createOAuthState`). */
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
	handler: async (ctx, args) => await createOAuthState(ctx, 'google', args),
});

/**
 * Consume one Google authorization by its `state` nonce (`consumeOAuthState`):
 * single use, and `null` for a row that is not the caller's, not in their
 * active organization, not a Google one, or expired.
 */
// authz: internal only; re-resolves the caller's own session and refuses any
// state row that is not theirs, in their current organization.
export const _consumeStateInternal = internalMutation({
	args: { state: v.string() },
	handler: async (ctx, args): Promise<Doc<'externalMailOAuthStates'> | null> =>
		await consumeOAuthState(ctx, 'google', args.state),
});

/**
 * Daily sweep of authorizations nobody ever finished, for every provider (the
 * table holds Google and Microsoft handshakes alike). `start`'s
 * delete-then-insert already caps the table at one row per user, so this only
 * reclaims rows for users who never come back; bounded so a tick stays small.
 */
// authz: internal cron sweep — no caller, no session.
export const _sweepExpiredInternal = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const rows = await ctx.db.query('externalMailOAuthStates').take(500);
		let deleted = 0;
		for (const row of rows) {
			if (row.expiresAt <= now) {
				await ctx.db.delete(row._id);
				deleted += 1;
			}
		}
		return { deleted };
	},
});
