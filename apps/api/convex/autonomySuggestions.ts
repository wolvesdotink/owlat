/**
 * Graduation Suggestions (explicit-acceptance loosening)
 *
 * Autonomy only ever WIDENS by the user's deliberate action. The weekly cron
 * (`autonomy.adjustThresholds`) may tighten a threshold automatically — that
 * fails toward the human — but when the evidence says a category could safely
 * loosen, it never touches the live threshold. Instead it records a graduation
 * suggestion here, which an owner/admin must explicitly accept.
 *
 * Split out of `autonomy.ts` to keep that file under the ~500 LOC ratchet
 * (CONVENTIONS.md).
 */

import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { adminQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { assertFeatureEnabled } from './lib/featureFlags';
import { getCategoryRule } from './lib/autonomyRules';

/**
 * Admin-gated read of pending graduation suggestions for the autonomy settings
 * UI. Each row is a category where the agent has earned a looser threshold but
 * may only get it once an owner/admin accepts. Newest first.
 */
export const listGraduationSuggestions = adminQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		return await ctx.db.query('autonomySuggestions').order('desc').collect(); // bounded: at most one row per agent category
	},
});

/**
 * Record (or refresh) a pending graduation suggestion for a category. Upserts on
 * category so repeated weekly runs don't pile up duplicates — the latest
 * evidence replaces the previous suggestion. Internal-only: the weekly cron is
 * the sole writer. Recording a suggestion NEVER changes the live threshold.
 */
export const recordGraduationSuggestion = internalMutation({
	args: {
		category: v.string(),
		currentThreshold: v.number(),
		suggestedThreshold: v.number(),
		evidence: v.object({
			approved: v.number(),
			sampleSize: v.number(),
			rejectionRate: v.number(),
		}),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('autonomySuggestions')
			.withIndex('by_category', (q) => q.eq('category', args.category))
			.first();

		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, {
				currentThreshold: args.currentThreshold,
				suggestedThreshold: args.suggestedThreshold,
				evidence: args.evidence,
				createdAt: now,
			});
			return null;
		}

		await ctx.db.insert('autonomySuggestions', {
			category: args.category,
			currentThreshold: args.currentThreshold,
			suggestedThreshold: args.suggestedThreshold,
			evidence: args.evidence,
			createdAt: now,
		});
		return null;
	},
});

/**
 * Clear any pending graduation suggestion for a category. Used when the cron
 * tightens a category (a stale loosening suggestion must not survive a rejection
 * spike). Internal-only.
 */
export const clearGraduationSuggestion = internalMutation({
	args: { category: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('autonomySuggestions')
			.withIndex('by_category', (q) => q.eq('category', args.category))
			.first();
		if (existing) await ctx.db.delete(existing._id);
		return null;
	},
});

/**
 * Explicitly accept a graduation suggestion: apply its suggested (looser)
 * threshold to the category's rule and clear the suggestion. This is the ONLY
 * path that lowers an auto-approve threshold — autonomy never widens without a
 * user's deliberate action. Owner/admin only.
 */
export const acceptGraduationSuggestion = authedMutation({
	args: { suggestionId: v.id('autonomySuggestions') },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can widen autonomy'
		);
		await assertFeatureEnabled(ctx, 'ai.autonomy');

		const suggestion = await ctx.db.get(args.suggestionId);
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
		await ctx.db.delete(args.suggestionId);
	},
});
