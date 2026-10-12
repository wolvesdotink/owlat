/**
 * The task-policy catalog as the model eligibility rule (ADR-0073): the
 * resolver takes a task's tier from it, and the dispatch refuses a resolved
 * model whose tier the call's task does not allow, before any request.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../_generated/server';
import { MockLanguageModelV3 } from 'ai/test';
import { AI_TASK_NAMES } from '@owlat/shared/aiRouting';
import { TASK_POLICIES } from '../taskPolicy';
import { isTierEligible, taskTier, TaskTierNotEligibleError, userTextTier } from '../taskRouting';
import { stampModelEndpoint } from '../modelEndpoint';
import { LlmCallMeter } from '../requestMeter';
import { callShape } from '../callShape';
import { runLlmText } from '../dispatch';
import { resolveLanguageModel } from '../../llmProvider';
import { __resetAiConfigCacheForTests } from '../../llmProvider';

describe('taskTier', () => {
	it('is the usual tier (the first listed) of every language and decision task', () => {
		for (const task of AI_TASK_NAMES) {
			const entry = TASK_POLICIES[task];
			if (entry.plane === 'embedding') continue;
			expect(taskTier(task)).toBe(entry.tiers[0]);
		}
	});

	it('takes a named tier only when the catalog lists it for the task', () => {
		expect(taskTier('mail.clarify', { tier: 'capable' })).toBe('capable');
		expect(taskTier('mail.draft', { tier: 'fast' })).toBe('fast');
		expect(() => taskTier('mail.guard', { tier: 'capable' })).toThrow(TaskTierNotEligibleError);
		expect(() => taskTier('mail.ask', { tier: 'fast' })).toThrow(TaskTierNotEligibleError);
		expect(() => taskTier('embedding.query')).toThrow(TaskTierNotEligibleError);
	});

	it('downgrades owner text only for a capable task that also allows fast', () => {
		expect(userTextTier('mail.compose', 'thanks!', true)).toBe('fast');
		expect(userTextTier('mail.compose', 'thanks!', false)).toBe('capable');
		// `mail.ask` runs on the capable tier only: never downgraded.
		expect(userTextTier('mail.ask', 'thanks!', true)).toBe('capable');
		// A fast task stays fast.
		expect(userTextTier('mail.coach', 'thanks!', true)).toBe('fast');
	});

	it('the decision plane runs on the fast tier, as the language-backed adapter always has', () => {
		for (const task of AI_TASK_NAMES) {
			if (TASK_POLICIES[task].plane !== 'decision') continue;
			expect(isTierEligible(task, 'fast')).toBe(true);
			expect(isTierEligible(task, 'capable')).toBe(false);
		}
	});
});

describe('dispatch model eligibility', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		__resetAiConfigCacheForTests();
	});

	it('refuses a model the resolver produced for a fast task when the call is a capable-only task', async () => {
		vi.stubEnv('OPENAI_API_KEY', 'sk-test');
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const ctx = { runQuery: vi.fn(async () => null) } as unknown as ActionCtx;
		const fast = await resolveLanguageModel(ctx, 'mail.classify');
		const meter = new LlmCallMeter({ task: 'mail.ask' });
		await expect(runLlmText({ meter, model: fast, prompt: 'p', maxAttempts: 1 })).rejects.toThrow(
			TaskTierNotEligibleError
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(meter.requests).toHaveLength(0);
		// The same resolver's capable model passes the check (and reaches the transport).
		const capable = await resolveLanguageModel(ctx, 'mail.ask');
		expect(() => callShape({ model: capable, meter })).not.toThrow();
	});

	function model(): MockLanguageModelV3 {
		return new MockLanguageModelV3({
			modelId: 'm',
			doGenerate: async () => ({
				content: [{ type: 'text', text: 'ok' }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 1, text: 1, reasoning: undefined },
				},
				warnings: [],
			}),
		});
	}

	it('refuses a fast-tier model for a capable-only task before any request', async () => {
		const fast = stampModelEndpoint(model(), 'openai-native', { tier: 'fast' });
		const generate = vi.spyOn(fast, 'doGenerate');
		const meter = new LlmCallMeter({ task: 'mail.ask' });
		await expect(runLlmText({ meter, model: fast, prompt: 'p' })).rejects.toThrow(
			TaskTierNotEligibleError
		);
		expect(generate).not.toHaveBeenCalled();
		expect(meter.requests).toHaveLength(0);
	});

	it('lets an eligible tier, an unstamped model or an untasked call through', async () => {
		const fast = stampModelEndpoint(model(), 'openai-native', { tier: 'fast' });
		await expect(
			runLlmText({ meter: new LlmCallMeter({ task: 'mail.draft' }), model: fast, prompt: 'p' })
		).resolves.toMatchObject({ text: 'ok' });
		expect(() =>
			callShape({ model: model(), meter: new LlmCallMeter({ task: 'mail.ask' }) })
		).not.toThrow();
		expect(() => callShape({ model: fast, meter: new LlmCallMeter() })).not.toThrow();
	});
});
