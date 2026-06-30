import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import { authedIdentityMutation } from '../lib/authedFunctions';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { requireAuthenticatedIdentity } from '../lib/sessionOrganization';
import { throwForbidden } from '../_utils/errors';

// Internal query to get a user profile by auth user ID (server-side only)
export const getByAuthUserId = internalQuery({
	args: { authUserId: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.authUserId))
			.first();
	},
});

// Internal query to get a user profile by ID (server-side only)
export const get = internalQuery({
	args: { userProfileId: v.id('userProfiles') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.userProfileId);
	},
});

// Internal query to get a user profile by email (server-side only)
export const getByEmail = internalQuery({
	args: { email: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query('userProfiles')
			.withIndex('by_email', (q) => q.eq('email', args.email))
			.first();
	},
});

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

// Internal mutation to update user profile (server-side only)
export const update = internalMutation({
	args: {
		userProfileId: v.id('userProfiles'),
		name: v.optional(v.string()),
		image: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		// Validate input lengths
		if (args.name !== undefined) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.image !== undefined) validateStringLength(args.image, STRING_LIMITS.URL, 'Image URL');

		const updates: {
			name?: string;
			image?: string;
			updatedAt: number;
		} = { updatedAt: now };

		if (args.name !== undefined) {
			updates.name = args.name;
		}

		if (args.image !== undefined) {
			updates.image = args.image;
		}

		await ctx.db.patch(args.userProfileId, updates);
		return args.userProfileId;
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
