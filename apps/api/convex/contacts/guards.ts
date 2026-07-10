/**
 * Contact management authorization guard.
 *
 * The contact-property and relationship mutations all opened with the same
 * `requireOrgPermission(ctx, 'contacts:manage', …)` check and identical
 * message. This guard owns that precondition so the wording has one home and
 * can't drift across the seven call sites.
 */

import type { QueryCtx, MutationCtx } from '../_generated/server';
import { requireOrgPermission } from '../lib/sessionOrganization';

/** Require that the caller may manage contacts (owner/admin role). */
export async function requireContactsManage(ctx: QueryCtx | MutationCtx) {
	return await requireOrgPermission(
		ctx,
		'contacts:manage',
		'Only owners and admins can manage contacts'
	);
}
