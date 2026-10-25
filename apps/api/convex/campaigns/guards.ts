/**
 * Campaign edit-access guards.
 *
 * The draft-only edit mutations (updateBasics / updateAudience / updateContent,
 * A/B enable + disable) all open with the same checks: require
 * `campaigns:manage` on the session the builder's floor resolved, load the
 * campaign, 404 if missing, reject if it isn't a draft. This guard owns that
 * precondition so it has one home and one message.
 *
 * Auth lives here rather than in the lifecycle module (which owns
 * `campaigns.status` transitions and intentionally carries no session imports).
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import {
	hasPermission,
	requirePermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { throwInvalidState } from '../_utils/errors';
import { getLiveOrThrow } from '../lib/softDelete';

/**
 * Require that the caller may manage campaigns and that the target campaign
 * exists and is still a draft. Returns the campaign so the handler doesn't
 * re-query it.
 *
 * @param action human phrase completing "You do not have permission to …" in
 *   the 403 message (e.g. `'edit campaigns'`, `'enable A/B testing'`).
 * @param notDraftMessage overrides the "not a draft" message for callers with a
 *   more specific phrasing (e.g. "A/B testing can only be enabled on draft
 *   campaigns").
 */
export async function requireDraftCampaign(
	ctx: MutationCtx,
	session: MutationSessionContext,
	campaignId: Id<'campaigns'>,
	action: string,
	notDraftMessage = 'Cannot modify a campaign that is not in draft status'
): Promise<Doc<'campaigns'>> {
	requirePermission(
		hasPermission(session.role, 'campaigns:manage'),
		`You do not have permission to ${action}`
	);

	// A campaign in Recently deleted reads as missing: a stale tab cannot edit it.
	const campaign = await getLiveOrThrow(ctx, campaignId, 'Campaign');
	if (campaign.status !== 'draft') {
		throwInvalidState(notDraftMessage);
	}

	return campaign;
}
