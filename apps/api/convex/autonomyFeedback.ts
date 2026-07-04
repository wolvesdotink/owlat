/**
 * Autonomy Feedback & Adaptation
 *
 * The learning loop behind graduated autonomy: it records approve/reject/edit
 * feedback on agent actions, reads it back for analysis and the circuit-breaker
 * rollup, and runs the weekly threshold-adjustment cron. Split out of
 * `autonomy.ts` (the rule-decision core) to keep each domain file under the
 * ~500-LOC ratchet; the two share the `autonomyRules` / `autonomyFeedback`
 * tables and the `lib/autonomyRules` helpers.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation, internalAction, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { adminQuery } from './lib/authedFunctions';
import { internal } from './_generated/api';
import { getCategoryRule } from './lib/autonomyRules';

// ============================================================
// Feedback readers
// ============================================================

/**
 * Read the most recent feedback rows for a category, newest first. The shared
 * reader behind the public `getRecentFeedback` (admin-gated) and the cron-only
 * `getRecentFeedbackInternal` (session-less) so the two can't drift.
 */
async function loadRecentFeedback(
	ctx: QueryCtx,
	category: string,
	limit?: number
): Promise<Doc<'autonomyFeedback'>[]> {
	return ctx.db
		.query('autonomyFeedback')
		.withIndex('by_category', (q) => q.eq('category', category))
		.order('desc')
		.take(limit ?? 50);
}

/**
 * Get recent feedback for a category (for analysis)
 */
export const getRecentFeedback = adminQuery({
	args: {
		category: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		return await loadRecentFeedback(ctx, args.category, args.limit);
	},
});

/** Internal variant for the scheduled threshold-adjustment cron (no session). */
export const getRecentFeedbackInternal = internalQuery({
	args: {
		category: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		return await loadRecentFeedback(ctx, args.category, args.limit);
	},
});

/**
 * Get feedback summary stats
 */
export const getFeedbackStats = adminQuery({
	args: { hoursBack: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const since = Date.now() - (args.hoursBack ?? 24) * 60 * 60 * 1000;

		const feedback = await ctx.db
			.query('autonomyFeedback')
			.withIndex('by_created_at', (q) => q.gte('createdAt', since))
			.collect();

		const stats: Record<string, { approved: number; rejected: number; edited: number }> = {};

		for (const fb of feedback) {
			if (!stats[fb.category]) {
				stats[fb.category] = { approved: 0, rejected: 0, edited: 0 };
			}
			stats[fb.category]![fb.action]++;
		}

		return stats;
	},
});

/**
 * Aggregate approve/reject/edit feedback counts since a timestamp. Session-less
 * — consumed by the agent-health rollup to evaluate the `rejection_spike`
 * circuit breaker. Bounded by the `by_created_at` index window.
 */
export const getFeedbackCountsInternal = internalQuery({
	args: { since: v.number() },
	handler: async (
		ctx,
		args
	): Promise<{ approved: number; rejected: number; edited: number; total: number }> => {
		const feedback = await ctx.db
			.query('autonomyFeedback')
			.withIndex('by_created_at', (q) => q.gte('createdAt', args.since))
			.take(1000);

		let approved = 0;
		let rejected = 0;
		let edited = 0;
		for (const fb of feedback) {
			if (fb.action === 'approved') approved++;
			else if (fb.action === 'rejected') rejected++;
			else if (fb.action === 'edited') edited++;
		}
		return { approved, rejected, edited, total: feedback.length };
	},
});

// ============================================================
// Feedback writer
// ============================================================

/**
 * Record human feedback on an agent action
 */
export const recordFeedback = internalMutation({
	args: {
		category: v.string(),
		action: v.union(v.literal('approved'), v.literal('rejected'), v.literal('edited')),
		agentConfidence: v.number(),
		userFeedback: v.optional(v.string()),
		inboundMessageId: v.optional(v.id('inboundMessages')),
		// Provenance. Defaults to 'human' (a reviewer decision) when omitted.
		source: v.optional(v.union(v.literal('human'), v.literal('outcome'))),
		outcomeSignal: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Attribute feedback to the CATEGORY rule (feedback is category-granular).
		const rule = await getCategoryRule(ctx.db, args.category);

		await ctx.db.insert('autonomyFeedback', {
			ruleId: rule?._id,
			category: args.category,
			action: args.action,
			agentConfidence: args.agentConfidence,
			userFeedback: args.userFeedback,
			inboundMessageId: args.inboundMessageId,
			source: args.source,
			outcomeSignal: args.outcomeSignal,
			createdAt: Date.now(),
		});
	},
});

// ============================================================
// Threshold Adjustment (called by weekly cron)
// ============================================================

/**
 * Weekly review of rejection patterns per category. Deliberately asymmetric:
 *
 *   - TIGHTENING is automatic. A rejection spike (>40% over the week) raises the
 *     auto-approve threshold by 10% right away — that fails toward the human and
 *     only ever makes auto-send harder, so it is always safe to do unattended.
 *   - LOOSENING is NEVER automatic. A low rejection rate does not lower the
 *     threshold; it records a "graduation suggestion" the user must explicitly
 *     accept (see `acceptGraduationSuggestion`). Autonomy only widens by the
 *     user's decision, never on its own.
 *
 * When a category tightens, any stale pending loosening suggestion for it is
 * cleared — a suggestion minted before a rejection spike must not linger.
 */
export const adjustThresholds = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const rules = await ctx.runQuery(internal.autonomy.listRulesInternal);
		const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

		for (const rule of rules) {
			if (!rule.isEnabled) continue;
			// Feedback is category-granular; only the category rule is auto-adjusted.
			// Per-sender rules graduate via warm-up + explicit toggle, not here.
			if (rule.sender != null) continue;

			// Get feedback for this category in the last week
			const feedback = await ctx.runQuery(internal.autonomyFeedback.getRecentFeedbackInternal, {
				category: rule.category,
				limit: 200,
			});

			const recentFeedback = feedback.filter((f) => f.createdAt > oneWeekAgo);
			if (recentFeedback.length < 5) continue; // Not enough data

			let rejections = 0;
			let approvals = 0;
			for (const f of recentFeedback) {
				if (f.action === 'rejected') rejections++;
				else if (f.action === 'approved') approvals++;
			}
			const rejectionRate = rejections / recentFeedback.length;

			if (rejectionRate > 0.4) {
				// Tighten threshold: increase by 10% (make it harder to auto-approve).
				// This is the only automatic threshold move, and it only ever narrows.
				const newThreshold = Math.min(0.99, rule.autoApproveThreshold + 0.1);
				await ctx.runMutation(internal.autonomyFeedback.updateThreshold, {
					ruleId: rule._id,
					newThreshold,
				});
				// A prior loosening suggestion is now stale — drop it.
				await ctx.runMutation(internal.autonomySuggestions.clearGraduationSuggestion, {
					category: rule.category,
				});
			} else if (rejectionRate < 0.1 && recentFeedback.length >= 20) {
				// Low rejection rate: do NOT lower the threshold. Record a
				// graduation suggestion the user must explicitly accept. The
				// suggested (looser) threshold is computed but only applied on
				// acceptance.
				const suggestedThreshold = Math.max(0.5, rule.autoApproveThreshold - 0.05);
				// Only bother suggesting if it actually loosens something.
				if (suggestedThreshold < rule.autoApproveThreshold) {
					await ctx.runMutation(internal.autonomySuggestions.recordGraduationSuggestion, {
						category: rule.category,
						currentThreshold: rule.autoApproveThreshold,
						suggestedThreshold,
						evidence: {
							approved: approvals,
							sampleSize: recentFeedback.length,
							rejectionRate,
						},
					});
				}
			}
		}
	},
});

/**
 * Update threshold for a rule (internal)
 */
export const updateThreshold = internalMutation({
	args: {
		ruleId: v.id('autonomyRules'),
		newThreshold: v.number(),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.ruleId, {
			autoApproveThreshold: args.newThreshold,
			updatedAt: Date.now(),
		});
	},
});
