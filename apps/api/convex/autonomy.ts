/**
 * Graduated Autonomy
 *
 * Per-category autonomy rules that control when the agent
 * can auto-approve vs. when human review is required.
 * Includes feedback tracking and automatic threshold adjustment
 * based on rejection patterns.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { adminQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { assertFeatureEnabled, isFeatureEnabled } from './lib/featureFlags';
import { extractEmail } from './lib/emailAddress';
import {
	WARMUP_MATCHES_DEFAULT,
	getCategoryRule,
	getScorecardSlice,
	getSenderRule,
	resolveEffectiveRule,
} from './lib/autonomyRules';

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
 *   - `{ mode: 'enabled', allowed }`    → a rule governs. The PER-SENDER rule is
 *                                          consulted first, then the per-category
 *                                          rule. `allowed` reflects threshold +
 *                                          the first-N-observed warm-up + daily
 *                                          cap + open circuit breakers. No rule
 *                                          (or a disabled one) means
 *                                          `allowed: false` — never auto-approved.
 *
 * Per-sender / warm-up granularity engages only when the caller passes
 * `inboundMessageId` (the live route step always does); the sender is resolved
 * from that message so it normalizes identically to the shadow scorecard. A
 * brand-new sender with no scorecard row — or a sender still short of its warm-up
 * count of matched shadow observations — is held for human review. Legacy callers
 * that pass only `{ category, confidence }` keep the pure per-category behaviour.
 *
 * Mirrors `checkPermission` but is session-less and flag-aware.
 */
export const checkPermissionInternal = internalQuery({
	args: {
		category: v.string(),
		confidence: v.number(),
		// The message being routed. When present the sender is resolved from it
		// and the per-sender rule + first-N-observed warm-up apply; when absent the
		// pure per-category path is used (back-compat).
		inboundMessageId: v.optional(v.id('inboundMessages')),
	},
	handler: async (
		ctx,
		args
	): Promise<{ mode: 'disabled' } | { mode: 'enabled'; allowed: boolean; reason?: string }> => {
		const enabled = await isFeatureEnabled(ctx, 'ai.autonomy');
		if (!enabled) return { mode: 'disabled' };

		// Resolve the sender from the message so it matches the scorecard's
		// normalization exactly. `null` when the caller passed no message (legacy).
		let sender: string | null = null;
		if (args.inboundMessageId) {
			const message = await ctx.db.get(args.inboundMessageId);
			sender = message ? extractEmail(message.from ?? '') || 'unknown' : 'unknown';
		}

		const effective = await resolveEffectiveRule(ctx.db, args.category, sender);
		if (effective.kind === 'blocked') {
			return { mode: 'enabled', allowed: false, reason: effective.reason };
		}
		if (effective.kind === 'none') {
			return {
				mode: 'enabled',
				allowed: false,
				reason: 'No autonomy rule configured for this category',
			};
		}
		const { rule, scope } = effective;

		if (args.confidence < rule.autoApproveThreshold) {
			return {
				mode: 'enabled',
				allowed: false,
				reason: `Confidence ${args.confidence.toFixed(2)} below ${scope} threshold ${rule.autoApproveThreshold}`,
			};
		}

		// First-N-observed warm-up + first-contact hard-exclusion. Only engages
		// when the sender is known (the live route step always passes the message).
		// A sender never observed in shadow (no scorecard row) is a first contact
		// and is never auto-sent; a sender still short of its matched-observation
		// warm-up count is held until it graduates.
		if (sender !== null) {
			if (sender === 'unknown') {
				return {
					mode: 'enabled',
					allowed: false,
					reason:
						'Sender could not be identified — held for human review (first-contact safeguard)',
				};
			}
			const warmupRequired = rule.warmupRequired ?? WARMUP_MATCHES_DEFAULT;
			const slice = await getScorecardSlice(ctx.db, args.category, sender);
			if (!slice) {
				return {
					mode: 'enabled',
					allowed: false,
					reason: `First contact with ${sender} — a new sender is never auto-sent until it warms up`,
				};
			}
			if (slice.matched < warmupRequired) {
				return {
					mode: 'enabled',
					allowed: false,
					reason: `Warm-up: ${slice.matched}/${warmupRequired} matched shadow observations for ${sender}`,
				};
			}
		}

		const now = Date.now();
		const oneDayAgo = now - 24 * 60 * 60 * 1000;
		const currentCount =
			rule.dailyCountResetAt && rule.dailyCountResetAt > oneDayAgo
				? (rule.currentDailyCount ?? 0)
				: 0;
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

		return {
			mode: 'enabled',
			allowed: true,
			reason: `Per-${scope} rule for ${args.category} permits auto-approval`,
		};
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
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can change autonomy rules'
		);
		const now = Date.now();
		// The CATEGORY rule only (sender absent) — never a per-sender row.
		const existing = await getCategoryRule(ctx.db, args.category);

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
 * Per-contact "Auto-send replies to this sender" toggle.
 *
 * Creates or updates a PER-SENDER autonomy rule for one (category, sender). The
 * per-sender rule overrides the category rule for that exact sender: enabling it
 * lets the sender graduate on its own warm-up + threshold; DISABLING it is an
 * explicit "never auto-send this sender" opt-out that overrides an otherwise
 * permissive category rule. Threshold / cap / warm-up default from the category
 * rule when the caller omits them, so a toggle can be a single boolean.
 *
 * Safety is unchanged: enabling a sender rule does NOT bypass the warm-up or the
 * outbound safety gate — a newly-enabled sender still needs its matched shadow
 * observations before anything auto-sends. Owner/admin only.
 */
export const setSenderAutonomy = authedMutation({
	args: {
		category: v.string(),
		sender: v.string(),
		isEnabled: v.boolean(),
		autoApproveThreshold: v.optional(v.number()),
		maxDailyAutoActions: v.optional(v.number()),
		warmupRequired: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<Id<'autonomyRules'>> => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can change autonomy rules'
		);
		const sender = extractEmail(args.sender) || args.sender;
		const now = Date.now();

		const existing = await getSenderRule(ctx.db, args.category, sender);
		const categoryRule = await getCategoryRule(ctx.db, args.category);
		const threshold =
			args.autoApproveThreshold ??
			existing?.autoApproveThreshold ??
			categoryRule?.autoApproveThreshold ??
			0.9;
		const cap =
			args.maxDailyAutoActions ??
			existing?.maxDailyAutoActions ??
			categoryRule?.maxDailyAutoActions ??
			10;

		if (existing) {
			await ctx.db.patch(existing._id, {
				isEnabled: args.isEnabled,
				autoApproveThreshold: threshold,
				maxDailyAutoActions: cap,
				warmupRequired: args.warmupRequired ?? existing.warmupRequired,
				updatedAt: now,
			});
			return existing._id;
		}

		return await ctx.db.insert('autonomyRules', {
			category: args.category,
			sender,
			autoApproveThreshold: threshold,
			maxDailyAutoActions: cap,
			warmupRequired: args.warmupRequired,
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
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can delete autonomy rules'
		);
		await ctx.db.delete(args.ruleId);
	},
});

// ============================================================
// Internal Mutations
// ============================================================

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
 * Charges the SAME effective rule the decision was made against: the per-sender
 * rule when one governs this message's sender, otherwise the category rule. The
 * sender is resolved from `inboundMessageId` (the live route step passes it) so
 * per-sender caps are charged to the per-sender row; legacy callers that pass
 * only `{ category }` charge the category rule.
 *
 * Returns `{ allowed: false }` when there is no rule (never auto-approved), the
 * sender is explicitly opted out, or the cap is reached; `{ allowed: true }`
 * once the charge has been recorded.
 */
export const incrementDailyCount = internalMutation({
	args: {
		category: v.string(),
		inboundMessageId: v.optional(v.id('inboundMessages')),
	},
	handler: async (ctx, args): Promise<{ allowed: boolean; reason?: string }> => {
		let sender: string | null = null;
		if (args.inboundMessageId) {
			const message = await ctx.db.get(args.inboundMessageId);
			sender = message ? extractEmail(message.from ?? '') || 'unknown' : 'unknown';
		}

		const effective = await resolveEffectiveRule(ctx.db, args.category, sender);
		if (effective.kind === 'blocked') return { allowed: false, reason: effective.reason };
		if (effective.kind === 'none') {
			return { allowed: false, reason: 'No autonomy rule configured for this category' };
		}
		const rule = effective.rule;

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
