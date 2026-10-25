/**
 * Contact management authorization guard.
 *
 * The contact-property and relationship mutations all require `contacts:manage`
 * with the same message. This guard owns that precondition so the wording has
 * one home and can't drift across the call sites. It checks the session the
 * builder's floor already resolved, so it never reads the session again.
 */

import {
	hasPermission,
	requirePermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';

/** Require that the caller may manage contacts (owner/admin role). */
export function requireContactsManage(session: MutationSessionContext): void {
	requirePermission(
		hasPermission(session.role, 'contacts:manage'),
		'Only owners and admins can manage contacts'
	);
}
