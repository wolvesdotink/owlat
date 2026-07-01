/**
 * Automation edit-access guards — the automations twin of campaigns/guards.ts.
 *
 * Every automation mutation opened with the same lines: load the session,
 * require `automations:manage`, (for edit-style mutations) load the
 * automation, reject if missing, sometimes reject non-drafts. The copies had
 * already drifted: "Automation not found" was thrown as invalid_state instead
 * of not_found. These guards own the precondition so it has one home, one
 * message, and one error category.
 *
 * Call sites carry an `// authz: …` comment so check-permissions.sh can see
 * the gate lives here.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import {
	requireOrgPermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { throwNotFound, throwInvalidState } from '../_utils/errors';

/**
 * Require that the caller may manage automations. Lifecycle-style mutations
 * (activate/pause/resume/revert) need only this — the typed lifecycle module
 * owns the status rules.
 *
 * @param action human phrase completing "Only owners and admins can …".
 */
export async function requireAutomationManage(
	ctx: MutationCtx,
	action: string,
): Promise<MutationSessionContext> {
	return await requireOrgPermission(ctx, 'automations:manage', `Only owners and admins can ${action}`);
}

/**
 * Require manage permission AND that the target automation exists. Returns
 * both so the handler doesn't re-query either.
 */
export async function requireAutomation(
	ctx: MutationCtx,
	automationId: Id<'automations'>,
	action: string,
): Promise<{ session: MutationSessionContext; automation: Doc<'automations'> }> {
	const session = await requireAutomationManage(ctx, action);
	const automation = await ctx.db.get(automationId);
	if (!automation) {
		throwNotFound('Automation');
	}
	return { session, automation };
}

/**
 * Like {@link requireAutomation}, but additionally rejects automations that
 * are no longer drafts (structure edits are draft-only).
 */
export async function requireDraftAutomation(
	ctx: MutationCtx,
	automationId: Id<'automations'>,
	action: string,
	notDraftMessage: string,
): Promise<{ session: MutationSessionContext; automation: Doc<'automations'> }> {
	const result = await requireAutomation(ctx, automationId, action);
	if (result.automation.status !== 'draft') {
		throwInvalidState(notDraftMessage);
	}
	return result;
}
