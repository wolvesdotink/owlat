/**
 * Sol r2 F2 (clarify lane): an interpretation run's one hold covers the
 * verification path that will actually run, planned before the extraction is
 * bought (`verifyRoute.ts planVerification`, `runHold.ts`).
 *
 * - Claim checks enforced on the decision rung: the hold covers the extraction
 *   and one claim check per claim, not the language verifier's maximum. Every
 *   claim check draws on it (its id and pre-assigned request id), asks for no
 *   hold of its own, and so cannot be refused after the extraction.
 * - Near the ceiling, that smaller hold is admitted where the language path's
 *   is not.
 * - The per-message cap lowers the hold to the claims it allows.
 *
 * Real interpretation and admission; the model, the decision provider and the
 * decision dispatch are mocked. Never a paid provider.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource } from '../sources';
import { reconcileSpend } from '../../../aiRouting/__tests__/spend.testlib';

const mocks = vi.hoisted(() => ({ runLlmObject: vi.fn(), runDecision: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return {
		...(await vi.importActual<object>('../../../lib/llm/dispatch')),
		runLlmObject: metered((opts: unknown) => mocks.runLlmObject(opts)),
	};
});
vi.mock('../../../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../../../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));
vi.mock('../../../lib/decisionProvider', async () => ({
	...(await vi.importActual<object>('../../../lib/decisionProvider')),
	resolveDecisionConfig: vi.fn(async () => ({
		kind: 'typesafe',
		clientConfig: {},
		modelId: 'jev-1.13.0',
		endpointProvenance: 'typesafe-native',
		calibrated: true,
		deadlineMs: 5_000,
		source: 'stored',
		isFallbackEnabled: false,
	})),
}));
vi.mock('../../../lib/decision/dispatch', async () => ({
	...(await vi.importActual<object>('../../../lib/decision/dispatch')),
	runDecision: (opts: unknown) => mocks.runDecision(opts),
}));

const TEXT = 'Could you send me the signed contract by Friday?';

const OUTPUT = {
	mode: 'brief',
	items: [
		{
			matchItemId: null,
			intent: 'request',
			facets: ['file'],
			consequences: ['signature'],
			assertion: 'Send the signed contract',
			display: { en: 'Send the signed contract', de: 'Schick den Vertrag' },
			requester: { ref: 'p1', name: null, email: null },
			responsible: { ref: null, name: null, email: 'me@owlat.test' },
			beneficiary: null,
			due: null,
			amount: null,
			options: null,
			quotes: [{ segmentId: 's0', text: 'send me the signed contract by Friday' }],
		},
	],
	transitions: [],
	replyIntent: 'request_for_action',
	urgency: 'normal',
	meetingIntent: null,
	coverage: { segmentsRead: ['s0'], uncertain: false, overflow: false },
	latest: { en: [], de: [] },
	facts: [],
};

beforeEach(() => {
	mocks.runLlmObject.mockReset();
	mocks.runDecision.mockReset();
	mocks.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) =>
		schema === briefModelSchema
			? { object: OUTPUT }
			: { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } }
	);
	mocks.runDecision.mockImplementation(async () => ({
		answers: {
			verdict: {
				kind: 'choice',
				value: 'supported',
				probabilities: { supported: 0.95 },
				confidence: 0.95,
			},
		},
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		modelUsed: 'jev-1.13.0',
		provenance: 'typesafe-native',
		calibrated: true,
		provider: 'typesafe',
		fallback: false,
		requestId: 'r',
		attempts: 1,
	}));
});
afterEach(() => {
	vi.unstubAllEnvs();
});

async function interpret(
	ceilingUsd: string,
	policy: Record<string, unknown>
): Promise<{ t: Test; out: Awaited<ReturnType<Test['action']>> }> {
	vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', ceilingUsd);
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['ai', 'ai.decisionPlane']);
	await t.run(async (ctx) => {
		await ctx.db.insert('aiRoutingPolicy', {
			...policy,
			policyVersion: 1,
			updatedAt: Date.now(),
			updatedBy: 'admin-1',
		});
	});
	await reconcileSpend(t);
	const { messageId } = await seedMailThread(t, { text: TEXT });
	await t.run((ctx) =>
		captureInterpretSource(ctx, { source: { kind: 'mail', id: messageId }, isLive: true })
	);
	const out = await t.action(internal.mail.interpret.run.interpretMessage, {
		source: { kind: 'mail', id: messageId },
	});
	return { t, out };
}

const holdsOf = (t: Test) => t.run((ctx) => ctx.db.query('llmReservations').collect());

describe('the run hold covers the verification path that runs (Sol r2 F2)', () => {
	it('decision rung: claim checks draw on the run hold, ask for none of their own', async () => {
		const { t, out } = await interpret('10', { claimVerification: 'enforce' });
		expect(out).toMatchObject({ status: 'complete' });
		// The extraction only: no language verifier call.
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(mocks.runDecision).toHaveBeenCalledTimes(1);
		const options = mocks.runDecision.mock.calls[0]![0] as { requestId?: string };
		expect(options).not.toHaveProperty('admission');
		expect(options.requestId).toEqual(expect.any(String));
		// One hold, the run's, and the claim check's request id is keyed on it.
		const holds = await holdsOf(t);
		expect(holds).toEqual([expect.objectContaining({ task: 'mail.extract' })]);
		expect(holds[0]!.requestBounds?.some((b) => b.requestId === options.requestId)).toBe(true);
	});

	it('sizes the hold for the claim checks, below the language verifier’s maximum', async () => {
		const decision = await interpret('10', { claimVerification: 'enforce' });
		const language = await interpret('10', {});
		const [decisionHold] = await holdsOf(decision.t);
		const [languageHold] = await holdsOf(language.t);
		expect(decisionHold!.heldMicrousd).toBeLessThan(languageHold!.heldMicrousd);
	});

	it('near the ceiling: the decision path is admitted and never refused after extraction', async () => {
		// Find the ceiling between the two paths' holds, from the holds themselves.
		const [decisionHold] = await holdsOf(
			(await interpret('10', { claimVerification: 'enforce' })).t
		);
		const [languageHold] = await holdsOf((await interpret('10', {})).t);
		const between = (decisionHold!.heldMicrousd + languageHold!.heldMicrousd) / 2;
		// Background work stops at the advisory reserve and the triage allowance:
		// a ceiling where `between` is all the background headroom there is.
		const ceilingUsd = String(between / 1e6 / 0.8);

		const language = await interpret(ceilingUsd, {});
		expect(language.out).toMatchObject({ status: 'failed', errorCode: 'budget' });

		mocks.runDecision.mockClear();
		const decision = await interpret(ceilingUsd, { claimVerification: 'enforce' });
		expect(decision.out).toMatchObject({ status: 'complete' });
		expect(decision.out).not.toHaveProperty('budgetRefusal');
		expect(mocks.runDecision).toHaveBeenCalledTimes(1);
		expect(await holdsOf(decision.t)).toHaveLength(1);
	});

	it('the cap lowers the language path’s hold to the claims it allows', async () => {
		const capped = await interpret('10', { verifyClaimCapPerMessage: 1 });
		const full = await interpret('10', {});
		const [cappedHold] = await holdsOf(capped.t);
		const [fullHold] = await holdsOf(full.t);
		expect(cappedHold!.heldMicrousd).toBeLessThan(fullHold!.heldMicrousd);
	});
});
