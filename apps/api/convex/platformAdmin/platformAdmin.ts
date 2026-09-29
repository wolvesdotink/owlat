import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { findPlatformAdmin } from '../lib/platformAdminAccess';

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
 * Authorization model for the functions that consume this module: each is a
 * `platformAdminQuery` / `platformAdminMutation` (FORBIDDEN unless the caller has
 * a `platformAdmins` row), and roster management is a
 * `platformSuperadminMutation` (FORBIDDEN unless that row is `superadmin`). The
 * builders live in `lib/authedFunctions.ts` on top of the org-member floor; the
 * lookup and the gates themselves live in `lib/platformAdminAccess.ts`.
 *
 * The same module backs the multi-tenant control plane in the separate private
 * Nest repo (see MEMORY: "Nest Extracted"); the queries here stay
 * single-deployment-shaped because this repo is one org per deployment.
 */

/**
 * Public query to check if current user is a platform admin.
 */
// public: nav helper, returns a boolean; safe for anonymous
// authz: self-scoped — answers only whether the CALLER is a platform admin.
export const isPlatformAdmin = publicQuery({
	args: {},
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) return false;
		return (await findPlatformAdmin(ctx.db, identity.subject)) !== null;
	},
});

/**
 * Internal query to check if a user is a platform admin (for HTTP handlers).
 */
export const isPlatformAdminByUserId = internalQuery({
	args: { authUserId: v.string() },
	handler: async (ctx, args) => (await findPlatformAdmin(ctx.db, args.authUserId)) !== null,
});
