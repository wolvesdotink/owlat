/**
 * Server-side throttle for re-sending organization invitation emails.
 *
 * The choke point is `enforceResendThrottle` — an INTERNAL mutation invoked from
 * the `sendInvitationEmail` hook in `auth/auth.ts`, so EVERY send path passes
 * through it: the first invite, a cooperating-client resend, and a raw
 * `POST /api/auth/organization/invite-member` with `resend: true`. It stamps the
 * last-sent time on the initial send and throws inside the cooldown, so no client
 * (or direct API loop) can spam an invitee below the 1-per-minute floor.
 *
 * `throttleResend` is the CLIENT-facing pre-check only: a read-only guard the UI
 * calls before triggering BetterAuth's resend so it can surface a friendly
 * "wait Ns" toast instead of a swallowed background failure. It never writes —
 * the hook owns the stamp — so it can't desync the real cooldown.
 *
 * The copyable accept link is always available regardless, so this rate-limits
 * the *email* only, never access to the invite.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { throwForbidden, throwRateLimited } from '../_utils/errors';

// A single invitation may trigger at most one send email (initial or resend) per
// minute — the initial send counts, so a resend seconds later is refused.
const RESEND_COOLDOWN_MS = 60_000;

/** Seconds remaining before `lastSentAt` clears the cooldown, or 0 if elapsed. */
function cooldownRemaining(lastSentAt: number, now: number): number {
	const elapsed = now - lastSentAt;
	if (elapsed >= RESEND_COOLDOWN_MS) return 0;
	return Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
}

/**
 * THE enforcement choke point. Called from the `sendInvitationEmail` hook for
 * every invitation email (initial + resend, from any client). Throws
 * `rateLimited` when the same invitation was sent less than `RESEND_COOLDOWN_MS`
 * ago; otherwise stamps the send time so the next send is measured from now.
 *
 * Internal-only: the BetterAuth hook hands us a real, existing invitation, so
 * there is no unvalidated-id path here.
 */
export const enforceResendThrottle = internalMutation({
	args: {
		invitationId: v.string(),
		organizationId: v.string(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db
			.query('invitationResends')
			.withIndex('by_invitation', (q) => q.eq('invitationId', args.invitationId))
			.first();

		if (existing) {
			const retryAfter = cooldownRemaining(existing.lastSentAt, now);
			if (retryAfter > 0) {
				throwRateLimited(
					`Please wait ${retryAfter}s before resending this invitation.`,
					retryAfter
				);
			}
			await ctx.db.patch(existing._id, { lastSentAt: now });
		} else {
			await ctx.db.insert('invitationResends', {
				invitationId: args.invitationId,
				organizationId: args.organizationId,
				lastSentAt: now,
			});
		}
	},
});

/**
 * Client-facing pre-check for the "Resend" button. READ-ONLY: it reports whether
 * the cooldown has elapsed (throwing the friendly rate-limit error when it has
 * not) without touching the stamp, so the actual send — which the hook gates and
 * records — stays the single source of truth. Returns `{ ok: true }` when a
 * resend is currently permitted.
 */
export const throttleResend = adminMutation({
	args: {
		invitationId: v.string(),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) {
			throwForbidden('No active organization');
		}

		const row = await ctx.db
			.query('invitationResends')
			.withIndex('by_invitation', (q) => q.eq('invitationId', args.invitationId))
			.first();

		// Scope the read to the caller's org: a row for another organization is
		// treated the same as "no row", so the cooldown never leaks across tenants.
		const existing = row?.organizationId === session.activeOrganizationId ? row : null;

		if (existing) {
			const retryAfter = cooldownRemaining(existing.lastSentAt, Date.now());
			if (retryAfter > 0) {
				throwRateLimited(
					`Please wait ${retryAfter}s before resending this invitation.`,
					retryAfter
				);
			}
		}

		return { ok: true as const };
	},
});
