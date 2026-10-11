/**
 * The decision eval runner: asks an INJECTED decision provider the eval's
 * question sets (`decisionQuestions.ts`) about every labelled message of one
 * split, and keeps what came back as predictions plus one ledger-shaped row per
 * provider request (`callInventory.ts` reads those rows the way it reads the
 * real ledger).
 *
 * Nothing here reaches a network. A live run wraps a real adapter
 * (`lib/decisionProviders/*`) in {@link decisionProviderFromAdapter} inside the
 * CLI (`apps/api/scripts/ai-baseline-eval.ts`); tests pass a mocked provider.
 * A provider that throws is an outage, not a wrong answer: the attempt is
 * recorded, retried up to `maxAttempts`, and the prediction is kept as
 * `failed` so the report counts it separately from errors of judgment.
 *
 * Pure and isolate-safe.
 */
import type { TokenUsage } from '../../../agent/steps/types';
import type { QuestionSet } from '../../../lib/decision/questions';
import type { LanguageModel } from 'ai';
import type {
	DecisionProviderAdapter,
	DecisionRequest,
	DecisionResult,
	DecisionState,
} from '../../../lib/decisionProviders/types';
import type { ProviderClientConfig } from '../../../lib/llmProviders/types';
import { estimateCost } from '../../../lib/llm/pricing';
import type { EvalThread } from './corpus';
import type { DecisionLabel, EvalSplit } from './decisionLabels';
import {
	EVAL_DECISION_BUNDLES,
	decisionInputFor,
	draftState,
	threadState,
	triageState,
	type DecisionEvalBundles,
	type DecisionEvalInput,
} from './decisionQuestions';
import type { LedgerCallRow } from './callInventory';
import { threadsInSplit } from './splits';

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

/** A decision provider the runner can ask. Exactly one request per call. */
export interface EvalDecisionProvider {
	readonly name: string;
	/**
	 * The adapter retries inside `ask` (the language-backed one does, through
	 * `runLlmObject`). The runner then makes one request per round trip, as the
	 * decision dispatch does, and its rows undercount those inner retries.
	 */
	readonly handlesRetries?: boolean;
	ask(request: { state: DecisionState; questions: QuestionSet }): Promise<DecisionResult>;
}

/**
 * Wrap a registered adapter and its client config (a live run; tests pass a
 * mock provider instead). The language-backed adapter (`llm`) reads the
 * resolved language model off the request, as the decision dispatch supplies
 * it; pass it as `languageModel`.
 */
export function decisionProviderFromAdapter(
	adapter: DecisionProviderAdapter,
	config: ProviderClientConfig,
	options: { modelId?: string; languageModel?: LanguageModel } = {}
): EvalDecisionProvider {
	const { modelId, languageModel } = options;
	const model =
		languageModel === undefined
			? (modelId ?? adapter.defaultModel)
			: typeof languageModel === 'string'
				? languageModel
				: languageModel.modelId;
	return {
		name: `${adapter.kind}:${model}`,
		handlesRetries: adapter.handlesRetries,
		ask: ({ state, questions }) =>
			adapter.ask(config, {
				state,
				questions,
				...(modelId ? { modelId } : {}),
				...(languageModel === undefined ? {} : { model: languageModel }),
			} as DecisionRequest),
	};
}

/** One answer to one task about one message (or one draft). */
export interface DecisionPrediction {
	task: DecisionEvalTask;
	threadId: string;
	messageId: string;
	draftId?: string;
	locale: EvalThread['locale'];
	outcome: 'answered' | 'failed';
	/** Choice tasks: the chosen option. Noul tasks derive theirs from `probability`. */
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

/** The ledger task a round trip records under (the task-policy catalog's names). */
const LEDGER_TASK = {
	triage: 'mail.triage',
	message: 'mail.category',
	necessity: 'mail.necessity',
	draft: 'mail.draft_quality',
} as const;

/** `eval.<executor>.<surface>`: the call-inventory path of an eval message. */
export function evalRootRequestId(
	executor: 'decision' | 'today',
	input: Pick<DecisionEvalInput, 'mode' | 'threadId' | 'messageId'>
): string {
	const surface = input.mode === 'actions' ? 'team' : 'postbox';
	return `eval.${executor}.${surface}:${input.threadId}/${input.messageId}`;
}

export interface DecisionRunOptions {
	provider: EvalDecisionProvider;
	split: EvalSplit | 'all';
	bundles?: DecisionEvalBundles;
	/** Requests per round trip, the first included; 1 when the provider retries itself. */
	maxAttempts?: number;
	/** Wall clock for `latencyMs`; injected so tests stay deterministic. */
	now?: () => number;
	/** Wait before a retry; injected so tests do not wait. Default: 1 s × the attempt just failed. */
	sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAY_MS = 1000;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An error as a short, single string for a report. */
export const errorText = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 200);

function tokenRow(usage: TokenUsage | undefined) {
	return {
		promptTokens: usage?.promptTokens ?? 0,
		completionTokens: usage?.completionTokens ?? 0,
		totalTokens: usage?.totalTokens ?? 0,
	};
}

/** Ask every labelled message (and draft) of the split. Sequential: a run is rate-friendly. */
export async function runDecisionEval(
	corpus: readonly EvalThread[],
	options: DecisionRunOptions
): Promise<DecisionRun> {
	const bundles = options.bundles ?? EVAL_DECISION_BUNDLES;
	const maxAttempts = options.provider.handlesRetries ? 1 : Math.max(1, options.maxAttempts ?? 2);
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? realSleep;
	const run: DecisionRun = {
		executor: options.provider.name,
		split: options.split,
		predictions: [],
		rows: [],
	};

	const ask = async (
		input: DecisionEvalInput,
		kind: keyof typeof LEDGER_TASK,
		state: DecisionState,
		questions: QuestionSet,
		suffix = ''
	): Promise<{ result?: DecisionResult; error?: string }> => {
		const rootRequestId = evalRootRequestId('decision', input);
		const requestId = `${rootRequestId}#${kind}${suffix}`;
		let error = 'no attempt';
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (attempt > 1) await sleep(RETRY_DELAY_MS * (attempt - 1));
			const started = now();
			const base = {
				feature: `eval.${LEDGER_TASK[kind]}`,
				plane: 'decision' as const,
				rootRequestId,
				requestId,
				task: LEDGER_TASK[kind],
				attempt,
			};
			try {
				const result = await options.provider.ask({ state, questions });
				const cost = estimateCost(result.modelUsed, result.usage);
				run.rows.push({
					...base,
					...tokenRow(result.usage),
					modelUsed: result.modelUsed,
					endpoint: result.provenance,
					costUsd: cost.costUsd,
					isEstimated: cost.estimated,
					latencyMs: now() - started,
				});
				return { result };
			} catch (caught) {
				error = errorText(caught);
				// A failed request may still have been billed; with no usage there is
				// nothing to price, and the row says the cost is not reported usage.
				run.rows.push({
					...base,
					...tokenRow(undefined),
					costUsd: 0,
					isEstimated: true,
					latencyMs: now() - started,
				});
			}
		}
		return { error };
	};

	const record = (
		input: DecisionEvalInput,
		task: DecisionEvalTask,
		outcome: { result?: DecisionResult; error?: string },
		read: (answers: DecisionResult['answers']) => Partial<DecisionPrediction>,
		draftId?: string
	) => {
		const base = {
			task,
			threadId: input.threadId,
			messageId: input.messageId,
			locale: input.locale,
			...(draftId ? { draftId } : {}),
		};
		if (!outcome.result) {
			run.predictions.push({ ...base, outcome: 'failed', error: outcome.error });
			return;
		}
		try {
			run.predictions.push({
				...base,
				outcome: 'answered',
				isCalibrated: outcome.result.calibrated,
				...read(outcome.result.answers),
			});
		} catch (caught) {
			run.predictions.push({ ...base, outcome: 'failed', error: errorText(caught) });
		}
	};

	const askMessage = async (thread: EvalThread, label: DecisionLabel) => {
		const input = decisionInputFor(thread, label);
		const triage = await ask(input, 'triage', triageState(input), bundles.triage);
		record(input, 'triage', triage, (answers) => readChoice(answers, 'triage'));

		const isTeam = thread.mode === 'actions';
		const message = await ask(
			input,
			'message',
			threadState(input),
			isTeam ? bundles.teamMessage : bundles.postboxMessage
		);
		record(input, isTeam ? 'team_category' : 'postbox_category', message, (answers) =>
			readChoice(answers, 'category')
		);
		record(input, 'disposition', message, (answers) => readNoul(answers, 'disposition'));

		// Necessity is scored on reply messages only, so it is asked only there.
		// Production asks it only after a reply disposition: this call count is an
		// upper bound on the necessity calls a message costs.
		if (label.clarification) {
			const necessity = await ask(input, 'necessity', threadState(input), bundles.necessity);
			record(input, 'necessity', necessity, (answers) => readNoul(answers, 'necessity'));
		}
		for (const draft of label.drafts ?? []) {
			const verdict = await ask(
				input,
				'draft',
				draftState(input, draft.text),
				bundles.draftQuality,
				`:${draft.id}`
			);
			record(
				input,
				'draft_quality',
				verdict,
				(answers) => readNoul(answers, 'acceptable'),
				draft.id
			);
		}
	};

	for (const thread of threadsInSplit(corpus, options.split)) {
		for (const label of thread.labels.decisions) await askMessage(thread, label);
	}
	return run;
}

/** A Choice answer as a prediction; throws when the key holds anything else. */
function readChoice(answers: DecisionResult['answers'], key: string): Partial<DecisionPrediction> {
	const answer = answers[key];
	if (answer?.kind !== 'choice') throw new Error(`answer ${key} is not a choice`);
	return {
		value: answer.value,
		probability: answer.confidence,
		distribution: { ...answer.probabilities },
	};
}

/** A Noul answer as a prediction; throws when the key holds anything else. */
function readNoul(answers: DecisionResult['answers'], key: string): Partial<DecisionPrediction> {
	const answer = answers[key];
	if (answer?.kind !== 'noul') throw new Error(`answer ${key} is not a noul`);
	return { probability: answer.probability };
}
