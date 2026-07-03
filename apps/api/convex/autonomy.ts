/**
 * Graduated Autonomy
 *
 * Per-category autonomy rules that control when the agent
 * can auto-approve vs. when human review is required.
 * Includes feedback tracking and automatic threshold adjustment
 * based on rejection patterns.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation, internalAction, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { adminQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { internal } from './_generated/api';
import { assertFeatureEnabled, isFeatureEnabled } from './lib/featureFlags';


// ============================================================
// Queries
// ============================================================

/**
 * Get all autonomy rules
 */
export const listRules = adminQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		return await ctx.db.query('autonomyRules').collect();
	},
});

/** Internal variant for the scheduled threshold-adjustment cron (no session). */
export const listRulesInternal = internalQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query('autonomyRules').collect(); // bounded: one row per agent category (intrinsically tiny)
	},
});

/**
 * Internal autonomy decision for the live `route` step (which runs inside an
 * action and can't call the authed `checkPermission`). Folds the `ai.autonomy`
 * feature-flag gate into the result so the route step needs a single call:
 *
 *   - `{ mode: 'disabled' }`            → autonomy off, route uses the global
 *                                          `agentConfig` threshold (legacy path).
 *   - `{ mode: 'enabled', allowed }`    → per-category rule governs. `allowed`
 *                                          reflects threshold + daily cap + open
 *                                          circuit breakers. No rule (or a
 *                                          disabled one) for the category means
 *                                          `allowed: false` — a category without
 *                                          a rule is never auto-approved.
 *
 * Mirrors `checkPermission` but is session-less and flag-aware.
 */
export const checkPermissionInternal = internalQuery({
	args: {
		category: v.string(),
		confidence: v.number(),
	},
	handler: async (
		ctx,
		args,
	): Promise<
		| { mode: 'disabled' }
		| { mode: 'enabled'; allowed: boolean; reason?: string }
	> => {
		const enabled = await isFeatureEnabled(ctx, 'ai.autonomy');
		if (!enabled) return { mode: 'disabled' };

		const rule = await ctx.db
			.query('autonomyRules')
			.withIndex('by_category', (q) => q.eq('category', args.category))
			.first();

		if (!rule || !rule.isEnabled) {
			return { mode: 'enabled', allowed: false, reason: 'No autonomy rule configured for this category' };
		}

		if (args.confidence < rule.autoApproveThreshold) {
			return {
				mode: 'enabled',
				allowed: false,
				reason: `Confidence ${args.confidence.toFixed(2)} below category threshold ${rule.autoApproveThreshold}`,
			};
		}

		const now = Date.now();
		const oneDayAgo = now - 24 * 60 * 60 * 1000;
		const currentCount =
			rule.dailyCountResetAt && rule.dailyCountResetAt > oneDayAgo ? (rule.currentDailyCount ?? 0) : 0;
		if (currentCount >= rule.maxDailyAutoActions) {
			return {
				mode: 'enabled',
				allowed: false,
				reason: `Daily auto-action limit (${rule.maxDailyAutoActions}) reached for ${args.category}`,
			};
		}

		const breakers = await ctx.db.query('agentCircuitBreakers').collect();
		const openBreaker = breakers.find((b) => b.state === 'open');
		if (openBreaker) {
			return {
				mode: 'enabled',
				allowed: false,
				reason: `Circuit breaker ${openBreaker.breakerType} is open`,
			};
		}

		return { mode: 'enabled', allowed: true, reason: `Per-category rule for ${args.category} permits auto-approval` };
	},
});

/**
 * Read the most recent feedback rows for a category, newest first. The shared
 * reader behind the public `getRecentFeedback` (admin-gated) and the cron-only
 * `getRecentFeedbackInternal` (session-less) so the two can't drift.
 */
async function loadRecentFeedback(
	ctx: QueryCtx,
	category: string,
	limit?: number,
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
	handler: async (ctx, args): Promise<{ approved: number; rejected: number; edited: number; total: number }> => {
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
// Mutations (User-facing)
// ============================================================

/**
 * Create or update an autonomy rule
 */
export const upsertRule = authedMutation({
	args: {
		category: v.string(),
		autoApproveThreshold: v.number(),
		maxDailyAutoActions: v.number(),
		isEnabled: v.boolean(),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can change autonomy rules');
		const now = Date.now();
		const existing = await ctx.db
			.query('autonomyRules')
			.withIndex('by_category', (q) => q.eq('category', args.category))
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, {
				autoApproveThreshold: args.autoApproveThreshold,
				maxDailyAutoActions: args.maxDailyAutoActions,
				isEnabled: args.isEnabled,
				updatedAt: now,
			});
			return existing._id;
		}

		return await ctx.db.insert('autonomyRules', {
			category: args.category,
			autoApproveThreshold: args.autoApproveThreshold,
			maxDailyAutoActions: args.maxDailyAutoActions,
			isEnabled: args.isEnabled,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Delete an autonomy rule
 */
export const deleteRule = authedMutation({
	args: { ruleId: v.id('autonomyRules') },
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can delete autonomy rules');
		await ctx.db.delete(args.ruleId);
	},
});

// ============================================================
// Internal Mutations
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
		// Find the rule for this category
		const rule = await ctx.db
			.query('autonomyRules')
			.withIndex('by_category', (q) => q.eq('category', args.category))
			.first();

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

/**
 * Atomically check the per-category daily cap and charge it in one
 * read-modify-write. Returns whether the action is allowed (cap not yet
 * reached) — and only increments the count when it is. This is the *authority*
 * for the daily cap: a prior read-only `checkPermissionInternal` is advisory,
 * because two concurrent route steps could both observe `count < max` and then
 * both increment, blowing past the cap. Folding the check and the increment
 * into a single serialized mutation closes that race; the caller routes on this
 * single result. The rolling-24h reset logic is preserved.
 *
 * Returns `{ allowed: false }` when there is no rule for the category (a
 * category without a rule is never auto-approved) or the cap is reached;
 * `{ allowed: true }` once the charge has been recorded.
 */
export const incrementDailyCount = internalMutation({
	args: { category: v.string() },
	handler: async (ctx, args): Promise<{ allowed: boolean; reason?: string }> => {
		const rule = await ctx.db
			.query('autonomyRules')
			.withIndex('by_category', (q) => q.eq('category', args.category))
			.first();

		if (!rule) return { allowed: false, reason: 'No autonomy rule configured for this category' };

		const now = Date.now();
		const oneDayAgo = now - 24 * 60 * 60 * 1000;

		// Reset count if the rolling 24h window has elapsed.
		const isWindowLive = rule.dailyCountResetAt != null && rule.dailyCountResetAt > oneDayAgo;
		const currentCount = isWindowLive ? (rule.currentDailyCount ?? 0) : 0;

		// Cap check and charge happen in the same mutation transaction, so a
		// concurrent route step can't slip a second charge in between.
		if (currentCount >= rule.maxDailyAutoActions) {
			return {
				allowed: false,
				reason: `Daily auto-action limit (${rule.maxDailyAutoActions}) reached for ${args.category}`,
			};
		}

		await ctx.db.patch(rule._id, {
			currentDailyCount: currentCount + 1,
			dailyCountResetAt: isWindowLive ? rule.dailyCountResetAt : now,
		});

		return { allowed: true };
	},
});

/**
 * Reset daily counts for all rules (called by daily cron)
 */
export const resetDailyCounts = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const rules = await ctx.db.query('autonomyRules').collect();
		const now = Date.now();

		for (const rule of rules) {
			await ctx.db.patch(rule._id, {
				currentDailyCount: 0,
				dailyCountResetAt: now,
			});
		}
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

			// Get feedback for this category in the last week
			const feedback = await ctx.runQuery(internal.autonomy.getRecentFeedbackInternal, {
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

			if (rejectionRate > 0.40) {
				// Tighten threshold: increase by 10% (make it harder to auto-approve).
				// This is the only automatic threshold move, and it only ever narrows.
				const newThreshold = Math.min(0.99, rule.autoApproveThreshold + 0.10);
				await ctx.runMutation(internal.autonomy.updateThreshold, {
					ruleId: rule._id,
					newThreshold,
				});
				// A prior loosening suggestion is now stale — drop it.
				await ctx.runMutation(internal.autonomySuggestions.clearGraduationSuggestion, {
					category: rule.category,
				});
			} else if (rejectionRate < 0.10 && recentFeedback.length >= 20) {
				// Low rejection rate: do NOT lower the threshold. Record a
				// graduation suggestion the user must explicitly accept. The
				// suggested (looser) threshold is computed but only applied on
				// acceptance.
				const suggestedThreshold = Math.max(0.50, rule.autoApproveThreshold - 0.05);
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
