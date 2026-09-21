import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../_generated/server';
import type { Doc } from '../../../_generated/dataModel';
import type { DecisionProviderKind, DecisionResult } from '../../decisionProviders/types';
import { noul } from '../questions';
import { runDecision } from '../dispatch';
import { __resetDecisionPlaneCacheForTests, resolveDecisionProvider } from '../../decisionProvider';

// A provider that does not exist in the production catalog: no key, its own
// model, a different latency budget, and no trusted list-price provenance.
const future = vi.hoisted(() => ({
	kind: 'future-local',
	label: 'Future local engine',
	docsUrl: '',
	defaultModel: 'future-v1',
	defaultDeadlineMs: 2345,
	defaultEndpointProvenance: 'custom',
	isLocal: true,
	requiresApiKey: false,
	handlesRetries: false,
	calibrated: false,
	validateCredentials: vi.fn(),
	ask: vi.fn(),
}));
vi.mock('../../decisionProviders', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../decisionProviders')>();
	return {
		...actual,
		decisionProviderFor: (kind: string) =>
			kind === future.kind ? future : actual.decisionProviderFor(kind as DecisionProviderKind),
	};
});
vi.mock('../../llmProvider', () => ({
	resolveLanguageModel: vi.fn(() => {
		throw new Error('Must not resolve the language plane');
	}),
}));

afterEach(() => {
	__resetDecisionPlaneCacheForTests();
	vi.clearAllMocks();
	future.handlesRetries = false;
});

describe('another decision adapter', () => {
	it('resolves and dispatches a keyless engine with its own model and deadline', async () => {
		const row = {
			_id: 'future-config',
			updatedAt: 1,
			decisionProviderKind: future.kind,
			decisionModel: 'future-v2',
			decisionBaseUrl: 'https://future.example',
		} as unknown as Doc<'aiProviderConfig'>;
		const ctx = { runQuery: vi.fn(async () => row), runAction: vi.fn() } as unknown as ActionCtx;
		const provider = await resolveDecisionProvider(ctx);
		expect(provider).toEqual({
			kind: future.kind,
			config: { baseUrl: 'https://future.example' },
			modelId: 'future-v2',
			deadlineMs: 2345,
		});
		expect(ctx.runAction).not.toHaveBeenCalled();
		future.ask.mockResolvedValue({
			answers: { ready: { kind: 'noul', probability: 0.8 } },
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			modelUsed: 'future-v2',
			provenance: 'custom',
			calibrated: false,
		} satisfies DecisionResult);
		await runDecision({
			provider,
			feature: 'future-test',
			state: 'ready',
			questions: { ready: noul('Ready?') },
			allowance: { allowed: true, fallbackAllowed: false },
		});
		expect(future.ask).toHaveBeenCalledWith(
			provider.config,
			expect.objectContaining({
				modelId: 'future-v2',
				deadlineMs: 2345,
			})
		);
	});

	it('does not multiply retries owned by a future adapter', async () => {
		future.handlesRetries = true;
		future.ask.mockRejectedValue(Object.assign(new Error('Unavailable'), { status: 503 }));
		await expect(
			runDecision({
				provider: { kind: future.kind as DecisionProviderKind, config: {} },
				feature: 'future-test',
				state: '',
				questions: { ready: noul('Ready?') },
				allowance: { allowed: true, fallbackAllowed: false },
				maxAttempts: 3,
			})
		).rejects.toThrow('Unavailable');
		expect(future.ask).toHaveBeenCalledTimes(1);
	});
});
