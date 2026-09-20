/**
 * Decision plane — the question DSL and the answer shapes.
 *
 * The third plane (per the 2026-09-17 decision-plane plan) does not write text.
 * A caller hands it a `state` and a named set of TYPED questions and gets one
 * typed answer per question back, with the probability distribution that
 * produced it. There is no schema to validate and no JSON to repair, because
 * the answer space is the set of options the caller sent.
 *
 * Three question types, and the asymmetry between them is the whole point:
 *
 *   • NOUL — a yes/no whose signal IS the probability. Returns a bare
 *     probability in [0, 1] and NO confidence field. A Noul threshold is
 *     therefore distance from 0.5, never "confidence > x".
 *   • CHOICE — unordered labels (category, intent, relation type). Returns the
 *     chosen option, a distribution over ALL options, and a confidence (how
 *     peaked that distribution is). Option descriptions may be null.
 *   • SCORE — an ordered judgement over at least two levels (urgency,
 *     frustration, relevance). Returns a number that may land BETWEEN levels,
 *     the legend it was scored against, a distribution keyed by level, and a
 *     confidence.
 *
 * Probability is not confidence, so the answer union is discriminated on `kind`
 * and `NoulAnswer` simply has no `confidence` property: reading one off a Noul
 * is a compile error rather than an `undefined` that silently reads as 0. That
 * is the one property of this file everything downstream depends on.
 *
 * Per the plan's jagged-edges rules, a Score is an ordered LABEL and never a
 * magnitude — do not interpolate between levels, and weight composites in
 * TypeScript against our own labels.
 *
 * This file is pure and isolate-safe: `schema/instance.ts` reaches the decision
 * kinds through this chain, so nothing here may import `node:crypto`,
 * `@ai-sdk/*` or `convex/server`. It has no vendor vocabulary in it either —
 * the translation to and from the wire lives in `lib/decisionProviders/wire.ts`.
 */

/**
 * Choice cardinality caps at 255 upstream (the vendor's own jaggedness page).
 * Anything with a larger vocabulary — folder routing, label suggestion —
 * classifies hierarchically or shortlists in code first.
 */
export const MAX_CHOICE_OPTIONS = 255;

/** A Score needs an ordered scale, and a scale needs at least two levels. */
export const MIN_SCORE_LEVELS = 2;

/** Optional per-pole wording for a Noul, so `true`/`false` are not left to reading. */
export interface NoulCriteria {
	readonly true: string;
	readonly false: string;
}

/** Option → description. A description may be null when the label speaks for itself. */
export type ChoiceCriteria = Readonly<Record<string, string | null>>;

/** The ordered level descriptions of a Score, lowest first. */
export type ScoreCriteria = readonly string[];

export interface NoulQuestion {
	readonly type: 'noul';
	readonly instructions: string;
	readonly criteria?: NoulCriteria;
}

export interface ChoiceQuestion {
	readonly type: 'choice';
	readonly instructions: string;
	readonly criteria: ChoiceCriteria;
}

export interface ScoreQuestion {
	readonly type: 'score';
	readonly instructions: string;
	readonly criteria: ScoreCriteria;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** A named set of questions answered in one round trip. Keys are the answer keys. */
export type QuestionSet = Readonly<Record<string, DecisionQuestion>>;

/** A yes/no answer: the probability IS the signal, and there is no confidence. */
export interface NoulAnswer {
	readonly kind: 'noul';
	/** Probability that the question is true, in [0, 1]. */
	readonly probability: number;
}

/** An unordered label, with the distribution it was drawn from. */
export interface ChoiceAnswer {
	readonly kind: 'choice';
	/** The selected option — always one of the option keys that were sent. */
	readonly value: string;
	/** Probability per option, one entry for every option that was sent. */
	readonly probabilities: Readonly<Record<string, number>>;
	/** How peaked the distribution is, in [0, 1]. Not a probability of being right. */
	readonly confidence: number;
}

/** An ordered judgement, with the legend it was scored against. */
export interface ScoreAnswer {
	readonly kind: 'score';
	/** The score. May land between levels — treat it as an ordered label, not a magnitude. */
	readonly value: number;
	/** The level descriptions that were sent, lowest first. */
	readonly levels: readonly string[];
	/** Probability per level, keyed by 1-based ordinals on both adapters. */
	readonly probabilities: Readonly<Record<string, number>>;
	/** How peaked the distribution is, in [0, 1]. */
	readonly confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer a single question type produces. */
export type AnswerOf<Q extends DecisionQuestion> = Q extends NoulQuestion
	? NoulAnswer
	: Q extends ChoiceQuestion
		? ChoiceAnswer
		: ScoreAnswer;

/**
 * The answers a question set produces: same keys, each narrowed to the answer
 * its own question type returns. A call site that asks a Choice and a Noul gets
 * back a record where only one of the two has a `confidence`.
 */
export type AnswersFor<Q extends QuestionSet> = { readonly [K in keyof Q]: AnswerOf<Q[K]> };

function assertInstructions(type: DecisionQuestion['type'], instructions: string): void {
	if (instructions.trim().length === 0) {
		throw new Error(`Decision question (${type}) requires non-empty instructions.`);
	}
}

/**
 * A yes/no question. `criteria` names the two poles; when it is supplied the
 * wording must agree in direction with the instructions — mapping `true` to a
 * "no" reads worse than no criteria at all (the vendor's inverted-mapping
 * jagged edge). State the judgement positively and ask exactly one thing.
 */
export function noul(instructions: string, criteria?: NoulCriteria): NoulQuestion {
	assertInstructions('noul', instructions);
	if (criteria && (criteria.true.trim().length === 0 || criteria.false.trim().length === 0)) {
		throw new Error('Noul criteria must describe both the true and the false pole.');
	}
	return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

/**
 * An unordered classification over a fixed option set. Boundary cases belong in
 * the option descriptions rather than in the instructions, and a description of
 * `null` means "the label is its own description".
 */
export function choice(instructions: string, criteria: ChoiceCriteria): ChoiceQuestion {
	assertInstructions('choice', instructions);
	const options = Object.keys(criteria);
	if (options.length === 0) {
		throw new Error('Choice criteria must contain at least one option.');
	}
	if (options.length > MAX_CHOICE_OPTIONS) {
		throw new Error(
			`Choice criteria cap at ${MAX_CHOICE_OPTIONS} options (got ${options.length}). ` +
				'Classify hierarchically or shortlist in code first.'
		);
	}
	if (options.some((option) => option.trim().length === 0)) {
		throw new Error('Choice options must be non-empty labels.');
	}
	return { type: 'choice', instructions, criteria };
}

/**
 * An ordered judgement over at least two levels, lowest first. The levels are
 * labels on a scale, not units: weight and compare in our own code.
 */
export function score(instructions: string, criteria: ScoreCriteria): ScoreQuestion {
	assertInstructions('score', instructions);
	if (criteria.length < MIN_SCORE_LEVELS) {
		throw new Error(
			`Score criteria need at least ${MIN_SCORE_LEVELS} ordered levels (got ${criteria.length}).`
		);
	}
	if (criteria.some((level) => level.trim().length === 0)) {
		throw new Error('Score levels must be non-empty descriptions.');
	}
	return { type: 'score', instructions, criteria };
}
