/**
 * The live executors with a mocked model call: one dispatch attempt per
 * request, billed usage kept on failure, and paid usage priced.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
	DecisionProviderAdapter,
	DecisionResult,
} from '../../../../lib/decisionProviders/types';
import { DecisionWireError } from '../../../../lib/decisionProviders/wire';
import { LlmPartialUsageError } from '../../../../lib/llm/partialUsage';
import { estimateCost } from '../../../../lib/llm/pricing';
import { TRIAGE_QUESTIONS } from '../decisionQuestions';
import { runDecisionEval } from '../decisionRunner';
import {
	decisionProviderFromAdapter,
	languageEvalGenerates,
	llmEvalDecisionProvider,
	type RunObject,
} from '../evalProviders';
import { loadCorpus } from './corpusFixture';

const usage = { promptTokens: 1200, completionTokens: 60, totalTokens: 1260 };
const model = 'gpt-6-luna';

describe('decisionProviderFromAdapter', () => {
	const ask = vi.fn(async () => ({}) as DecisionResult);
	const adapter = (patch: Partial<DecisionProviderAdapter>) =>
		({
			kind: 'typesafe',
			defaultModel: 'jev-1',
			handlesRetries: false,
			isLocal: false,
			ask,
			...patch,
		}) as DecisionProviderAdapter;

	it('asks the adapter with its config and the pinned model, one request per ask', async () => {
		const provider = decisionProviderFromAdapter(adapter({}), { apiKey: 'k' }, 'jev-2');
		expect(provider).toMatchObject({ name: 'typesafe:jev-2', isLocal: false });
		await provider.ask({ state: 's', questions: {} });
		expect(ask).toHaveBeenLastCalledWith(
			{ apiKey: 'k' },
			{ state: 's', questions: {}, modelId: 'jev-2' }
		);
		const local = decisionProviderFromAdapter(adapter({ kind: 'local', isLocal: true }), {});
		expect(local).toMatchObject({ name: 'local:jev-1', isLocal: true });
	});

	it('refuses an adapter that retries inside ask: its requests would share one row', () => {
		expect(() =>
			decisionProviderFromAdapter(adapter({ kind: 'llm', handlesRetries: true }), {})
		).toThrow(/llmEvalDecisionProvider/);
	});
});

describe('llmEvalDecisionProvider', () => {
	it('makes exactly one dispatch attempt per ask with the adapter’s schema and prompt', async () => {
		const run = vi.fn<RunObject>(async () => ({
			object: { triage: 'spam' },
			tokenUsage: usage,
			modelUsed: model,
		}));
		const provider = llmEvalDecisionProvider(run, model);
		const result = await provider.ask({ state: { subject: 'x' }, questions: TRIAGE_QUESTIONS });
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0]).toMatchObject({ model, temperature: 0, maxAttempts: 1 });
		expect(run.mock.calls[0]?.[0].prompt).toContain('subject');
		expect(result).toMatchObject({
			usage,
			modelUsed: model,
			provenance: 'llm-backed',
			calibrated: false,
		});
		expect(result.answers['triage']).toMatchObject({ kind: 'choice', value: 'spam' });
	});

	it('keeps a rejected answer’s billed usage on the error, and the runner prices it', async () => {
		const run: RunObject = async () => ({
			object: { triage: 'nonsense' },
			tokenUsage: usage,
			modelUsed: model,
		});
		const provider = llmEvalDecisionProvider(run, model);
		const error = await provider
			.ask({ state: 's', questions: TRIAGE_QUESTIONS })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DecisionWireError);
		expect(error).toMatchObject({ usage, modelUsed: model });
	});

	it('gives the runner one row per real request, billed failures included', async () => {
		const corpus = loadCorpus().filter((t) => t.id === 'cc-001');
		let calls = 0;
		const run: RunObject = async ({ schema }) => {
			calls++;
			if (calls === 1) throw new LlmPartialUsageError(new Error('503 overloaded'), usage, model);
			const shape = (schema as { shape?: Record<string, unknown> }).shape ?? {};
			const object = Object.fromEntries(
				Object.keys(shape).map((key) => [
					key,
					key === 'triage' ? 'no_work' : key === 'category' ? 'person' : true,
				])
			);
			return { object, tokenUsage: usage, modelUsed: model };
		};
		const result = await runDecisionEval(corpus, {
			provider: llmEvalDecisionProvider(run, model),
			split: 'all',
			sleep: async () => {},
		});
		expect(result.rows).toHaveLength(calls);
		const priced = estimateCost(model, usage).costUsd;
		expect(result.rows.every((r) => r.promptTokens === 1200 && r.costUsd === priced)).toBe(true);
		expect(result.rows[0]).toMatchObject({ task: 'mail.triage', attempt: 1 });
		expect(result.rows[1]).toMatchObject({ task: 'mail.triage', attempt: 2 });
	});
});

describe('languageEvalGenerates', () => {
	const run = vi.fn<RunObject>(async () => ({
		object: { ok: true },
		tokenUsage: usage,
		modelUsed: model,
	}));

	it('prices a live interpretation call and passes the cost through', async () => {
		const { interpret } = languageEvalGenerates(run, model);
		const { costUsd } = await interpret({ prompt: 'p', schema: {} as never });
		expect(costUsd).toBe(estimateCost(model, usage).costUsd);
		expect(costUsd).toBeGreaterThan(0);
		expect(run).toHaveBeenLastCalledWith(
			expect.objectContaining({ temperature: 0, maxAttempts: 1 })
		);
	});

	it('hands today’s classifier its usage and model, one attempt per call', async () => {
		const { today } = languageEvalGenerates(run, model);
		const result = await today({
			prompt: 'p',
			schema: {} as never,
			temperature: 0.2,
			feature: 'agent_classify',
		});
		expect(result).toEqual({ object: { ok: true }, usage, modelUsed: model });
		expect(run).toHaveBeenLastCalledWith(
			expect.objectContaining({ temperature: 0.2, maxAttempts: 1 })
		);
	});
});
