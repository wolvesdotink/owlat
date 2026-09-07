import { APIError } from 'better-auth/api';
import { components } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';

/**
 * Server-side registration gate (H3).
 *
 * The invite-only rule previously lived ONLY in the web register page
 * (`apps/web/app/pages/auth/register.vue`, a client-side redirect), so
 * `POST /api/auth/sign-up/email` was open to anyone who called it directly. This
 * hook enforces the rule on the server, at the one choke point every email
 * signup passes through (`databaseHooks.user.create.before`).
 *
 * The single org is bootstrapped by the `/seed/admin` HTTP action
 * (`seedAdmin.ts`), which writes through the RAW component adapter and so never
 * triggers this hook — the seeded owner is created regardless. Past that:
 *   - Zero users ⇒ this is the very first account (a signup-based bootstrap) ⇒
 *     allowed.
 *   - Any user exists ⇒ registration is invite-only: a signup is permitted only
 *     when a non-expired PENDING invitation exists for that exact (normalized)
 *     email.
 *
 * Fails CLOSED: a missing/unshaped email is rejected, and any signup without a
 * live invitation on a bootstrapped instance is refused.
 *
 * NOTE: this closes the "anyone can self-register an account" hole, but does NOT
 * by itself stop an attacker who self-registers with a LEAKED invitee's email
 * (a matching pending invitation exists) — only email verification
 * (REQUIRE_EMAIL_VERIFICATION) proves inbox ownership and closes that. See the
 * `requireEmailVerification` wiring in `auth.ts`.
 */
export async function assertRegistrationAllowed(
	ctx: ActionCtx,
	email: string | undefined
): Promise<void> {
	const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
	if (!normalized) {
		throw new APIError('BAD_REQUEST', { message: 'A valid email is required to register.' });
	}

	// Is the instance bootstrapped? If no user exists yet, allow the first account
	// (a signup-based bootstrap); the seed path bypasses this hook entirely.
	const anyUser = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'user',
		where: [],
		paginationOpts: { cursor: null, numItems: 1 },
	})) as { page?: unknown[] } | null;
	if (!anyUser?.page?.length) return;

	// Invite-only past bootstrap: require a non-expired pending invitation for the
	// exact email. BetterAuth stores invitation emails lowercased.
	const invitations = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'invitation',
		where: [
			{ field: 'email', value: normalized },
			{ field: 'status', value: 'pending' },
		],
		paginationOpts: { cursor: null, numItems: 50 },
	})) as { page?: Array<{ expiresAt?: number | string | null }> } | null;

	const now = Date.now();
	const hasLiveInvite = (invitations?.page ?? []).some((inv) => {
		if (inv.expiresAt == null) return false;
		return new Date(inv.expiresAt).getTime() > now;
	});

	if (!hasLiveInvite) {
		throw new APIError('FORBIDDEN', {
			message: 'Registration on this instance is invite-only. Ask an administrator to invite you.',
		});
	}
}
