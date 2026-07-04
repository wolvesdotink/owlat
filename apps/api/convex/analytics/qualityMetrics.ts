/**
 * AI-email quality dashboards — the read side of the eval harness.
 *
 * Aggregates the write-then-aggregate signals the pipeline already records into
 * the two north-star views the clarify loop and the auto-send path need:
 *
 *   - CLARIFY METRICS ({@link getClarifyMetrics}) rolls up `clarificationAskLog`
 *     into question-rate, the answer→draft-delta (how often an answered ask
 *     actually moved the draft, and by how much), and the mean predicted value of
 *     asks — the clarify loop's core scorecard.
 *   - DRAFT-QUALITY METRICS ({@link getDraftQualityMetrics}) rolls up the
 *     reconciled `agentShadowDecisions` into the draft→sent edit-distance
 *     north-star (overall and per contact/sender) plus the unedited-accept rate —
 *     the shadow scorecard's quality view.
 *
 * The aggregation logic is pure and exported ({@link aggregateClarifyMetrics},
 * {@link aggregateDraftQuality}) so vitest can assert it directly and the eval
 * harness can reuse it; the Convex queries are thin admin-gated fetch-then-fold
 * wrappers, windowed the same way as `analytics/llmUsage`.
 *
 * Pure observability — nothing here routes, sends, or gates. FAIL-SOFT by
 * construction: a metric read can only inform a human, never auto-send.
 */

import { v } from 'convex/values';
import { adminQuery } from '../lib/authedFunctions';

// ============================================================
// Clarify metrics (clarificationAskLog)
// ============================================================

/** The subset of a `clarificationAskLog` row the aggregation needs. */
export type ClarifyAskRow = {
	source: 'agent' | 'reply_queue';
	questionCount: number;
	predictedValue: number;
	isDraftChanged?: boolean;
	draftDivergence?: number;
};

export type ClarifyMetrics = {
	/** Total asks in the window. */
	askCount: number;
	/** Mean number of questions per ask (the "how chatty is the clarify loop" dial). */
	questionRate: number;
	/** Mean predicted value of the asks that were made, [0, 1]. */
	meanPredictedValue: number;
	/** Asks for which an answer→draft delta was sampled. */
	answeredCount: number;
	/** Of answered asks, the fraction where the answer materially changed the draft. */
	answerDeltaRate: number;
	/** Mean draft divergence (1 − similarity) over answered asks where it was sampled. */
	meanDraftDivergence: number;
};

/**
 * Fold clarification ask rows into the clarify-loop scorecard. Pure — the query
 * and the eval harness share it so they agree on the definitions.
 */
export function aggregateClarifyMetrics(rows: readonly ClarifyAskRow[]): ClarifyMetrics {
	let questionSum = 0;
	let predictedSum = 0;
	let answeredCount = 0;
	let changedCount = 0;
	let divergenceSum = 0;
	let divergenceSamples = 0;

	for (const r of rows) {
		questionSum += r.questionCount;
		predictedSum += r.predictedValue;
		if (r.isDraftChanged !== undefined) {
			answeredCount += 1;
			if (r.isDraftChanged) changedCount += 1;
		}
		if (r.draftDivergence !== undefined) {
			divergenceSum += r.draftDivergence;
			divergenceSamples += 1;
		}
	}

	const askCount = rows.length;
	return {
		askCount,
		questionRate: askCount > 0 ? questionSum / askCount : 0,
		meanPredictedValue: askCount > 0 ? predictedSum / askCount : 0,
		answeredCount,
		answerDeltaRate: answeredCount > 0 ? changedCount / answeredCount : 0,
		meanDraftDivergence: divergenceSamples > 0 ? divergenceSum / divergenceSamples : 0,
	};
}

// ============================================================
// Draft-quality metrics (agentShadowDecisions)
// ============================================================

/** The subset of a resolved `agentShadowDecisions` row the aggregation needs. */
export type ShadowDecisionRow = {
	sender: string;
	isResolved: boolean;
	userAction?: 'approved' | 'rejected' | 'edited';
	similarity?: number;
};

export type SenderQuality = {
	sender: string;
	samples: number;
	/** Mean draft→sent similarity for this sender (0 when unsampled). */
	meanSimilarity: number;
	/** North-star: mean edit-distance (1 − similarity) for this sender. */
	meanEditDistance: number;
	/** Fraction of reconciled drafts the human shipped unedited (approved). */
	acceptRate: number;
};

export type DraftQualityMetrics = {
	/** Reconciled decisions with a sampled similarity, in the window. */
	sampleCount: number;
	/** Overall mean draft→sent similarity. */
	meanSimilarity: number;
	/** Overall north-star mean edit-distance (1 − meanSimilarity). */
	meanEditDistance: number;
	/** Overall unedited-accept rate over reconciled decisions. */
	acceptRate: number;
	/** Per-sender/contact breakdown, worst edit-distance first. */
	bySender: SenderQuality[];
};

/**
 * Fold reconciled shadow decisions into the draft→sent edit-distance north-star,
 * overall and per sender/contact. Only rows carrying a sampled `similarity` count
 * toward the distance metric; the accept rate is measured over all reconciled
 * rows (approved-unedited vs edited/rejected). Pure and shared with the query.
 */
export function aggregateDraftQuality(rows: readonly ShadowDecisionRow[]): DraftQualityMetrics {
	type Acc = { simSum: number; simCount: number; approved: number; resolved: number };
	const bySender = new Map<string, Acc>();
	let simSum = 0;
	let simCount = 0;
	let approved = 0;
	let resolved = 0;

	for (const r of rows) {
		if (!r.isResolved) continue;
		const acc = bySender.get(r.sender) ?? { simSum: 0, simCount: 0, approved: 0, resolved: 0 };
		acc.resolved += 1;
		resolved += 1;
		if (r.userAction === 'approved') {
			acc.approved += 1;
			approved += 1;
		}
		if (r.similarity !== undefined) {
			acc.simSum += r.similarity;
			acc.simCount += 1;
			simSum += r.similarity;
			simCount += 1;
		}
		bySender.set(r.sender, acc);
	}

	const senders: SenderQuality[] = [];
	for (const [sender, acc] of bySender) {
		const meanSimilarity = acc.simCount > 0 ? acc.simSum / acc.simCount : 0;
		senders.push({
			sender,
			samples: acc.resolved,
			meanSimilarity,
			meanEditDistance: acc.simCount > 0 ? 1 - meanSimilarity : 0,
			acceptRate: acc.resolved > 0 ? acc.approved / acc.resolved : 0,
		});
	}
	// Worst quality first — highest edit-distance surfaces where the draft step
	// most needs work.
	senders.sort((a, b) => b.meanEditDistance - a.meanEditDistance);

	const meanSimilarity = simCount > 0 ? simSum / simCount : 0;
	return {
		sampleCount: simCount,
		meanSimilarity,
		meanEditDistance: simCount > 0 ? 1 - meanSimilarity : 0,
		acceptRate: resolved > 0 ? approved / resolved : 0,
		bySender: senders,
	};
}

// ============================================================
// Admin-gated dashboard queries
// ============================================================

const DEFAULT_WINDOW_HOURS = 24 * 7; // one week
const SCAN_CAP = 5000; // windowed scan ceiling, matching analytics/llmUsage

/** Clarify-loop scorecard over a recent window, for the autonomy/quality dashboard. */
export const getClarifyMetrics = adminQuery({
	args: { hoursBack: v.optional(v.number()) },
	handler: async (ctx, args): Promise<ClarifyMetrics & { hoursBack: number }> => {
		const hoursBack = args.hoursBack ?? DEFAULT_WINDOW_HOURS;
		const since = Date.now() - hoursBack * 60 * 60 * 1000;
		// bounded: windowed scan capped at the most-recent SCAN_CAP ask rows.
		const rows = await ctx.db
			.query('clarificationAskLog')
			.withIndex('by_created_at', (q) => q.gte('createdAt', since))
			.order('desc')
			.take(SCAN_CAP);
		return { ...aggregateClarifyMetrics(rows), hoursBack };
	},
});

/** Draft→sent edit-distance north-star + per-sender quality over a recent window. */
export const getDraftQualityMetrics = adminQuery({
	args: { hoursBack: v.optional(v.number()) },
	handler: async (ctx, args): Promise<DraftQualityMetrics & { hoursBack: number }> => {
		const hoursBack = args.hoursBack ?? DEFAULT_WINDOW_HOURS;
		const since = Date.now() - hoursBack * 60 * 60 * 1000;
		// bounded: windowed scan capped at the most-recent SCAN_CAP shadow decisions.
		const rows = await ctx.db
			.query('agentShadowDecisions')
			.withIndex('by_creation_time', (q) => q.gte('_creationTime', since))
			.order('desc')
			.take(SCAN_CAP);
		return { ...aggregateDraftQuality(rows), hoursBack };
	},
});
