/**
 * What a decision-eval run is, independent of who ran it: the tasks it scores,
 * one prediction per task and message, the provider seam, the eval's root
 * request ids, and how one provider request becomes one priced ledger row.
 * The runners (`decisionRunner.ts`, `todayClassifier.ts`) fill a
 * {@link DecisionRun}; the scorer and the report read it.
 *
 * Pricing a request, in order:
 *   - the operator's own engine (local provenance) bills nothing: cost 0,
 *     tokens kept, not an estimate (the ledger's `isLocalEngine`);
 *   - a request with billed usage, from an answer or carried by the error it
 *     failed with, is priced from the shared table (`lib/llm/pricing.ts`);
 *   - a failed request with no usage cost something we cannot see: cost 0,
 *     marked `isEstimated`.
 *
 * Pure and isolate-safe.
 */
import type { TokenUsage } from '../../../agent/steps/types';
import type { QuestionSet } from '../../../lib/decision/questions';
import type { DecisionResult, DecisionState } from '../../../lib/decisionProviders/types';
import { estimateCost } from '../../../lib/llm/pricing';
import type { LedgerCallRow } from './callInventory';
import type { EvalThread } from './corpus';
import type { EvalSplit } from './decisionLabels';

/** The tasks the decision report scores. */
export const DECISION_EVAL_TASKS = [
	'triage',
	'postbox_category',
	'team_category',
	'disposition',
	'necessity',
	'draft_quality',
] as const;
export type DecisionEvalTask = (typeof DECISION_EVAL_TASKS)[number];

/** A decision provider the runner can ask. One `ask` must be exactly one provider request. */
export interface EvalDecisionProvider {
	readonly name: string;
	/** The engine runs on the operator's own hardware: its requests cost nothing. */
	readonly isLocal?: boolean;
	ask(request: { state: DecisionState; questions: QuestionSet }): Promise<DecisionResult>;
}

/** One answer to one task about one message (or one draft). */
export interface DecisionPrediction {
	task: DecisionEvalTask;
	threadId: string;
	messageId: string;
	draftId?: string;
	locale: EvalThread['locale'];
	outcome: 'answered' | 'failed';
	/** Choice tasks and today's classifier: the chosen class. Noul tasks derive theirs from `probability`. */
	value?: string;
	/**
	 * Noul tasks: the Noul probability that the statement is true. Choice tasks:
	 * the Choice confidence (how peaked the distribution is), which is what a
	 * Choice threshold reads. The report names which one it scored.
	 */
	probability?: number;
	/** Choice tasks: the full distribution over the options sent. */
	distribution?: Record<string, number>;
	/** The answering adapter stamped its probabilities calibrated. */
	isCalibrated?: boolean;
	error?: string;
}

export interface DecisionRun {
	executor: string;
	split: EvalSplit | 'all';
	predictions: DecisionPrediction[];
	/** One row per provider request, in the ledger's own field names. */
	rows: LedgerCallRow[];
}

/** `eval.<executor>.<surface>`: the call-inventory path of an eval message. */
export function evalRootRequestId(
	executor: 'decision' | 'today',
	input: { mode: EvalThread['mode']; threadId: string; messageId: string }
): string {
	const surface = input.mode === 'actions' ? 'team' : 'postbox';
	return `eval.${executor}.${surface}:${input.threadId}/${input.messageId}`;
}

/** An error as a short, single string for a report. */
export const errorText = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 200);

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Usage that can be priced: three finite, non-negative counts; anything else is no usage. */
export function validUsage(usage: unknown): TokenUsage | undefined {
	const u = usage as Partial<TokenUsage> | null | undefined;
	if (!u || !isCount(u.promptTokens) || !isCount(u.completionTokens)) return undefined;
	return {
		promptTokens: u.promptTokens,
		completionTokens: u.completionTokens,
		totalTokens: isCount(u.totalTokens) ? u.totalTokens : u.promptTokens + u.completionTokens,
	};
}

/** The token, model and cost columns of one provider request's row. */
export function pricedColumns(request: {
	usage?: unknown;
	modelUsed?: string;
	isLocal: boolean;
}): Pick<
	LedgerCallRow,
	'promptTokens' | 'completionTokens' | 'totalTokens' | 'costUsd' | 'isEstimated' | 'modelUsed'
> & { isLocalEngine?: true } {
	const usage = validUsage(request.usage);
	const tokens = {
		promptTokens: usage?.promptTokens ?? 0,
		completionTokens: usage?.completionTokens ?? 0,
		totalTokens: usage?.totalTokens ?? 0,
		...(request.modelUsed ? { modelUsed: request.modelUsed } : {}),
	};
	if (request.isLocal) return { ...tokens, costUsd: 0, isEstimated: false, isLocalEngine: true };
	if (!usage) return { ...tokens, costUsd: 0, isEstimated: true };
	const cost = estimateCost(request.modelUsed, usage);
	return { ...tokens, costUsd: cost.costUsd, isEstimated: cost.estimated };
}
