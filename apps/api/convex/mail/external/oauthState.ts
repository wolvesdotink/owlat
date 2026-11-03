/**
 * The state-row lifecycle every mailbox sign-in handshake (Google, Microsoft)
 * shares: record one in-flight authorization, then consume it exactly once.
 *
 * Helpers only, with no Convex functions of their own: each provider module
 * (`googleOAuth.ts`, `microsoftOAuth.ts`) exposes thin internal mutations over
 * them, so a provider's `complete` can only ever consume a row its own `start`
 * wrote. A Google callback that presents a Microsoft `state` finds nothing.
 */

import { throwForbidden, throwInvalidInput } from '../../_utils/errors';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import type { Infer } from 'convex/values';
import type { MutationCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import type { oauthIntentValidator, oauthProviderValidator } from '../../schema/mailAccounts';

export type OAuthIntent = Infer<typeof oauthIntentValidator>;
export type OAuthProvider = Infer<typeof oauthProviderValidator>;

/** How long a started authorization may sit unfinished. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Validate the post-connect destination.
 *
 * It is attacker-influenced (it rides through the provider and back), so it must
 * be a SAME-SITE relative path: one leading slash, and never `//` —
 * `//evil.example` is a protocol-relative URL that `navigateTo` would follow
 * off-site, turning the callback page into an open redirect. A backslash is
 * refused too; some URL parsers normalize `/\` to `//`.
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
 * Record one in-flight authorization for the caller.
 *
 * Deletes the caller's prior rows first, whichever provider they were for: a
 * user who abandons the consent screen and starts again would otherwise leave a
 * row per attempt, and only the newest can ever be completed. One live attempt
 * per user, so the table cannot grow with abandoned handshakes.
 *
 * Re-resolves the caller's own session (propagated from the calling action)
 * rather than trusting an id in its args.
 */
export async function createOAuthState(
	ctx: MutationCtx,
	provider: OAuthProvider,
	args: {
		state: string;
		codeVerifier: string;
		intent: OAuthIntent;
		returnTo: string;
		expiresAt: number;
	}
) {
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
		provider,
		state: args.state,
		codeVerifier: args.codeVerifier,
		intent: args.intent,
		returnTo: args.returnTo,
		createdAt: Date.now(),
		expiresAt: args.expiresAt,
	});
}

/**
 * Consume one authorization by its `state` nonce: delete the row and hand it
 * back, or `null`.
 *
 * SINGLE USE by construction — the delete happens before any check, so a
 * replayed callback (the user reloading the page, a URL leaked through a
 * referrer header) finds nothing left. A row belonging to a DIFFERENT user, a
 * different ACTIVE ORGANIZATION or a different PROVIDER, or one past its expiry,
 * reads as `null` too: the caller cannot tell those apart from "never existed",
 * and a probe learns nothing from the difference.
 *
 * The organization is checked as well as the user because the intent was
 * authorized against the org that was active at `start` — a member of several
 * orgs who switches between the two legs would otherwise land a team inbox or a
 * seed in whichever org happened to be active when they came back. The provider
 * is checked because the verifier and the intent belong to one authorization
 * server's handshake; exchanging them at the other one is never meaningful.
 */
export async function consumeOAuthState(
	ctx: MutationCtx,
	provider: OAuthProvider,
	state: string
): Promise<Doc<'externalMailOAuthStates'> | null> {
	const s = await getBetterAuthSessionWithRole(ctx);
	if (!s || !s.role) throwForbidden('Not authenticated');
	const row = await ctx.db
		.query('externalMailOAuthStates')
		.withIndex('by_state', (q) => q.eq('state', state))
		.unique();
	if (!row) return null;
	await ctx.db.delete(row._id);
	if (row.userId !== s.userId) return null;
	if (row.organizationId !== s.activeOrganizationId) return null;
	if (row.provider !== provider) return null;
	if (row.expiresAt <= Date.now()) return null;
	return row;
}
