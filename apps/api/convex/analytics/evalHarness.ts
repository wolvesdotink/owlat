/**
 * Draft-quality eval harness — a lightweight, self-hosted regression + calibration
 * kit for the AI-email pipeline. Pure and deterministic: no LLM, no I/O, no Convex
 * runtime, so it runs from vitest as a fast guard when prompts or models change.
 *
 * Three responsibilities, all built on the same token-level edit-distance the
 * shadow scorecard already uses ({@link draftSimilarity}):
 *
 *   1. GOLDEN SET — a small, checked-in set of inbound→ideal-reply pairs that
 *      pins the behaviour we expect from the draft step. {@link runEvalSuite}
 *      scores a set of candidate drafts against the ideal replies and reports the
 *      north-star edit-distance metric (1 − similarity) per case + in aggregate.
 *   2. REGRESSION CHECK — {@link detectRegression} compares a fresh suite result
 *      against a recorded baseline and flags a drop beyond tolerance or any case
 *      that falls below the per-case floor, so a prompt/model change that quietly
 *      degrades drafts fails the vitest guard instead of shipping.
 *   3. THRESHOLD CALIBRATION — {@link calibrateThreshold} takes labelled real
 *      outcomes (draft→sent similarity + whether the human shipped it unedited)
 *      and returns the similarity cut that best separates "accepted as-is" from
 *      "the human had to edit", so the shadow-mode match bar
 *      (MATCH_SIMILARITY_THRESHOLD) and the draft-quality self-check score bar
 *      are calibrated against real data rather than guessed.
 *
 * FAIL-SOFT: this module only MEASURES. Nothing here routes, sends, or gates the
 * live pipeline; it is an observability + test surface. A miscalibrated threshold
 * can only make the agent MORE conservative (more human review), never auto-send.
 */

import { draftSimilarity } from '../agent/shadowSimilarity';

/** One inbound→ideal-reply fixture. `inbound` is context for authors reading the set. */
export type GoldenCase = {
	/** Stable id used to line a candidate draft up with its ideal reply. */
	id: string;
	/** Autonomy category the inbound message falls under (matches route categories). */
	category: string;
	/** The inbound message body the draft step would see (kept for human review). */
	inbound: string;
	/** The reply a careful human owner would send — the target the draft is scored against. */
	idealReply: string;
};

/**
 * The golden set. Small on purpose: a representative reply per common category,
 * enough to catch a prompt/model regression that flattens tone, drops the ask, or
 * hallucinates. Extend it as real edited-then-sent replies surface good exemplars.
 */
export const GOLDEN_SET: readonly GoldenCase[] = [
	{
		id: 'meeting-accept',
		category: 'scheduling',
		inbound: 'Are you free for a 30 minute call on Thursday at 2pm to walk through the proposal?',
		idealReply:
			'Thursday at 2pm works for me. I have added it to my calendar and will send a short agenda beforehand. Talk then.',
	},
	{
		id: 'invoice-question',
		category: 'billing',
		inbound: 'I was charged twice on invoice 4471 — can you check and refund the duplicate?',
		idealReply:
			'Thanks for flagging this. I can see the duplicate charge on invoice 4471 and have issued a refund for it; it should land in three to five business days. Sorry for the trouble.',
	},
	{
		id: 'intro-decline',
		category: 'sales',
		inbound: 'Would you be open to a quick intro call about our new analytics platform?',
		idealReply:
			'Thanks for reaching out. We are not looking at new analytics tooling right now, so I will pass for the moment. I will keep you in mind if that changes.',
	},
	{
		id: 'support-followup',
		category: 'support',
		inbound: 'The export button still throws an error after your last reply. What should I try next?',
		idealReply:
			'Sorry that is still happening. Could you send a screenshot of the error and the browser you are on? In the meantime, try the export from an incognito window — that clears a stale session in most cases.',
	},
	{
		id: 'thanks-ack',
		category: 'general',
		inbound: 'Just wanted to say the onboarding docs you sent were really helpful, thank you!',
		idealReply: 'Glad they helped! Shout if anything else comes up as you get set up.',
	},
];

/** Per-case score: similarity in [0,1] and its edit-distance complement (1 − similarity). */
export type CaseScore = {
	id: string;
	category: string;
	similarity: number;
	/** North-star per-draft metric: 0 = identical to ideal, 1 = fully divergent. */
	editDistance: number;
	/** True when this case had a candidate draft to score. */
	scored: boolean;
};

export type EvalSuiteResult = {
	cases: CaseScore[];
	/** Mean similarity across scored cases (0 when none scored). */
	meanSimilarity: number;
	/** Mean edit-distance across scored cases (1 − meanSimilarity when any scored). */
	meanEditDistance: number;
	/** Lowest similarity of any scored case — the worst draft in the run. */
	minSimilarity: number;
	scoredCount: number;
};

/**
 * Score a single candidate draft against an ideal reply. Thin, exported wrapper
 * over {@link draftSimilarity} so callers speak in eval terms (similarity +
 * edit-distance) rather than reaching into the shadow module directly.
 */
export function scoreDraft(candidate: string, ideal: string): { similarity: number; editDistance: number } {
	const similarity = draftSimilarity(candidate, ideal);
	return { similarity, editDistance: 1 - similarity };
}

/**
 * Run the golden set against a set of candidate drafts keyed by {@link GoldenCase.id}.
 * A missing candidate is reported as `scored: false` (similarity 0) rather than
 * silently skipped, so a draft step that produced nothing for a case is visible.
 * The `set` argument defaults to {@link GOLDEN_SET} but is injectable for tests.
 */
export function runEvalSuite(
	candidatesById: ReadonlyMap<string, string>,
	set: readonly GoldenCase[] = GOLDEN_SET,
): EvalSuiteResult {
	const cases: CaseScore[] = [];
	let simSum = 0;
	let scoredCount = 0;
	let minSimilarity = 1;

	for (const gc of set) {
		const candidate = candidatesById.get(gc.id);
		if (candidate === undefined) {
			cases.push({ id: gc.id, category: gc.category, similarity: 0, editDistance: 1, scored: false });
			continue;
		}
		const { similarity, editDistance } = scoreDraft(candidate, gc.idealReply);
		cases.push({ id: gc.id, category: gc.category, similarity, editDistance, scored: true });
		simSum += similarity;
		scoredCount += 1;
		if (similarity < minSimilarity) minSimilarity = similarity;
	}

	const meanSimilarity = scoredCount > 0 ? simSum / scoredCount : 0;
	return {
		cases,
		meanSimilarity,
		meanEditDistance: scoredCount > 0 ? 1 - meanSimilarity : 0,
		minSimilarity: scoredCount > 0 ? minSimilarity : 0,
		scoredCount,
	};
}

/** A recorded baseline for {@link detectRegression} — the last-known-good suite mean. */
export type EvalBaseline = {
	/** Mean similarity a good run is expected to clear. */
	meanSimilarity: number;
};

/** Default tolerances for the regression guard. Conservative — small drift is fine. */
export const DEFAULT_REGRESSION_TOLERANCE = 0.05; // allowed drop in mean similarity
export const DEFAULT_PER_CASE_FLOOR = 0.5; // no single scored case may fall below this

export type RegressionReport = {
	regressed: boolean;
	/** How far mean similarity fell below baseline (0 when at or above baseline). */
	meanDrop: number;
	/** Ids of scored cases that fell below {@link DEFAULT_PER_CASE_FLOOR}. */
	failingCases: string[];
};

/**
 * Compare a fresh suite result against a baseline and decide whether it regressed.
 * A run regresses if the mean similarity dropped more than `tolerance` below the
 * baseline, OR any scored case fell below `perCaseFloor`. Vitest turns a
 * `regressed: true` into a failing prompt/model guard.
 */
export function detectRegression(
	result: EvalSuiteResult,
	baseline: EvalBaseline,
	tolerance: number = DEFAULT_REGRESSION_TOLERANCE,
	perCaseFloor: number = DEFAULT_PER_CASE_FLOOR,
): RegressionReport {
	const meanDrop = Math.max(0, baseline.meanSimilarity - result.meanSimilarity);
	const failingCases: string[] = [];
	for (const c of result.cases) {
		if (c.scored && c.similarity < perCaseFloor) failingCases.push(c.id);
	}
	return {
		regressed: meanDrop > tolerance || failingCases.length > 0,
		meanDrop,
		failingCases,
	};
}

/** One labelled real outcome for threshold calibration. */
export type LabelledOutcome = {
	/** draft→sent similarity for this message (from the shadow decision / edit log). */
	similarity: number;
	/** True when the human shipped the draft essentially unedited (a "good" draft). */
	acceptedUnedited: boolean;
};

export type CalibrationResult = {
	/** Similarity cut that best separated accepted-unedited from edited outcomes. */
	suggestedThreshold: number;
	/** Fraction of outcomes the suggested threshold classifies correctly, [0, 1]. */
	accuracy: number;
	/** Number of outcomes the calibration was computed over. */
	sampleSize: number;
};

/**
 * Calibrate a similarity threshold against labelled real outcomes.
 *
 * Sweeps candidate cuts over [0, 1] and picks the one that maximises how well
 * "similarity ≥ cut ⇒ the human accepted it unedited" agrees with the labels —
 * i.e. the bar at which the agent's own draft→sent similarity best predicts a
 * send-ready draft. Feeds the shadow-mode match bar and the draft-quality
 * self-check score bar so both track real behaviour instead of a hard-coded 0.95.
 *
 * FAIL-SOFT: with too few samples it returns the safe default (`fallback`, the
 * current conservative bar) so calibration never LOOSENS the gate on thin data.
 */
export function calibrateThreshold(
	outcomes: readonly LabelledOutcome[],
	fallback = 0.95,
	minSamples = 20,
	step = 0.01,
): CalibrationResult {
	if (outcomes.length < minSamples) {
		return { suggestedThreshold: fallback, accuracy: 0, sampleSize: outcomes.length };
	}

	let bestThreshold = fallback;
	let bestCorrect = -1;
	for (let cut = 0; cut <= 1 + 1e-9; cut += step) {
		let correct = 0;
		for (const o of outcomes) {
			const predictAccept = o.similarity >= cut;
			if (predictAccept === o.acceptedUnedited) correct += 1;
		}
		// Prefer the HIGHER (more conservative) threshold on ties — never loosen
		// the auto-send bar just because a lower cut scores equally.
		if (correct >= bestCorrect) {
			bestCorrect = correct;
			bestThreshold = cut;
		}
	}

	return {
		suggestedThreshold: Number(bestThreshold.toFixed(2)),
		accuracy: bestCorrect / outcomes.length,
		sampleSize: outcomes.length,
	};
}
