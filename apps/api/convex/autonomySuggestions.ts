/**
 * Previous-release paths of `autonomy/suggestions.ts`. The autonomy settings
 * page in a tab opened before the deploy still lists and accepts graduation
 * suggestions through `autonomySuggestions:*` by path. Each function keeps its
 * old path, builder, auth floor, arguments and result shape, and runs the same
 * body as its replacement. Remove after release 0.6.17.
 */
import { v } from 'convex/values';
import { internalMutation } from './lib/writeFence';
import { adminQuery, authedMutation } from './lib/authedFunctions';
import { hasPermission, requirePermission } from './lib/sessionOrganization';
import { assertFeatureEnabled } from './lib/featureFlags';
import {
	applyGraduationSuggestion,
	clearCategorySuggestion,
	graduationSuggestionValidator,
	readGraduationSuggestions,
	upsertGraduationSuggestion,
} from './autonomy/suggestions';

/** Remove after release 0.6.17; this release calls `autonomy/suggestions:listGraduationSuggestions`. */
export const listGraduationSuggestions = adminQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		return await readGraduationSuggestions(ctx);
	},
});

/**
 * A previous release's threshold cron records a suggestion here. Nothing in
 * this release calls it; remove after release 0.6.17.
 */
export const recordGraduationSuggestion = internalMutation({
	args: graduationSuggestionValidator.fields,
	returns: v.null(),
	handler: async (ctx, args) => {
		await upsertGraduationSuggestion(ctx, args);
		return null;
	},
});

/**
 * A previous release's threshold cron clears a suggestion here. Nothing in
 * this release calls it; remove after release 0.6.17.
 */
export const clearGraduationSuggestion = internalMutation({
	args: { category: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await clearCategorySuggestion(ctx, args.category);
		return null;
	},
});

/** Remove after release 0.6.17; this release calls `autonomy/suggestions:acceptGraduationSuggestion`. */
export const acceptGraduationSuggestion = authedMutation({
	args: { suggestionId: v.id('autonomySuggestions') },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can widen autonomy'
		);
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		await applyGraduationSuggestion(ctx, args.suggestionId);
	},
});
