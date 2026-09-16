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
 * provider, the fallback on instances with no Google OAuth client configured,
 * and a supported alternative for Google even when one IS configured — the
 * connect form offers Google sign-in as the recommended option and an app
 * password beside it.
 *
 * This file holds the pieces that must run in the v8 isolate: the "is this
 * instance configured" query the connect form reads, and the state-row
 * lifecycle the two-leg handshake needs. Everything that touches `node:crypto`,
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
import { internalMutation } from '../../_generated/server';
import { authedQuery } from '../../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { isEnvPresent } from '../../lib/env';
import { googleOAuthIntentValidator } from '../../schema/mailAccounts';
import { throwForbidden, throwInvalidInput } from '../../_utils/errors';
import type { Infer } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';

/**
 * What a completed Google authorization should do. Declared on the schema leaf
 * (the state table persists it) and re-exported here as the feature's surface,
 * so callers import one name and the table + the actions can never drift.
 */
export { googleOAuthIntentValidator };
export type GoogleOAuthIntent = Infer<typeof googleOAuthIntentValidator>;

/** How long a started authorization may sit unfinished. */
export const GOOGLE_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

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
 * Validate the post-connect destination.
 *
 * It is attacker-influenced (it rides through Google and back), so it must be a
 * SAME-SITE relative path: one leading slash, and never `//` — `//evil.example`
 * is a protocol-relative URL that `navigateTo` would follow off-site, turning
 * the callback page into an open redirect. A backslash is refused too; some
 * URL parsers normalize `/\` to `//`.
 */
export function assertSafeReturnTo(returnTo: string): void {
	if (
		!returnTo.startsWith('/') ||
		returnTo.startsWith('//') ||
		returnTo.startsWith('/\\') ||
		returnTo.includes('\\')
	) {
		throwInvalidInput('Invalid return path.');
	}
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

/**
 * Record one in-flight authorization for the caller.
 *
 * Deletes the caller's prior rows first: a user who abandons the Google screen
 * and starts again would otherwise leave a row per attempt, and only the newest
 * can ever be completed. One live attempt per user, so the table cannot grow
 * with abandoned handshakes.
 */
// authz: delegated — internal only, and it re-resolves the caller's own session
// (propagated from the calling action) rather than trusting an id in its args.
export const _createStateInternal = internalMutation({
	args: {
		state: v.string(),
		codeVerifier: v.string(),
		intent: googleOAuthIntentValidator,
		returnTo: v.string(),
		expiresAt: v.number(),
	},
	handler: async (ctx, args) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.activeOrganizationId || !s.role) throwForbidden('Not authenticated');
		assertSafeReturnTo(args.returnTo);
		const prior = await ctx.db
			.query('externalMailOAuthStates')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.take(20); // bounded: one live attempt per user; the cap is a defensive ceiling
		for (const row of prior) await ctx.db.delete(row._id);
		return await ctx.db.insert('externalMailOAuthStates', {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			provider: 'google',
			state: args.state,
			codeVerifier: args.codeVerifier,
			intent: args.intent,
			returnTo: args.returnTo,
			createdAt: Date.now(),
			expiresAt: args.expiresAt,
		});
	},
});

/**
 * Consume one authorization by its `state` nonce: delete the row and hand it
 * back, or `null`.
 *
 * SINGLE USE by construction — the delete happens before any check, so a
 * replayed callback (the user reloading the page, a URL leaked through a
 * referrer header) finds nothing left. A row belonging to a DIFFERENT user or a
 * different ACTIVE ORGANIZATION, or one past its expiry, reads as `null` too:
 * the caller cannot tell those apart from "never existed", and a probe learns
 * nothing from the difference.
 *
 * The organization is checked as well as the user because the intent was
 * authorized against the org that was active at `start` — a member of several
 * orgs who switches between the two legs would otherwise land a team inbox or a
 * seed in whichever org happened to be active when they came back.
 */
// authz: internal only; re-resolves the caller's own session and refuses any
// state row that is not theirs, in their current organization.
export const _consumeStateInternal = internalMutation({
	args: { state: v.string() },
	handler: async (ctx, args): Promise<Doc<'externalMailOAuthStates'> | null> => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		const row = await ctx.db
			.query('externalMailOAuthStates')
			.withIndex('by_state', (q) => q.eq('state', args.state))
			.unique();
		if (!row) return null;
		await ctx.db.delete(row._id);
		if (row.userId !== s.userId) return null;
		if (row.organizationId !== s.activeOrganizationId) return null;
		if (row.expiresAt <= Date.now()) return null;
		return row;
	},
});

/**
 * Daily sweep of authorizations nobody ever finished. `start`'s
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
