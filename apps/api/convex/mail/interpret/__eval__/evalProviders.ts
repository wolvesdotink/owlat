'use node';

/**
 * The live executors the baseline script (`apps/api/scripts/ai-baseline-eval.ts`)
 * runs, built so that one provider request is one ledger row and every billed
 * request is priced:
 *
 *   - {@link decisionProviderFromAdapter}: a registered decision adapter that
 *     makes one request per `ask` (`typesafe`, `local`). An adapter that
 *     retries inside `ask` would hide requests from the inventory, so it is
 *     refused;
 *   - {@link llmEvalDecisionProvider}: the language-backed decision plane
 *     (`lib/decisionProviders/llm.ts`) with exactly ONE dispatch attempt per
 *     `ask`, using that adapter's own schema, prompt and answer mapping, and its
 *     rule that a rejected answer was still billed;
 *   - {@link languageEvalGenerates}: the language model behind today's
 *     classifiers and the live interpretation run, one attempt per call, its
 *     usage priced and passed through.
 *
 * The model call is injected (`RunObject`, `runLlmObject`'s shape) so tests
 * never reach a provider.
 */
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import type { TokenUsage } from '../../../agent/steps/types';
import type { AnswersFor, QuestionSet } from '../../../lib/decision/questions';
import {
	mapAnswers,
	renderDecisionPrompt,
	renderDecisionSchema,
} from '../../../lib/decisionProviders/llm';
import type {
	DecisionProviderAdapter,
	DecisionRequest,
} from '../../../lib/decisionProviders/types';
import { DecisionWireError } from '../../../lib/decisionProviders/wire';
import type { ProviderClientConfig } from '../../../lib/llmProviders/types';
import { estimateCost } from '../../../lib/llm/pricing';
import type { EvalDecisionProvider } from './decisionRun';
import type { EvalGenerate } from './liveModel';
import type { TodayGenerate } from './todayClassifier';

/** One structured model call: `runLlmObject`'s shape. */
export type RunObject = (options: {
	model: LanguageModel;
	schema: z.ZodTypeAny;
	prompt: string;
	temperature: number;
	maxAttempts: number;
}) => Promise<{ object: unknown; tokenUsage?: TokenUsage; modelUsed?: string }>;

const modelIdOf = (model: LanguageModel) => (typeof model === 'string' ? model : model.modelId);

/**
 * Wrap a registered adapter that makes one request per `ask`. The
 * language-backed adapter retries inside `ask`; use
 * {@link llmEvalDecisionProvider} for it.
 */
export function decisionProviderFromAdapter(
	adapter: DecisionProviderAdapter,
	config: ProviderClientConfig,
	modelId?: string
): EvalDecisionProvider {
	if (adapter.handlesRetries) {
		throw new Error(
			`The ${adapter.kind} decision adapter retries inside ask, so its requests would not each get a row; ` +
				'run it through llmEvalDecisionProvider.'
		);
	}
	return {
		name: `${adapter.kind}:${modelId ?? adapter.defaultModel}`,
		isLocal: adapter.isLocal,
		ask: ({ state, questions }) =>
			adapter.ask(config, {
				state,
				questions,
				...(modelId ? { modelId } : {}),
			} as DecisionRequest),
	};
}

/** The language-backed decision plane, one dispatch attempt per `ask`. */
export function llmEvalDecisionProvider(
	run: RunObject,
	model: LanguageModel
): EvalDecisionProvider {
	return {
		name: `llm:${modelIdOf(model)}`,
		async ask({ state, questions }) {
			// A failed attempt's billed usage rides on the error the dispatch throws
			// (`LlmPartialUsageError`); the runner prices it off there.
			const dispatched = await run({
				model,
				schema: renderDecisionSchema(questions),
				prompt: renderDecisionPrompt(state, questions),
				temperature: 0,
				maxAttempts: 1,
			});
			const usage = dispatched.tokenUsage ?? {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
			};
			const modelUsed = dispatched.modelUsed ?? modelIdOf(model);
			let answers;
			try {
				answers = mapAnswers(questions, dispatched.object);
			} catch (error) {
				// A rejected answer was still billed, as in the adapter.
				if (error instanceof DecisionWireError) {
					throw new DecisionWireError(error.message, { usage, modelUsed });
				}
				throw error;
			}
			return {
				answers: answers as AnswersFor<QuestionSet>,
				usage,
				modelUsed,
				provenance: 'llm-backed',
				calibrated: false,
			};
		},
	};
}

/** Today's classifier calls and the live interpretation calls on one language model. */
export function languageEvalGenerates(
	run: RunObject,
	model: LanguageModel
): { today: TodayGenerate; interpret: EvalGenerate } {
	const modelId = modelIdOf(model);
	return {
		today: async ({ prompt, schema, temperature }) => {
			const { object, tokenUsage, modelUsed } = await run({
				model,
				schema,
				prompt,
				temperature,
				maxAttempts: 1,
			});
			return {
				object,
				...(tokenUsage ? { usage: tokenUsage } : {}),
				modelUsed: modelUsed ?? modelId,
			};
		},
		interpret: async ({ prompt, schema }) => {
			const { object, tokenUsage, modelUsed } = await run({
				model,
				schema,
				prompt,
				temperature: 0,
				maxAttempts: 1,
			});
			return { object, costUsd: estimateCost(modelUsed ?? modelId, tokenUsage).costUsd };
		},
	};
}
