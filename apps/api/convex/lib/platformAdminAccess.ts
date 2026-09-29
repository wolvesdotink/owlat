/**
 * Platform-admin access: the one `platformAdmins` lookup and the two gates
 * built on it.
 *
 * Platform admin is the tier above the organization roles: it governs the
 * deployment (in-app updates, backups, the operator console), not the product.
 * `platformAdmin/platformAdmin.ts` holds the rationale and the public
 * `isPlatformAdmin` probe; this module holds the checks themselves.
 *
 * Handlers do not call these gates by hand. `platformAdminQuery`,
 * `platformAdminMutation` and `platformSuperadminMutation` in
 * `lib/authedFunctions.ts` run them after the org-member floor and pass the
 * resulting `PlatformAdminContext` to the handler as its third argument.
 *
 * Leaf module: it imports only `_generated` types, `_utils/errors` and
 * `lib/sessionOrganization`, so `lib/authedFunctions.ts` can depend on it
 * without a cycle through `platformAdmin/platformAdmin.ts`.
 */

import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { throwForbidden } from '../_utils/errors';
import { requireAuthenticatedIdentity } from './sessionOrganization';

/** What a platform-admin gate resolves and hands to the handler. */
export interface PlatformAdminContext {
	authUserId: string;
	email: string;
	role: Doc<'platformAdmins'>['role'];
}

/** The caller's `platformAdmins` row, or null. The one `by_auth_user_id` lookup. */
export async function findPlatformAdmin(
	db: QueryCtx['db'],
	authUserId: string
): Promise<Doc<'platformAdmins'> | null> {
	return await db
		.query('platformAdmins')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
}

/**
 * Require the authenticated caller to be a platform admin (any role).
 * Throws `unauthenticated` without an identity, `forbidden` without a row.
 */
export async function requirePlatformAdmin(ctx: QueryCtx): Promise<PlatformAdminContext> {
	const identity = await requireAuthenticatedIdentity(ctx);
	const admin = await findPlatformAdmin(ctx.db, identity.subject);
	if (!admin) {
		throwForbidden('Platform admin access required');
	}
	return { authUserId: admin.authUserId, email: admin.email, role: admin.role };
}

/**
 * Require the caller to be a `superadmin`, the role that manages the roster.
 * Throws `forbidden` for a plain platform admin, like every other role gate.
 */
export async function requireSuperadmin(ctx: QueryCtx): Promise<PlatformAdminContext> {
	const admin = await requirePlatformAdmin(ctx);
	if (admin.role !== 'superadmin') {
		throwForbidden('Only superadmins can manage platform admins');
	}
	return admin;
}
