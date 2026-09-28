import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import { requireOrgMember, requireOrgPermission } from '../lib/sessionOrganization';

/**
 * Internal organization-membership assertion backing the `authedAction` floor.
 *
 * Actions cannot touch the database directly, so the `authedAction` wrapper runs
 * this query — which inherits the action's authenticated identity through
 * `ctx.runQuery` — to enforce the SAME org-member floor that `authedQuery` and
 * `authedMutation` apply. Without it, an org-wide `authedAction` would be
 * reachable by any logged-in identity, including a self-registered non-member.
 *
 * Throws `unauthenticated` (no session) / `forbidden` (no active org or not a
 * member). Returns `null` on success — callers only care that it didn't throw.
 */
export const assertOrgMember = internalQuery({
	args: {},
	handler: async (ctx): Promise<null> => {
		await requireOrgMember(ctx);
		return null;
	},
});

/**
 * Internal owner/admin (`organization:manage`) assertion for `authedAction`
 * handlers that need an admin floor, not merely a member one. Same rationale as
 * `assertOrgMember`: a `'use node'` action cannot run `requireOrgPermission`
 * itself (it needs the db), so it inherits the action's identity through
 * `ctx.runQuery` here. Throws `forbidden` for non-admins; returns `null` on
 * success.
 */
export const assertOrgAdmin = internalQuery({
	args: {},
	handler: async (ctx): Promise<null> => {
		await requireOrgPermission(ctx, 'organization:manage');
		return null;
	},
});

/**
 * Public owner/admin (`organization:manage`) assertion for the Nitro gate
 * `requireOrgAdmin`, which guards the org-owner actions of the Settings ->
 * Delivery transport editor (validate and apply). The `adminQuery`
 * builder enforces the floor before the handler runs, so a clean `null` IS the
 * proof: it reads nothing and returns nothing. It exists so that gate no longer
 * borrows the authorization of an unrelated read model, whose permission could
 * be widened on its own.
 *
 * Throws `unauthenticated` (no session) / `forbidden` (not an owner or admin).
 */
export const assertOrganizationManage = adminQuery({
	args: {},
	returns: v.null(),
	handler: async () => null,
});
