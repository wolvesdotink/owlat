/**
 * Previous-release paths of `autonomy/outcome.ts`. The autonomy settings page in
 * a tab opened before the deploy still lists and acknowledges auto-demotions
 * through `autonomyOutcome:*` by path, a previous release's outcome
 * classification still running when this one deploys calls these internal
 * functions by their old paths, and so does an outcome record the previous
 * release's bounce or complaint handling queued. Each function keeps its old
 * path, builder, auth floor, arguments and result shape, and runs the same body
 * as its replacement. Remove after release 0.6.17.
 */
import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { adminQuery, authedMutation } from './lib/authedFunctions';
import { hasPermission, requirePermission } from './lib/sessionOrganization';
import { assertFeatureEnabled } from './lib/featureFlags';
import { internal } from './_generated/api';
import {
	markDemotionAcknowledged,
	type ReplyOutcomeContext,
	outcomeSignalValidator,
	readAutoDemotions,
	recordOutcome,
} from './autonomy/outcome';

/** Remove after release 0.6.17; this release calls `autonomy/outcome:recordOutcomeFeedback`. */
export const recordOutcomeFeedback = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		signal: outcomeSignalValidator,
	},
	handler: async (ctx, args) => await recordOutcome(ctx, args),
});

/** Remove after release 0.6.17; this release calls `autonomy/outcome:listAutoDemotions`. */
export const listAutoDemotions = adminQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		return await readAutoDemotions(ctx);
	},
});

/** Remove after release 0.6.17; this release calls `autonomy/outcome:acknowledgeAutoDemotion`. */
export const acknowledgeAutoDemotion = authedMutation({
	args: { ruleId: v.id('autonomyRules') },
	returns: v.null(),
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can manage autonomy'
		);
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		return await markDemotionAcknowledged(ctx, args.ruleId, session.userId);
	},
});

/** Remove after release 0.6.17; this release calls `autonomy/outcome:getReplyOutcomeContext`. */
export const getReplyOutcomeContext = internalQuery({
	args: { replyMessageId: v.id('inboundMessages') },
	// The read touches the shared-inbox tables, so it stays inside the internal
	// query at the new path rather than in a helper a public function could call.
	handler: async (ctx, args): Promise<ReplyOutcomeContext | null> =>
		await ctx.runQuery(internal.autonomy.outcome.getReplyOutcomeContext, args),
});
