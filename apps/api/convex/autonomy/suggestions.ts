/**
 * Graduation Suggestions (explicit-acceptance loosening)
 *
 * Autonomy only ever WIDENS by the user's deliberate action. The weekly cron
 * (`feedback.adjustThresholds`) may tighten a threshold automatically — that
 * fails toward the human — but when the evidence says a category could safely
 * loosen, it never touches the live threshold. Instead it records a graduation
 * suggestion here, which an owner/admin must explicitly accept.
 *
 * Each builder's body is an exported helper so the previous-release shims at
 * `convex/autonomySuggestions.ts` run the same code.
 */

import { v, type Infer } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { adminQuery, authedMutation } from '../lib/authedFunctions';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { getCategoryRule } from '../lib/autonomyRules';

/**
 * Admin-gated read of pending graduation suggestions for the autonomy settings
 * UI. Each row is a category where the agent has earned a looser threshold but
 * may only get it once an owner/admin accepts. Newest first.
 */
export const listGraduationSuggestions = adminQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		return await readGraduationSuggestions(ctx);
	},
});

/** Every pending graduation suggestion, newest first. */
export async function readGraduationSuggestions(
	ctx: QueryCtx
): Promise<Doc<'autonomySuggestions'>[]> {
	return await ctx.db.query('autonomySuggestions').order('desc').collect(); // bounded: at most one row per agent category
}

export const graduationSuggestionValidator = v.object({
	category: v.string(),
	currentThreshold: v.number(),
	suggestedThreshold: v.number(),
	evidence: v.object({
		approved: v.number(),
		sampleSize: v.number(),
		rejectionRate: v.number(),
	}),
});

/**
 * Record (or refresh) a pending graduation suggestion for a category. Upserts on
 * category so repeated weekly runs don't pile up duplicates — the latest
 * evidence replaces the previous suggestion. The weekly cron's commit is the
 * sole writer. Recording a suggestion NEVER changes the live threshold.
 */
export async function upsertGraduationSuggestion(
	ctx: MutationCtx,
	suggestion: Infer<typeof graduationSuggestionValidator>
): Promise<void> {
	const existing = await ctx.db
		.query('autonomySuggestions')
		.withIndex('by_category', (q) => q.eq('category', suggestion.category))
		.first();
	const row = { ...suggestion, createdAt: Date.now() };
	if (existing) {
		await ctx.db.patch(existing._id, row);
		return;
	}
	await ctx.db.insert('autonomySuggestions', row);
}

/**
 * Clear any pending graduation suggestion for a category. Used when the cron
 * tightens a category: a stale loosening suggestion must not survive a
 * rejection spike.
 */
export async function clearCategorySuggestion(ctx: MutationCtx, category: string): Promise<void> {
	const existing = await ctx.db
		.query('autonomySuggestions')
		.withIndex('by_category', (q) => q.eq('category', category))
		.first();
	if (existing) await ctx.db.delete(existing._id);
}

/**
 * Explicitly accept a graduation suggestion: apply its suggested (looser)
 * threshold to the category's rule and clear the suggestion. This is the ONLY
 * path that lowers an auto-approve threshold — autonomy never widens without a
 * user's deliberate action. Owner/admin only.
 */
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

/** Apply a suggestion's threshold to its category rule and delete the suggestion. */
export async function applyGraduationSuggestion(
	ctx: MutationCtx,
	suggestionId: Id<'autonomySuggestions'>
): Promise<void> {
	const suggestion = await ctx.db.get(suggestionId);
	if (!suggestion) return; // already accepted/cleared — idempotent no-op

	// The CATEGORY rule (sender absent) — a graduation suggestion loosens the
	// category threshold, never a per-sender rule.
	const rule = await getCategoryRule(ctx.db, suggestion.category);

	if (rule) {
		await ctx.db.patch(rule._id, {
			autoApproveThreshold: suggestion.suggestedThreshold,
			updatedAt: Date.now(),
		});
	}

	// Clear the suggestion whether or not a rule still exists.
	await ctx.db.delete(suggestionId);
}
