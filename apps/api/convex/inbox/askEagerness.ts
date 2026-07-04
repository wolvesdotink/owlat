/**
 * Ask-eagerness dial — the single user-facing "how readily should Owlat ask me
 * a clarifying question" trust setting, and the pure policy + instrumentation
 * helpers the clarify surfaces read.
 *
 * The dial sits ALONGSIDE Graduated Autonomy (autonomy.ts) so the two read as
 * one coherent trust control: autonomy decides when Owlat may act without me,
 * eagerness decides when it should stop and ask me. Horvitz act / ask /
 * stay-silent banding — the dial only moves the ASK band.
 *
 *   - `cautious`   — ask more. Always run the missing-info check; surface up to
 *                    the hard cap. Good while you still distrust the agent.
 *   - `balanced`   — the middle ground; cap tightened, cheap coverage
 *                    short-circuit kept for routine mail.
 *   - `confident`  — ask less. Only genuinely high-stakes slots
 *                    (money / commitment / date / legal-tone) are worth a
 *                    question; routine acknowledgements are never asked about.
 *   - `off`        — never ask; always draft for human review (today's
 *                    pre-clarify behaviour minus the ask).
 *
 * FAIL-SOFT: an ABSENT setting (`undefined`) is NOT `balanced` — it resolves to
 * today's exact behaviour (full cap, no high-stakes filter, coverage
 * short-circuit governed only by category). The dial can only be a no-op or a
 * narrowing until the owner deliberately moves it.
 *
 * Pure (no `'use node'`, no Convex context) so it imports cleanly into the
 * clarify Agent step (an action) AND the Reply-Queue draft path AND unit tests.
 */

import { draftSimilarity } from '../agent/shadowSimilarity';
import { MAX_QUESTIONS, type SlotType } from './clarificationSlots';

/** The four dial positions, ordered most-eager → least-eager → off. */
export const EAGERNESS_MODES = ['cautious', 'balanced', 'confident', 'off'] as const;
export type EagernessMode = (typeof EAGERNESS_MODES)[number];

/** Narrow an unknown string to a valid mode (else `undefined` → today's
 * behaviour). Used when reading the persisted setting. */
export function asEagernessMode(value: string | null | undefined): EagernessMode | undefined {
	for (const mode of EAGERNESS_MODES) {
		if (mode === value) return mode;
	}
	return undefined;
}

/**
 * The high-stakes reply slots — the ones where a wrong assumption is expensive:
 * a `price_number` (money), a `decision` (a commitment), a `date_time` (a
 * date), a `stance_tone` (legal / relationship tone). `attachment` and
 * `factual_lookup` are routine lookups. Under `confident` only these are worth
 * a question.
 */
export const HIGH_STAKES_SLOTS: ReadonlySet<SlotType> = new Set<SlotType>([
	'price_number',
	'decision',
	'date_time',
	'stance_tone',
]);

/** True when a slot type is high-stakes (money / commitment / date / tone). */
export function isHighStakesSlot(slotType: string): boolean {
	return HIGH_STAKES_SLOTS.has(slotType as SlotType);
}

/**
 * The resolved clarify policy for a message: whether to ask at all, the hard
 * per-email question cap (always batched into ONE micro-form, never dripped),
 * whether only high-stakes slots may surface, and whether to force the
 * (otherwise-skippable) missing-info check.
 */
export interface EagernessPolicy {
	/** When false the clarify step emits zero questions and routes to drafting. */
	enabled: boolean;
	/** Hard ceiling on questions surfaced this email (<= {@link MAX_QUESTIONS}). */
	maxQuestions: number;
	/** When true, drop any non-high-stakes slot before surfacing (raise the bar). */
	highStakesOnly: boolean;
	/** When true, disable the cheap coverage short-circuit so the check runs. */
	forceCheck: boolean;
}

/**
 * Resolve the clarify policy from the dial. `mode === undefined` reproduces
 * today's behaviour exactly. `categoryCautious` is the existing complaint /
 * urgent signal ({@link eagernessForCategory}) — high-stakes mail always runs
 * the check regardless of the dial, so the dial can only narrow WHICH slots
 * surface and HOW MANY, never disable the safety check for complaints.
 */
export function resolveEagernessPolicy(
	mode: EagernessMode | undefined,
	opts: { categoryCautious: boolean }
): EagernessPolicy {
	const categoryForce = opts.categoryCautious;
	switch (mode) {
		case 'off':
			return { enabled: false, maxQuestions: 0, highStakesOnly: false, forceCheck: false };
		case 'cautious':
			return {
				enabled: true,
				maxQuestions: MAX_QUESTIONS,
				highStakesOnly: false,
				forceCheck: true,
			};
		case 'balanced':
			return { enabled: true, maxQuestions: 2, highStakesOnly: false, forceCheck: categoryForce };
		case 'confident':
			return { enabled: true, maxQuestions: 1, highStakesOnly: true, forceCheck: categoryForce };
		case undefined:
		default:
			// No setting → today's behaviour: full cap, no high-stakes filter, the
			// coverage short-circuit governed only by category.
			return {
				enabled: true,
				maxQuestions: MAX_QUESTIONS,
				highStakesOnly: false,
				forceCheck: categoryForce,
			};
	}
}

// ─── Ask-outcome instrumentation ────────────────────────────────────────────

/**
 * Cheap predicted VALUE of an ask, in [0, 1], from the slot types being asked
 * about — how likely the answer is to matter. High-stakes slots dominate; a
 * pure-routine ask scores low. Logged next to the measured outcome so we can
 * see whether high-predicted-value asks are the ones that actually change the
 * draft (calibration), without a model call.
 */
export function predictedAskValue(slotTypes: readonly string[]): number {
	if (slotTypes.length === 0) return 0;
	let highStakes = 0;
	for (const slotType of slotTypes) {
		if (isHighStakesSlot(slotType)) highStakes += 1;
	}
	const fraction = highStakes / slotTypes.length;
	// Floor of 0.2 for any ask (asking always has some value), scaled up to 1.0
	// as the share of high-stakes slots rises.
	const value = 0.2 + 0.8 * fraction;
	return Math.min(1, Math.max(0, value));
}

/** Divergence at/above which the answer is judged to have CHANGED the draft. */
export const DRAFT_CHANGED_DIVERGENCE = 0.15;

/**
 * How often to pay for the second (answers-omitted) draft used to measure the
 * ask→answer→draft delta. Sampling keeps the calibration signal cheap: most
 * clarifications skip the extra model call and only log the predicted value.
 */
export const DRAFT_DELTA_SAMPLE_RATE = 0.25;

/** True when this clarification should pay for the delta measurement. Pure —
 * the caller injects the random draw so it is deterministic under test. */
export function shouldSampleDraftDelta(rand: number = Math.random()): boolean {
	return rand < DRAFT_DELTA_SAMPLE_RATE;
}

export interface DraftDelta {
	/** Token-level similarity of the with-answers vs answers-omitted draft. */
	similarity: number;
	/** 1 - similarity. */
	divergence: number;
	/** Whether the owner's answers materially changed the draft. */
	changed: boolean;
}

/**
 * Measure whether the owner's confirmed answers actually changed the produced
 * draft, by comparing it to a draft sampled WITHOUT the answers. Reuses the
 * deterministic shadow-scorecard similarity — no extra model call here (the
 * two drafts are supplied by the caller).
 */
export function measureDraftDelta(withAnswers: string, withoutAnswers: string): DraftDelta {
	const similarity = draftSimilarity(withAnswers, withoutAnswers);
	const divergence = 1 - similarity;
	return { similarity, divergence, changed: divergence >= DRAFT_CHANGED_DIVERGENCE };
}
