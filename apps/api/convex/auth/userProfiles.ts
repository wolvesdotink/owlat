import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedIdentityMutation } from '../lib/authedFunctions';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { requireAuthenticatedIdentity } from '../lib/sessionOrganization';
import { throwForbidden } from '../_utils/errors';

// Create a user profile on signup. Runs before org membership exists, so it
// uses the authenticated-identity floor rather than the org-member one.
// Auth: verifies the authenticated user's identity matches the authUserId being
// registered, so a caller cannot create/claim a profile for someone else.
export const create = authedIdentityMutation({
	args: {
		authUserId: v.string(),
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

		// Validate input lengths
		validateStringLength(args.email, STRING_LIMITS.NAME, 'Email');
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
			email: args.email,
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
			email: args.email,
			name: args.name,
			createdAt: now,
			updatedAt: now,
		});
	},
});
