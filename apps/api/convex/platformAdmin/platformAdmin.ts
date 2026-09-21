import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { throwForbidden } from '../_utils/errors';
import { requireAuthenticatedIdentity } from '../lib/sessionOrganization';

/**
 * Platform-admin authorization.
 *
 * The tier ABOVE the organization roles. Org roles (owner/admin/editor) govern
 * the product — members, campaigns, mailboxes, settings. Platform admin governs
 * the DEPLOYMENT: applying an in-app update, restoring a backup, the operator
 * console. They are deliberately separate checks, and an org owner is NOT
 * automatically a platform admin — `platformAdmins` membership is its own row,
 * granted once and then managed by a `superadmin`.
 *
 * How the roster is populated (see `bootstrap.ts` for the full rationale):
 *
 *   - Fresh installs: `/seed/admin` grants the setup user `superadmin` as part
 *     of the bootstrap, so the operator surface works out of the box.
 *   - Installs seeded before that existed: the org owner claims the empty
 *     roster once from the admin hub (`claimInitialPlatformAdmin`).
 *   - Everyone after that: a `superadmin` promotes them via `addPlatformAdmin`,
 *     which is what `Operator → Admins` drives.
 *
 * Both bootstrap paths refuse once ANY platform admin exists, so the empty-table
 * precondition — not the caller's org role — is what keeps them from becoming an
 * escalation route.
 *
 * Authorization model for the functions that consume this module: each is an
 * `authedMutation` / `authedQuery` whose handler first calls
 * `requirePlatformAdmin(ctx)` (FORBIDDEN otherwise), and superadmin-only
 * operations additionally check `role === 'superadmin'`. The session floor lives
 * in `authedFunctions`; `requirePlatformAdmin` is the second, role gate on top
 * of it.
 *
 * The same module backs the multi-tenant control plane in the separate private
 * Nest repo (see MEMORY: "Nest Extracted"); the queries here stay
 * single-deployment-shaped because this repo is one org per deployment.
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
