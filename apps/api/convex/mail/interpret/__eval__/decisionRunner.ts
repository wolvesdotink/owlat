'use node';

/**
 * The decision eval runner: asks an INJECTED decision provider the eval's
 * question sets (`decisionQuestions.ts`) about every labelled message of one
 * split, and keeps what came back as predictions plus one priced,
 * ledger-shaped row per provider request (`decisionRun.ts`), which
 * `callInventory.ts` reads the way it reads the real ledger.
 *
 * Nothing here reaches a network. A live run builds its provider in
 * `evalProviders.ts`; tests pass a mocked one. The provider contract is one
 * request per `ask`, so a row is a request.
 *
 * Failures follow the decision dispatch (`lib/decision/dispatch.ts`): a failed
 * request's billed usage (a rejected answer, a language call whose completions
 * never fitted) is priced off the error, a failure the dispatch would not retry
 * (`isRetriableDecisionError`: codec refusals, an adapter's `retriable: false`,
 * 401/403/422) is not retried, and anything else is retried up to
 * `maxAttempts` with a growing wait. A round trip that still fails keeps its
 * predictions as `failed`, which the report counts apart from wrong answers.
 *
 * `'use node'` because the dispatch module it shares those rules with is.
 */
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { billedUsage, isRetriableDecisionError } from '../../../lib/decision/dispatch';
import type { QuestionSet } from '../../../lib/decision/questions';
import type { DecisionResult, DecisionState } from '../../../lib/decisionProviders/types';
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
import {
	errorText,
	evalRootRequestId,
	pricedColumns,
	type DecisionEvalTask,
	type DecisionPrediction,
	type DecisionRun,
	type EvalDecisionProvider,
} from './decisionRun';
import { threadsInSplit } from './splits';

/**
 * The ledger task a round trip records under (the task-policy catalog's
 * names). The category bundle carries the disposition question too, and one
 * row has one task: it records as `mail.category`.
 */
const LEDGER_TASK = {
	triage: 'mail.triage',
	message: 'mail.category',
	necessity: 'mail.necessity',
	draft: 'mail.draft_quality',
} as const satisfies Record<string, AiTaskName>;

export interface DecisionRunOptions {
	provider: EvalDecisionProvider;
	split: EvalSplit | 'all';
	bundles?: DecisionEvalBundles;
	/** Requests per round trip, the first included. */
	maxAttempts?: number;
	/** Wall clock for `latencyMs`; injected so tests stay deterministic. */
	now?: () => number;
	/** Wait before a retry; injected so tests do not wait. Default: 1 s × the attempt just failed. */
	sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAY_MS = 1000;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Ask every labelled message (and draft) of the split. Sequential: a run is rate-friendly. */
export async function runDecisionEval(
	corpus: readonly EvalThread[],
	options: DecisionRunOptions
): Promise<DecisionRun> {
	const bundles = options.bundles ?? EVAL_DECISION_BUNDLES;
	const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
	const isLocal = options.provider.isLocal === true;
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
				run.rows.push({
					...base,
					...pricedColumns({
						usage: result.usage,
						modelUsed: result.modelUsed,
						isLocal: isLocal || result.provenance === 'local',
					}),
					endpoint: result.provenance,
					latencyMs: now() - started,
				});
				return { result };
			} catch (caught) {
				error = errorText(caught);
				// What the failed request was billed for, when the error says.
				const billed = billedUsage(caught);
				run.rows.push({
					...base,
					...pricedColumns({ ...billed, isLocal }),
					latencyMs: now() - started,
				});
				if (!isRetriableDecisionError(caught)) break;
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
			triageState(input),
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
