/**
 * Campaign edit-access guards.
 *
 * The draft-only edit mutations (updateBasics / updateAudience / updateContent,
 * A/B enable + disable, schedule) all opened with the same five lines: load the
 * session, require `campaigns:manage`, load the campaign, 404 if missing, reject
 * if it isn't a draft. The wording of the "not a draft" message drifted between
 * copies. This guard owns that precondition so it has one home and one message.
 *
 * Auth lives here rather than in the lifecycle module (which owns
 * `campaigns.status` transitions and intentionally carries no session imports).
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import {
	getMutationContext,
	requirePermission,
	hasPermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { throwNotFound, throwInvalidState } from '../_utils/errors';

/**
 * Require that the caller may manage campaigns and that the target campaign
 * exists and is still a draft. Returns the resolved session and campaign so the
 * handler doesn't re-query either.
 *
 * @param action human phrase completing "Only owners and admins can …" in the
 *   403 message (e.g. `'edit campaigns'`, `'enable A/B testing'`).
 * @param notDraftMessage overrides the "not a draft" message for callers with a
 *   more specific phrasing (e.g. "A/B testing can only be enabled on draft
 *   campaigns").
 */
export async function requireDraftCampaign(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	action: string,
	notDraftMessage = 'Cannot modify a campaign that is not in draft status',
): Promise<{ session: MutationSessionContext; campaign: Doc<'campaigns'> }> {
	const session = await getMutationContext(ctx);
	requirePermission(
		hasPermission(session.role, 'campaigns:manage'),
		`Only owners and admins can ${action}`,
	);

	const campaign = await ctx.db.get(campaignId);
	if (!campaign) {
		throwNotFound('Campaign');
	}
	if (campaign.status !== 'draft') {
		throwInvalidState(notDraftMessage);
	}

	return { session, campaign };
}
