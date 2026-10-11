/**
 * Scores a decision run against the corpus labels of its split: per task,
 * accuracy and per-class recall and precision with 95% intervals, the same
 * sliced by language, calibration (Brier score, reliability bins) of the
 * probability the task's threshold reads, the consequential errors one by one,
 * and, when today's classifier ran on the same split, its accuracy and its
 * agreement with the candidate.
 *
 * Which probability is scored is named on every task, because they are not the
 * same kind of number (`lib/decision/questions.ts`):
 *   - `noul_probability`: a Noul's probability that the statement is true.
 *     The threshold reads it directly; Brier and reliability are of it against
 *     the positive class.
 *   - `choice_peakedness`: a Choice's confidence, how peaked its distribution
 *     is. It is not a probability of being right, which is exactly why its
 *     reliability against correctness is measured before a threshold trusts
 *     it. The multiclass Brier of the full distribution is reported beside it.
 *
 * Failed predictions (provider outages) are counted, never scored as wrong.
 *
 * Pure and isolate-safe.
 */
import type { EvalThread } from './corpus';
import type { DecisionLabel, EvalSplit } from './decisionLabels';
import type { DecisionEvalTask, DecisionPrediction, DecisionRun } from './decisionRunner';
import { threadsInSplit } from './splits';
import {
	brierBinary,
	brierMulticlass,
	cohensKappa,
	confusion,
	reliability,
	wilson,
	zeroFailureUpper95,
	type BinaryPoint,
	type Confusion,
	type Interval,
	type ReliabilityBin,
} from './stats';

type Locale = EvalThread['locale'];

interface TaskSpec {
	questionType: 'choice' | 'noul';
	/** Noul tasks: [positive, negative]. Choice tasks: the option list. */
	classes: readonly string[];
	/** Reads the label of one message, or of each of its drafts. */
	labels: (
		thread: EvalThread,
		d: DecisionLabel
	) => { label: string; draftId?: string; rejected?: boolean }[];
	consequential: { description: string; isError: (label: string, predicted: string) => boolean };
}

const one = (label: string | undefined) => (label === undefined ? [] : [{ label }]);

export const TASK_SPECS: Record<DecisionEvalTask, TaskSpec> = {
	triage: {
		questionType: 'choice',
		classes: ['spam', 'automated', 'needs_work', 'no_work'],
		labels: (_, d) => one(d.triage),
		consequential: {
			description:
				'Mail that is not spam triaged as spam, or mail that needs work triaged as needing none.',
			isError: (label, predicted) =>
				(predicted === 'spam' && label !== 'spam') ||
				(label === 'needs_work' && predicted !== 'needs_work'),
		},
	},
	postbox_category: {
		questionType: 'choice',
		classes: ['person', 'newsletter', 'notification', 'receipt', 'promotion', 'spam', 'other'],
		labels: (t, d) => (t.mode === 'brief' ? one(d.postboxCategory) : []),
		consequential: {
			description: 'Mail that is not spam categorized as spam (Postbox moves it to Spam).',
			isError: (label, predicted) => predicted === 'spam' && label !== 'spam',
		},
	},
	team_category: {
		questionType: 'choice',
		classes: [
			'support',
			'sales',
			'billing',
			'feature_request',
			'complaint',
			'spam',
			'internal',
			'other',
		],
		labels: (t, d) => (t.mode === 'actions' ? one(d.teamCategory) : []),
		consequential: {
			description: 'Mail that is not spam categorized as spam (the Team Inbox archives it).',
			isError: (label, predicted) => predicted === 'spam' && label !== 'spam',
		},
	},
	disposition: {
		questionType: 'noul',
		classes: ['reply', 'informational'],
		labels: (_, d) => one(d.disposition),
		consequential: {
			description: 'A message whose sender waits for a reply judged informational.',
			isError: (label, predicted) => label === 'reply' && predicted === 'informational',
		},
	},
	necessity: {
		questionType: 'noul',
		classes: ['needed', 'not_needed'],
		labels: (_, d) => one(d.clarification?.necessity),
		consequential: {
			description: 'A reply that needs the owner first judged answerable without asking.',
			isError: (label, predicted) => label === 'needed' && predicted === 'not_needed',
		},
	},
	draft_quality: {
		questionType: 'noul',
		classes: ['acceptable', 'not_acceptable'],
		labels: (_, d) =>
			(d.drafts ?? []).map((draft) => ({
				draftId: draft.id,
				label: draft.acceptance === 'accept' ? 'acceptable' : 'not_acceptable',
				...(draft.acceptance === 'reject' ? { rejected: true } : {}),
			})),
		consequential: {
			description: 'A draft the owner rejects judged acceptable.',
			// The scorer passes `rejected` as the label for rejected drafts.
			isError: (label, predicted) => label === 'rejected' && predicted === 'acceptable',
		},
	},
};

export interface ClassScore {
	support: number;
	recall: Interval;
	precision: Interval;
}

export interface SliceScore {
	labelled: number;
	answered: number;
	accuracy: Interval;
	perClass: Record<string, ClassScore>;
}

export interface ConsequentialError {
	threadId: string;
	messageId: string;
	draftId?: string;
	label: string;
	predicted: string;
	probability?: number;
}

export interface DecisionTaskReport extends SliceScore {
	task: DecisionEvalTask;
	questionType: 'choice' | 'noul';
	probability: 'noul_probability' | 'choice_peakedness';
	/** Noul tasks: the probability at or above which the positive class is predicted. */
	threshold: number | null;
	failed: number;
	byLanguage: Partial<Record<Locale, SliceScore>>;
	calibration: {
		/** What the answering adapters stamped: calibrated, not, or a mix. */
		adapters: 'calibrated' | 'uncalibrated' | 'mixed' | 'none';
		brier: number | null;
		/** Choice tasks: multiclass Brier of the full distribution. */
		distributionBrier: number | null;
		reliability: ReliabilityBin[];
		ece: number | null;
	};
	consequential: {
		description: string;
		errors: ConsequentialError[];
		rate: Interval;
		/** With no error observed: the 95% upper bound the data cannot rule out. */
		upper95WhenNoneObserved: number | null;
	};
	baseline: (SliceScore & { executor: string; failed: number }) | null;
	agreement: {
		compared: number;
		rate: Interval;
		kappa: number | null;
		confusion: Confusion;
	} | null;
}

interface Case {
	key: string;
	threadId: string;
	messageId: string;
	draftId?: string;
	locale: Locale;
	label: string;
	rejected?: boolean;
}

const keyOf = (p: { threadId: string; messageId: string; draftId?: string }) =>
	`${p.threadId}/${p.messageId}${p.draftId ? `/${p.draftId}` : ''}`;

function casesFor(corpus: readonly EvalThread[], split: EvalSplit | 'all', task: DecisionEvalTask) {
	const cases: Case[] = [];
	for (const thread of threadsInSplit(corpus, split)) {
		for (const d of thread.labels.decisions) {
			for (const entry of TASK_SPECS[task].labels(thread, d)) {
				const c = { threadId: thread.id, messageId: d.messageId, ...entry };
				cases.push({ ...c, key: keyOf(c), locale: thread.locale });
			}
		}
	}
	return cases;
}

/** The class a prediction stands for: the Choice value, or the Noul side of the threshold. */
function predictedClass(spec: TaskSpec, p: DecisionPrediction, threshold: number) {
	if (p.outcome !== 'answered') return undefined;
	if (spec.questionType === 'choice') return p.value;
	if (p.value !== undefined) return p.value;
	if (p.probability === undefined) return undefined;
	return p.probability >= threshold ? spec.classes[0] : spec.classes[1];
}

function sliceScore(
	spec: TaskSpec,
	cases: readonly Case[],
	predicted: ReadonlyMap<string, string>
): SliceScore {
	const answered = cases.filter((c) => predicted.has(c.key));
	const correct = answered.filter((c) => predicted.get(c.key) === c.label).length;
	const perClass: Record<string, ClassScore> = {};
	for (const cls of spec.classes) {
		const support = answered.filter((c) => c.label === cls);
		const chosen = answered.filter((c) => predicted.get(c.key) === cls);
		if (support.length === 0 && chosen.length === 0) continue;
		perClass[cls] = {
			support: support.length,
			recall: wilson(support.filter((c) => predicted.get(c.key) === cls).length, support.length),
			precision: wilson(chosen.filter((c) => c.label === cls).length, chosen.length),
		};
	}
	return {
		labelled: cases.length,
		answered: answered.length,
		accuracy: wilson(correct, answered.length),
		perClass,
	};
}

function byLanguage(
	spec: TaskSpec,
	cases: readonly Case[],
	predicted: ReadonlyMap<string, string>
): Partial<Record<Locale, SliceScore>> {
	const out: Partial<Record<Locale, SliceScore>> = {};
	for (const locale of ['en', 'de'] as const) {
		const slice = cases.filter((c) => c.locale === locale);
		if (slice.length > 0) out[locale] = sliceScore(spec, slice, predicted);
	}
	return out;
}

function predictionsFor(run: DecisionRun, task: DecisionEvalTask) {
	return new Map(run.predictions.filter((p) => p.task === task).map((p) => [keyOf(p), p]));
}

export interface ScoreOptions {
	/** Today's classifier on the same split, for baseline accuracy and agreement. */
	baseline?: DecisionRun;
	/** Noul thresholds by task; default 0.5. Fit them on the calibration split. */
	thresholds?: Partial<Record<DecisionEvalTask, number>>;
	bins?: number;
}

/** Score one task of a run. */
export function scoreDecisionTask(
	corpus: readonly EvalThread[],
	run: DecisionRun,
	task: DecisionEvalTask,
	options: ScoreOptions = {}
): DecisionTaskReport {
	const spec = TASK_SPECS[task];
	const threshold = spec.questionType === 'noul' ? (options.thresholds?.[task] ?? 0.5) : null;
	const cases = casesFor(corpus, run.split, task);
	const predictions = predictionsFor(run, task);
	const predicted = new Map<string, string>();
	let failed = 0;
	for (const c of cases) {
		const p = predictions.get(c.key);
		if (p?.outcome === 'failed') failed++;
		const cls = p ? predictedClass(spec, p, threshold ?? 0.5) : undefined;
		if (cls !== undefined) predicted.set(c.key, cls);
	}

	const points: BinaryPoint[] = [];
	const distributions: { distribution: Record<string, number>; label: string }[] = [];
	const stamps = new Set<boolean>();
	for (const c of cases) {
		const p = predictions.get(c.key);
		if (p?.outcome !== 'answered' || p.probability === undefined) continue;
		if (p.isCalibrated !== undefined) stamps.add(p.isCalibrated);
		points.push({
			p: p.probability,
			y:
				spec.questionType === 'noul'
					? c.label === spec.classes[0]
					: predicted.get(c.key) === c.label,
		});
		if (p.distribution) distributions.push({ distribution: p.distribution, label: c.label });
	}
	const bins = reliability(points, options.bins);

	const errors: ConsequentialError[] = [];
	for (const c of cases) {
		const cls = predicted.get(c.key);
		if (cls === undefined) continue;
		const label = c.rejected ? 'rejected' : c.label;
		if (!spec.consequential.isError(label, cls)) continue;
		const probability = predictions.get(c.key)?.probability;
		errors.push({
			threadId: c.threadId,
			messageId: c.messageId,
			...(c.draftId ? { draftId: c.draftId } : {}),
			label: c.label,
			predicted: cls,
			...(probability !== undefined ? { probability } : {}),
		});
	}

	return {
		task,
		questionType: spec.questionType,
		probability: spec.questionType === 'noul' ? 'noul_probability' : 'choice_peakedness',
		threshold,
		...sliceScore(spec, cases, predicted),
		failed,
		byLanguage: byLanguage(spec, cases, predicted),
		calibration: {
			adapters:
				stamps.size === 0
					? 'none'
					: stamps.size === 2
						? 'mixed'
						: stamps.has(true)
							? 'calibrated'
							: 'uncalibrated',
			brier: brierBinary(points),
			distributionBrier: spec.questionType === 'choice' ? brierMulticlass(distributions) : null,
			reliability: bins.bins,
			ece: bins.ece,
		},
		consequential: {
			description: spec.consequential.description,
			errors,
			rate: wilson(errors.length, predicted.size),
			upper95WhenNoneObserved: errors.length === 0 ? zeroFailureUpper95(predicted.size) : null,
		},
		...baselineAndAgreement(spec, task, cases, predicted, options),
	};
}

function baselineAndAgreement(
	spec: TaskSpec,
	task: DecisionEvalTask,
	cases: readonly Case[],
	predicted: ReadonlyMap<string, string>,
	options: ScoreOptions
): Pick<DecisionTaskReport, 'baseline' | 'agreement'> {
	const baselineRun = options.baseline;
	const theirs = baselineRun ? predictionsFor(baselineRun, task) : new Map();
	if (!baselineRun || theirs.size === 0) return { baseline: null, agreement: null };
	const baselinePredicted = new Map<string, string>();
	let failed = 0;
	for (const c of cases) {
		const p = theirs.get(c.key);
		if (p?.outcome === 'failed') failed++;
		const cls = p ? predictedClass(spec, p, 0.5) : undefined;
		if (cls !== undefined) baselinePredicted.set(c.key, cls);
	}
	const pairs = cases
		.filter((c) => predicted.has(c.key) && baselinePredicted.has(c.key))
		.map((c) => [predicted.get(c.key) as string, baselinePredicted.get(c.key) as string] as const);
	return {
		baseline: {
			executor: baselineRun.executor,
			failed,
			...sliceScore(spec, cases, baselinePredicted),
		},
		agreement: {
			compared: pairs.length,
			rate: wilson(pairs.filter(([a, b]) => a === b).length, pairs.length),
			kappa: cohensKappa(pairs),
			confusion: confusion(pairs),
		},
	};
}
