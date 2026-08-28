import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedIdentityMutation } from '../lib/authedFunctions';
import {
	validateStringLength,
	STRING_LIMITS,
	isValidEmail,
	normalizeEmail,
} from '../lib/inputGuards';
import { requireAuthenticatedIdentity } from '../lib/sessionOrganization';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';

// Create a user profile on signup. Runs before org membership exists, so it
// uses the authenticated-identity floor rather than the org-member one.
// Auth: verifies the authenticated user's identity matches the authUserId being
// registered, so a caller cannot create/claim a profile for someone else.
export const create = authedIdentityMutation({
	args: {
		authUserId: v.string(),
		// Accepted for wire compatibility but IGNORED: the stored email is bound to
		// the verified identity from the JWT, never this client-supplied value.
		email: v.string(),
		name: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Verify the caller is authenticated AND the authUserId matches their
		// own identity — without this an authenticated user could register a
		// profile bound to another user's auth id.
		const identity = await requireAuthenticatedIdentity(ctx);
		if (identity.subject !== args.authUserId) {
			throwForbidden('Cannot create a profile for a different user');
		}

		// H3: bind the profile email to the VERIFIED identity email carried in the
		// JWT, not the client-supplied `args.email`. The claim paths
		// (mail/pendingInboxMembership.claimInboxMemberships, mail/pendingMailbox)
		// match a caller's profile email against reserved grants, so trusting a
		// client value here would let a caller register any address and hijack a
		// teammate's inbox reservation. Stored normalized so the `by_email` index
		// lookups (canonical lowercase) match.
		const identityEmail = typeof identity.email === 'string' ? normalizeEmail(identity.email) : '';
		if (!identityEmail || !isValidEmail(identityEmail)) {
			throwInvalidInput('Authenticated identity is missing a valid email');
		}

		// Validate input lengths
		if (args.name) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');

		// Idempotent: return existing profile if already created
		const existing = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.authUserId))
			.first();

		if (existing) {
			return existing._id;
		}

		const now = Date.now();

		const profileId = await ctx.db.insert('userProfiles', {
			authUserId: args.authUserId,
			email: identityEmail,
			name: args.name,
			createdAt: now,
			updatedAt: now,
		});

		return profileId;
	},
});

// Internal mutation to create a user profile (for seed/admin setup, no auth required)
export const createInternal = internalMutation({
	args: {
		authUserId: v.string(),
		email: v.string(),
		name: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Idempotent: return existing profile if already created
		const existing = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.authUserId))
			.first();

		if (existing) {
			return existing._id;
		}

		const now = Date.now();

		return await ctx.db.insert('userProfiles', {
			authUserId: args.authUserId,
			// Normalized so it matches the canonical `by_email` lookups the claim
			// paths perform (same binding as the public `create`).
			email: normalizeEmail(args.email),
			name: args.name,
			createdAt: now,
			updatedAt: now,
		});
	},
});
