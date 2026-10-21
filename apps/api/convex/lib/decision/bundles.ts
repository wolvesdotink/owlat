/**
 * The Phase 2 mail bundles: each registered question set with its
 * version, and the host code that turns its answers into labels. Answers are
 * probabilities; labels are what an artifact stores, a display projection shows
 * and a shadow compares with today's classifier.
 *
 * Every threshold names the probability it reads: a Choice threshold
 * reads its peakedness, a Noul threshold reads its probability as distance from
 * 0.5. The values are provisional starting points, not calibrated: nothing in
 * this release acts on a label, and the block-only auto-send gate refuses any
 * verdict without a calibration revision (`./calibration.ts`).
 *
 * Pure and isolate-safe.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import type { DecisionResult } from '../decisionProviders/types';
import {
	CLAIM_CHECK_QUESTIONS,
	NECESSITY_QUESTIONS,
	POSTBOX_MESSAGE_QUESTIONS,
	TEAM_MESSAGE_QUESTIONS,
	TRIAGE_QUESTIONS,
} from './catalog';
import type { ChoiceAnswer, NoulAnswer, QuestionSet } from './questions';
import { UNKNOWN_LABEL, type ThresholdReading } from './fieldMappings';

/** Stored labels: one per projected field, `unknown` when the answer is ambiguous. */
export type DecisionLabels = Readonly<Record<string, string>>;

export interface DecisionBundle<Q extends QuestionSet = QuestionSet> {
	/** The catalog id (`./catalog.ts`), also the artifact's `questionSetId`. */
	readonly id:
		| 'mail.triage'
		| 'mail.message.team'
		| 'mail.message.postbox'
		| 'mail.necessity'
		| 'mail.claim_check';
	/** Bumped whenever the questions, the state or the label rules change. */
	readonly version: number;
	readonly questions: Q;
	/**
	 * Whether the routing ladder's language rung asks this bundle as one
	 * fast-tier call. Only triage: on that rung the message bundles' one call IS
	 * today's classifier (Team `classify`, Postbox category refinement), so a
	 * second fast-tier call would be the second triage call the ladder forbids.
	 */
	readonly runsOnLanguageRung: boolean;
	/** Answers → labels, through the thresholds and host rules below. */
	readonly project: (answers: DecisionResult<Q>['answers']) => DecisionLabels;
}

/** A Choice label is used only when its distribution is at least this peaked. */
export const CHOICE_THRESHOLD = { reads: 'choice_peakedness', min: 0.6 } as const satisfies {
	reads: ThresholdReading;
	min: number;
};

/**
 * The reply disposition Noul: `reply` at or above `reply`, `informational` at
 * or below `informational`, `unknown` between them.
 */
export const DISPOSITION_THRESHOLD = {
	reads: 'noul_probability',
	reply: 0.7,
	informational: 0.3,
} as const satisfies { reads: ThresholdReading; reply: number; informational: number };

/** Categories that always need a reply, whatever the Noul says (today's guard rail). */
const REPLY_FORCING_CATEGORIES: ReadonlySet<string> = new Set(['complaint']);

/** A Choice answer as a label, or `unknown` when it is not peaked enough. */
export function choiceLabel(answer: ChoiceAnswer): string {
	return answer.confidence >= CHOICE_THRESHOLD.min ? answer.value : UNKNOWN_LABEL;
}

/**
 * The host's reading of the reply Noul. A reply-forcing category is never
 * informational: missing a reply the sender waits for is the expensive error.
 */
export function interpretDisposition(probability: number, category: string): string {
	if (probability >= DISPOSITION_THRESHOLD.reply) return 'reply';
	if (REPLY_FORCING_CATEGORIES.has(category)) return 'reply';
	if (probability <= DISPOSITION_THRESHOLD.informational) return 'informational';
	return UNKNOWN_LABEL;
}

function projectMessage(answers: {
	readonly category: ChoiceAnswer;
	readonly disposition: NoulAnswer;
}): DecisionLabels {
	const category = choiceLabel(answers.category);
	return { category, disposition: interpretDisposition(answers.disposition.probability, category) };
}

export const TRIAGE_BUNDLE: DecisionBundle<typeof TRIAGE_QUESTIONS> = {
	id: 'mail.triage',
	version: 1,
	questions: TRIAGE_QUESTIONS,
	runsOnLanguageRung: true,
	project: (answers) => ({ triage: choiceLabel(answers.triage) }),
};

export const TEAM_MESSAGE_BUNDLE: DecisionBundle<typeof TEAM_MESSAGE_QUESTIONS> = {
	id: 'mail.message.team',
	version: 1,
	questions: TEAM_MESSAGE_QUESTIONS,
	runsOnLanguageRung: false,
	project: projectMessage,
};

export const POSTBOX_MESSAGE_BUNDLE: DecisionBundle<typeof POSTBOX_MESSAGE_QUESTIONS> = {
	id: 'mail.message.postbox',
	version: 1,
	questions: POSTBOX_MESSAGE_QUESTIONS,
	runsOnLanguageRung: false,
	project: projectMessage,
};

/**
 * D5: the necessity Noul read at one cut, `needed` at or above it. No
 * abstention band: the answer gates a question the owner can skip, and the
 * provisional cut is the plain reading of the probability. Not calibrated.
 */
export const NECESSITY_THRESHOLD = { reads: 'noul_probability', needed: 0.5 } as const satisfies {
	reads: ThresholdReading;
	needed: number;
};

/** Labels: `needed` or `not_needed`. */
export const NECESSITY_BUNDLE: DecisionBundle<typeof NECESSITY_QUESTIONS> = {
	id: 'mail.necessity',
	version: 1,
	questions: NECESSITY_QUESTIONS,
	// The ladder's language rung is ONE fast-tier call: it replaces the sampled
	// replies and the divergence judge (capable on Postbox) with that one call.
	runsOnLanguageRung: true,
	project: (answers) => ({
		necessity:
			answers.necessity.probability >= NECESSITY_THRESHOLD.needed ? 'needed' : 'not_needed',
	}),
};

/**
 * Labels: `supported`, `contradicted`, `insufficient`, or `unknown` when the
 * Choice is not peaked enough. Only `supported` lets a claim through.
 */
export const CLAIM_CHECK_BUNDLE: DecisionBundle<typeof CLAIM_CHECK_QUESTIONS> = {
	id: 'mail.claim_check',
	version: 1,
	questions: CLAIM_CHECK_QUESTIONS,
	// On the language rung today's verifier IS the rung (three claims per
	// guard-tier call); a second language call per claim would double it.
	runsOnLanguageRung: false,
	project: (answers) => ({ verdict: choiceLabel(answers.verdict) }),
};

/** Whether every label is `unknown`: the artifact is then `abstained`, not `complete`. */
export function isAbstention(labels: DecisionLabels): boolean {
	return Object.values(labels).every((label) => label === UNKNOWN_LABEL);
}

/**
 * Whether the bundle agreed with today's source on every field both settled.
 * `undefined` when no field was comparable (no baseline, or every label unknown).
 */
export function agreementWith(
	labels: DecisionLabels,
	baseline: DecisionLabels | undefined
): boolean | undefined {
	if (!baseline) return undefined;
	const compared = Object.keys(baseline).filter(
		(field) => labels[field] !== undefined && labels[field] !== UNKNOWN_LABEL
	);
	if (compared.length === 0) return undefined;
	return compared.every((field) => labels[field] === baseline[field]);
}

/** The ledger feature each decision task records under (`lib/llm/taskPolicy.ts`). */
export const DECISION_FEATURE: Readonly<
	Record<
		'mail.triage' | 'mail.category' | 'mail.disposition' | 'mail.necessity' | 'mail.claim_check',
		string
	>
> = {
	'mail.triage': 'decision_triage',
	'mail.category': 'decision_category',
	'mail.disposition': 'decision_disposition',
	'mail.necessity': 'decision_necessity',
	'mail.claim_check': 'decision_claim_check',
};

export type DecisionBundleTask = keyof typeof DECISION_FEATURE & AiTaskName;
