/**
 * Access requests — the door out of the "invitation required" dead-end.
 *
 * Owlat is invite-only: a user can authenticate (any configured sign-in method)
 * yet belong to no organization. The setup/team page used to meet that user with
 * a mute "Invitation required — ask your administrator" wall whose only action
 * was to sign out. That is a dead-end: the user has no in-app way to actually
 * reach an admin.
 *
 * This module lets the orgless-but-signed-in user ASK for access in one click.
 * The request is a NOTIFICATION, never a grant:
 *   - `request` — authed-identity self. Inserts one open row (idempotent: reuses
 *     the caller's existing open row instead of stacking) addressed to the single
 *     deployment org. It NEVER writes the BetterAuth member table, so it cannot
 *     add the caller to the org — an admin still invites them the normal way.
 *   - `listPending` / `resolve` — admin-only. Admins see open requests on the
 *     dashboard and mark a row done once they've invited the person. The queue
 *     itself (refresh-not-stack, listing, open-only resolve) is shared with the
 *     mailbox requests through lib/adminRequests.ts.
 *
 * Single-org-per-deployment stays intact: there is no self-serve org creation
 * here, only a message to the one org's admins.
 */

import { v } from 'convex/values';
import { adminMutation, adminQuery, authedIdentityMutation } from '../lib/authedFunctions';
import {
	getBetterAuthSession,
	getSingletonOrganizationId,
	requireAuthenticatedIdentity,
} from '../lib/sessionOrganization';
import { throwInvalidState } from '../_utils/errors';
import { listOpenRequests, resolveOpenRequest, upsertOpenRequest } from '../lib/adminRequests';

/**
 * Ask an admin for access to this instance. Self-authed via the identity floor
 * (the caller is signed in but not yet an org member, so the org-member floor
 * would reject them). Idempotent: reuses the caller's open request if one exists
 * and refuses if the caller already belongs to the org — there is nothing to ask
 * for. Crucially it never touches the member table, so it cannot self-grant
 * membership; it only records the ask for admins to see.
 */
// authz: self — signed-in identity, writes only the caller's own request row.
// Never grants org membership (no member-table write anywhere in this handler).
export const request = authedIdentityMutation({
	args: {
		note: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const identity = await requireAuthenticatedIdentity(ctx);

		// Already in the org? There is nothing to request. An orgless user's
		// session has no active org; a member's does, so this is the honest gate.
		const session = await getBetterAuthSession(ctx);
		if (session?.activeOrganizationId) {
			throwInvalidState('You already have access to this workspace');
		}

		const requestId = await upsertOpenRequest(ctx, 'accessRequests', {
			authUserId: identity.subject,
			// The one deployment org the request is addressed to. Resolved directly
			// (not via the session) because the caller has no active org.
			organizationId: await getSingletonOrganizationId(ctx),
			note: args.note,
			identityEmail: identity.email,
		});
		return { requested: true as const, requestId };
	},
});

/** Admin-only: the open access requests for this deployment's organization. */
// authz: admin — adminQuery gates the read on `organization:manage`.
export const listPending = adminQuery({
	args: {},
	handler: async (ctx, _args, session) =>
		listOpenRequests(ctx, 'accessRequests', session.activeOrganizationId),
});

/**
 * Admin-only: mark a request resolved (the admin has invited the person or
 * decided otherwise). Org-scoped — a request from another org is rejected — and
 * open-only, so a second admin's late click does not rewrite who resolved it.
 * Resolving is a plain acknowledgement; it does NOT invite the user (that stays
 * an explicit action in the members flow).
 */
// authz: admin — adminMutation gates the whole handler on `organization:manage`.
export const resolve = adminMutation({
	args: {
		requestId: v.id('accessRequests'),
	},
	handler: async (ctx, args, session) =>
		resolveOpenRequest(ctx, 'accessRequests', args.requestId, session),
});
