import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { throwForbidden } from '../_utils/errors';
import { requireAuthenticatedIdentity } from '../lib/sessionOrganization';

/**
 * Platform-admin authorization.
 *
 * CONTROL-PLANE-ONLY / INERT ON OSS SELF-HOST (intentional, not a bug):
 * the platform-admin console is a multi-tenant operator surface. On an OSS
 * self-host deployment NO production path populates the `platformAdmins`
 * table — `seedPlatformAdmin` (below) is an `internalMutation` with no
 * production caller (only tests invoke it), and `addPlatformAdmin` requires
 * an EXISTING platform admin to bootstrap. So `requirePlatformAdmin` always
 * throws FORBIDDEN and `isPlatformAdmin` always returns false: every
 * `platformAdmin/*` function is reachable in code but unreachable in practice,
 * and the console renders empty rather than exposing cross-tenant controls.
 *
 * This is deliberate. The control plane (the surface that would seed and use
 * these admins across many tenants) lives in the SEPARATE private Nest repo
 * (see MEMORY: "Nest Extracted", 2026-05-15); this repo is single-org-per-
 * deployment OSS. We keep the module so the control plane can reuse it
 * unchanged, but we do NOT wire an OSS bootstrap — granting one machine
 * operator power over the instance is a product decision for the deployer, not
 * a default. To enable it deliberately, a deployer would call
 * `seedPlatformAdmin` once (e.g. from a one-off internal mutation / setup
 * step) against their own auth user id.
 *
 * Intended authorization model for the mutations/queries that DO run when a
 * platform admin exists: each is an `authedMutation` / `authedQuery` whose
 * handler first calls `requirePlatformAdmin(ctx)` (FORBIDDEN otherwise), and
 * superadmin-only operations additionally check `role === 'superadmin'`. The
 * session floor lives in `authedFunctions`; `requirePlatformAdmin` is the
 * second, role gate on top of it.
 */

/**
 * Check if the current user is a platform admin.
 * Returns the admin record if found, null otherwise.
 */
async function getPlatformAdmin(ctx: QueryCtx) {
	// Get the current user's auth session
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) return null;

	// Look up in platformAdmins table by auth user ID
	const admin = await ctx.db
		.query('platformAdmins')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', identity.subject))
		.first();

	return admin;
}

/**
 * Require the current user to be a platform admin.
 * Throws FORBIDDEN if not an admin.
 */
export async function requirePlatformAdmin(ctx: QueryCtx): Promise<{
	authUserId: string;
	email: string;
	role: 'admin' | 'superadmin';
}> {
	const identity = await requireAuthenticatedIdentity(ctx);

	const admin = await ctx.db
		.query('platformAdmins')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', identity.subject))
		.first();

	if (!admin) {
		throwForbidden('Platform admin access required');
	}

	return {
		authUserId: admin.authUserId,
		email: admin.email,
		role: admin.role as 'admin' | 'superadmin',
	};
}

/**
 * Public query to check if current user is a platform admin.
 */
// public: nav helper, returns a boolean; safe for anonymous
export const isPlatformAdmin = publicQuery({
	args: {},
	handler: async (ctx) => {
		const admin = await getPlatformAdmin(ctx);
		return admin !== null;
	},
});

/**
 * Public query returning the current platform admin's auth user id (or null
 * when the caller is not a platform admin). Used by server routes that need to
 * record the real actor in an audit trail — e.g. the in-app system-update flow
 * stamps this id as `initiatedBy` instead of a generic 'platform-admin' tag.
 */
// public: returns the caller's own id only when they are already a platform
// admin; anonymous / non-admin callers get null. No cross-user disclosure.
export const currentPlatformAdminUserId = publicQuery({
	args: {},
	handler: async (ctx) => {
		const admin = await getPlatformAdmin(ctx);
		return admin?.authUserId ?? null;
	},
});

/**
 * Internal query to check if a user is a platform admin (for HTTP handlers).
 */
export const isPlatformAdminByUserId = internalQuery({
	args: { authUserId: v.string() },
	handler: async (ctx, args) => {
		const admin = await ctx.db
			.query('platformAdmins')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.authUserId))
			.first();

		return admin !== null;
	},
});

/**
 * Internal mutation to seed a platform admin (for initial setup).
 * Only works if no admins exist yet.
 */
export const seedPlatformAdmin = internalMutation({
	args: {
		authUserId: v.string(),
		email: v.string(),
	},
	handler: async (ctx, args) => {
		// Check if any admins exist
		const existingAdmin = await ctx.db.query('platformAdmins').first();
		if (existingAdmin) {
			throw new Error('Platform admins already exist. Use platformAdminMutations to add more.');
		}

		return await ctx.db.insert('platformAdmins', {
			authUserId: args.authUserId,
			email: args.email,
			role: 'superadmin',
			createdAt: Date.now(),
		});
	},
});
