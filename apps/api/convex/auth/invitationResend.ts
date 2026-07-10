/**
 * Server-side throttle for re-sending organization invitation emails.
 *
 * The actual re-send goes through BetterAuth's own `inviteMember({ resend: true })`
 * hook, which routes to the existing system-mail path
 * (`auth/auth.ts` → `internal.systemMail.sendSystemEmail`). This module owns only
 * the abuse guard: a per-invitation cooldown so an admin cannot spam an invitee
 * by hammering "Resend". Enforced here on the server so the floor holds no matter
 * what the client does. The copyable accept link is always available regardless,
 * so this rate-limits the *email* only, never access to the invite.
 */

import { v } from 'convex/values';
import { adminMutation } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { throwForbidden, throwRateLimited } from '../_utils/errors';

// A single invitation may trigger at most one resend email per minute.
const RESEND_COOLDOWN_MS = 60_000;

/**
 * Record (and gate) an invitation-email resend. Throws `rateLimited` when the
 * same invitation was resent less than `RESEND_COOLDOWN_MS` ago; otherwise stamps
 * the send time and returns. The caller performs the actual BetterAuth resend
 * only after this resolves.
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

		const now = Date.now();
		const existing = await ctx.db
			.query('invitationResends')
			.withIndex('by_invitation', (q) => q.eq('invitationId', args.invitationId))
			.first();

		if (existing) {
			const elapsed = now - existing.lastSentAt;
			if (elapsed < RESEND_COOLDOWN_MS) {
				const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
				throwRateLimited(
					`Please wait ${retryAfter}s before resending this invitation.`,
					retryAfter
				);
			}
			await ctx.db.patch(existing._id, { lastSentAt: now });
		} else {
			await ctx.db.insert('invitationResends', {
				invitationId: args.invitationId,
				organizationId: session.activeOrganizationId,
				lastSentAt: now,
			});
		}

		return { ok: true as const };
	},
});
