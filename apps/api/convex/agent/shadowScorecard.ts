/**
 * Shadow ("would-have-sent") mode + graduation scorecard.
 *
 * Shadow mode lets the autonomous agent run its FULL auto-send decision without
 * ever sending. When it is on (the DEFAULT posture — see `getShadowMode` — until
 * a slice has earned real auto-send), the `route` step:
 *
 *   1. computes the auto-send decision EXACTLY as normal, then
 *   2. logs a "would-have-sent" observation here instead of sending, and
 *   3. routes the message to human review anyway.
 *
 * When the human later acts on that message (approve / reject / edit), the
 * decision is RECONCILED here: the shadowed draft is compared against what the
 * human actually approved (a simple similarity check), and a running
 * per-(category, sender) scorecard is updated. A slice whose would-have-sent
 * decisions consistently matched the human's unedited approval clears the
 * graduation thresholds and surfaces an OFFER to enable real auto-send — which
 * still requires the user's explicit acceptance (autonomySuggestions).
 *
 * FAIL-SOFT throughout: shadow logging is best-effort; every callable here is
 * safe to fail without wedging the walker, blocking ingest, or ever causing a
 * send. Shadow mode NEVER auto-sends — that is its entire safety guarantee.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation, type MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { adminQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { extractEmail } from '../lib/emailAddress';
import { draftSimilarity } from './shadowSimilarity';

/**
 * A shadowed auto-approve counts as "matched" only when the human approved the
 * SAME draft essentially unedited — i.e. the human agreed the agent's draft was
 * send-ready. High bar on purpose: graduation must be earned by drafts the human
 * would have shipped as-is.
 */
export const MATCH_SIMILARITY_THRESHOLD = 0.95;

/** Minimum would-have-sent observations before a slice can be offered graduation. */
export const GRADUATION_MIN_SAMPLE = 10;

/** Minimum matched / would-have-sent rate for a graduation offer. */
export const GRADUATION_MATCH_RATE = 0.9;

// ============================================================
// Shadow-mode gate
// ============================================================

/**
 * Whether shadow mode is active. Shadow is the DEFAULT: an instance with no
 * `agentConfig` row, or one that never set `isShadowMode`, observes rather than
 * sends. Only an explicit `isShadowMode: false` lets real auto-send proceed.
 */
export const getShadowMode = internalQuery({
	args: {},
	handler: async (ctx): Promise<{ enabled: boolean }> => {
		const cfg = await ctx.db.query('agentConfig').first();
		return { enabled: cfg?.isShadowMode ?? true };
	},
});

// ============================================================
// Recording observations
// ============================================================

/**
 * Record (or refresh) the shadow observation for a message at route time.
 *
 * Upserts on the message so a walker re-run replaces the prior observation
 * rather than duplicating it. Reads the sender + draft snapshot from the message
 * itself so the `route` step needs only pass the decision. Best-effort: reasons
 * to bail (missing message) return silently — shadow logging never blocks the
 * pipeline.
 */
export const recordShadowDecision = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		category: v.string(),
		wouldHaveSent: v.boolean(),
		reason: v.string(),
		confidence: v.number(),
		draftQualityScore: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return null;

		const sender = extractEmail(message.from ?? '') || 'unknown';
		const shadowDraft = message.draftResponse ?? '';
		const now = Date.now();

		const existing = await ctx.db
			.query('agentShadowDecisions')
			.withIndex('by_message', (q) => q.eq('inboundMessageId', args.inboundMessageId))
			.first();

		if (existing) {
			// Only refresh an as-yet unreconciled observation; never rewrite one
			// the human has already been scored against.
			if (!existing.isResolved) {
				await ctx.db.patch(existing._id, {
					category: args.category,
					sender,
					isWouldHaveSent: args.wouldHaveSent,
					reason: args.reason,
					confidence: args.confidence,
					draftQualityScore: args.draftQualityScore,
					shadowDraft,
					createdAt: now,
				});
			}
			return null;
		}

		await ctx.db.insert('agentShadowDecisions', {
			inboundMessageId: args.inboundMessageId,
			category: args.category,
			sender,
			isWouldHaveSent: args.wouldHaveSent,
			reason: args.reason,
			confidence: args.confidence,
			draftQualityScore: args.draftQualityScore,
			shadowDraft,
			isResolved: false,
			createdAt: now,
		});
		return null;
	},
});

// ============================================================
// Reconciliation (human acted on the review queue)
// ============================================================

/**
 * Reconcile the pending shadow observation for a message against the human's
 * verification-queue action, and fold the result into the running scorecard.
 *
 * A shadowed auto-approve is "matched" when the human APPROVED the draft
 * essentially unedited (similarity ≥ {@link MATCH_SIMILARITY_THRESHOLD}); an
 * edit or a rejection is a mismatch — the agent's would-have-sent draft was not
 * what the human shipped. Idempotent: an already-resolved observation is left
 * alone. Best-effort — invoked alongside the autonomy-feedback write and safe to
 * fail without affecting the human action.
 */
export const reconcileShadowDecision = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		action: v.union(v.literal('approved'), v.literal('rejected'), v.literal('edited')),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const observation = await ctx.db
			.query('agentShadowDecisions')
			.withIndex('by_message', (q) => q.eq('inboundMessageId', args.inboundMessageId))
			.first();
		if (!observation || observation.isResolved) return null;

		// The current draft on the message is what the human approved/edited.
		const message = await ctx.db.get(args.inboundMessageId);
		const finalDraft = message?.draftResponse ?? '';
		const similarity = draftSimilarity(observation.shadowDraft, finalDraft);

		// Matched only when the agent would have sent AND the human approved the
		// same draft essentially unedited. An explicit edit is never a match even
		// if the text stayed close — the human still felt the need to touch it.
		const matched =
			observation.isWouldHaveSent &&
			args.action === 'approved' &&
			similarity >= MATCH_SIMILARITY_THRESHOLD;

		await ctx.db.patch(observation._id, {
			isResolved: true,
			userAction: args.action,
			isMatched: matched,
			similarity,
			resolvedAt: Date.now(),
		});

		await bumpScorecard(ctx, {
			category: observation.category,
			sender: observation.sender,
			wouldHaveSent: observation.isWouldHaveSent,
			matched,
		});
		return null;
	},
});

/** Update the running per-(category, sender) scorecard for one reconciled observation. */
async function bumpScorecard(
	ctx: MutationCtx,
	args: { category: string; sender: string; wouldHaveSent: boolean; matched: boolean },
): Promise<void> {
	const now = Date.now();
	const existing = await ctx.db
		.query('agentShadowScorecard')
		.withIndex('by_category_sender', (q) =>
			q.eq('category', args.category).eq('sender', args.sender),
		)
		.first();

	if (existing) {
		await ctx.db.patch(existing._id, {
			samples: existing.samples + 1,
			wouldHaveSent: existing.wouldHaveSent + (args.wouldHaveSent ? 1 : 0),
			matched: existing.matched + (args.matched ? 1 : 0),
			lastActivityAt: now,
		});
		return;
	}

	await ctx.db.insert('agentShadowScorecard', {
		category: args.category,
		sender: args.sender,
		samples: 1,
		wouldHaveSent: args.wouldHaveSent ? 1 : 0,
		matched: args.matched ? 1 : 0,
		lastActivityAt: now,
	});
}

// ============================================================
// Reading the scorecard (graduation offers for the autonomy UI)
// ============================================================

export type ShadowScorecardSlice = {
	category: string;
	sender: string;
	samples: number;
	wouldHaveSent: number;
	matched: number;
	matchRate: number; // matched / wouldHaveSent (0 when no would-have-sent yet)
	offerGraduation: boolean;
	lastActivityAt: number;
};

/**
 * Derive a slice's match rate + whether it clears the graduation thresholds.
 * Shared so the read query and any future consumer agree on the bar.
 */
export function summarizeSlice(row: Doc<'agentShadowScorecard'>): ShadowScorecardSlice {
	const matchRate = row.wouldHaveSent > 0 ? row.matched / row.wouldHaveSent : 0;
	const offerGraduation =
		row.wouldHaveSent >= GRADUATION_MIN_SAMPLE && matchRate >= GRADUATION_MATCH_RATE;
	return {
		category: row.category,
		sender: row.sender,
		samples: row.samples,
		wouldHaveSent: row.wouldHaveSent,
		matched: row.matched,
		matchRate,
		offerGraduation,
		lastActivityAt: row.lastActivityAt,
	};
}

/**
 * Admin-gated read of the shadow scorecard for the autonomy settings UI. Returns
 * every observed (category, sender) slice with its match rate and a
 * `offerGraduation` flag the UI turns into "would-have-matched 41/47 unedited —
 * enable auto-send for this sender?". Accepting the offer still goes through the
 * explicit graduation-acceptance path (autonomySuggestions); this only surfaces
 * the evidence.
 */
export const getShadowScorecard = adminQuery({
	args: { category: v.optional(v.string()) },
	handler: async (ctx, args): Promise<ShadowScorecardSlice[]> => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');

		const rows = args.category
			? await ctx.db
					.query('agentShadowScorecard')
					.withIndex('by_category', (q) => q.eq('category', args.category!))
					.collect() // bounded: one row per observed sender in this category
			: await ctx.db.query('agentShadowScorecard').collect(); // bounded: one row per observed (category, sender) slice

		const slices: ShadowScorecardSlice[] = [];
		for (const row of rows) {
			slices.push(summarizeSlice(row));
		}
		// Most promising graduation candidates first.
		slices.sort((a, b) => b.matchRate - a.matchRate || b.wouldHaveSent - a.wouldHaveSent);
		return slices;
	},
});
