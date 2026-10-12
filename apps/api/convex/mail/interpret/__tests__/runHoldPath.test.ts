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
	mocks.runDecision.mockImplementation(
		async (opts: {
			feature: string;
			requestId: string;
			recordUsage?: (record: unknown) => Promise<void>;
		}) => {
			// The provider's one request, reported with no usage (an estimate row).
			await opts.recordUsage?.({
				feature: opts.feature,
				requestId: opts.requestId,
				provider: 'typesafe',
				attempt: 1,
				fallback: false,
				outcome: 'answered',
				durationMs: 5,
				requests: [
					{
						attempt: 1,
						outcome: 'ok',
						latencyMs: 5,
						modelUsed: 'jev-1.13.0',
					},
				],
			});
			return {
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
				requestId: opts.requestId,
				attempts: 1,
			};
		}
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

/** A deployment with the policy and a ceiling, and `held` µ$ of other decision holds outstanding. */
async function setup(
	ceilingUsd: string,
	policy: Record<string, unknown>,
	decisionHeldMicrousd = 0
): Promise<Test> {
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
	if (decisionHeldMicrousd > 0) {
		await t.mutation(internal.aiRouting.admission.reserve, {
			reservationId: 'someone-else',
			rootRequestId: 'team:other',
			plane: 'decision',
			task: 'mail.triage',
			budgetClass: 'standard',
			priority: 'pipeline',
			heldMicrousd: decisionHeldMicrousd,
			maxRequests: 1,
			requestBound: { microusd: decisionHeldMicrousd },
			expiresAt: Date.now() + 600_000,
		});
	}
	return t;
}

async function runOne(t: Test, text = TEXT) {
	const { messageId } = await seedMailThread(t, {
		text,
		address: `${crypto.randomUUID()}@owlat.test`,
	});
	await t.run((ctx) =>
		captureInterpretSource(ctx, { source: { kind: 'mail', id: messageId }, isLive: true })
	);
	return t.action(internal.mail.interpret.run.interpretMessage, {
		source: { kind: 'mail', id: messageId },
	});
}

async function interpret(ceilingUsd: string, policy: Record<string, unknown>) {
	const t = await setup(ceilingUsd, policy);
	return { t, out: await runOne(t) };
}

const holdsOf = (t: Test) => t.run((ctx) => ctx.db.query('llmReservations').collect());
const ofRun = (t: Test) =>
	holdsOf(t).then((rows) => rows.filter((r) => r.reservationId !== 'someone-else'));
const extractions = () =>
	mocks.runLlmObject.mock.calls.filter(
		([opts]) => (opts as { schema: unknown }).schema === briefModelSchema
	).length;

describe('the run hold covers the verification path that runs (Sol r2 F2, r3 F1)', () => {
	it('decision rung: a language and a decision allocation; claim checks draw on the decision one', async () => {
		const { t, out } = await interpret('10', { claimVerification: 'enforce' });
		expect(out).toMatchObject({ status: 'complete' });
		// The extraction only: no language verifier call.
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(mocks.runDecision).toHaveBeenCalledTimes(1);
		const options = mocks.runDecision.mock.calls[0]![0] as { requestId?: string };
		expect(options).not.toHaveProperty('admission');
		const holds = await holdsOf(t);
		expect(holds.map((h) => [h.plane, h.task])).toEqual([
			['language', 'mail.extract'],
			['decision', 'mail.claim_check'],
		]);
		const decision = holds.find((h) => h.plane === 'decision')!;
		expect(decision.requestBounds?.some((b) => b.requestId === options.requestId)).toBe(true);
		// The claim check's row carries the decision allocation, which settles on its own.
		const rows = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
		expect(rows.filter((r) => r.feature === 'decision_claim_check')).toEqual([
			expect.objectContaining({ reservationId: decision.reservationId, plane: 'decision' }),
		]);
		expect(decision.status).toBe('settled');
		// Its unknown-usage estimate (the mocked call reports none) lands on the decision plane.
		const estimates = rows.filter(
			(r) => r.feature === 'admission_settlement' && r.reservationId === decision.reservationId
		);
		expect(estimates.every((r) => r.plane === 'decision')).toBe(true);
	});

	it('sizes the hold for the claim checks, below the language verifier’s maximum', async () => {
		const total = async (t: Test) => (await holdsOf(t)).reduce((sum, h) => sum + h.heldMicrousd, 0);
		const decision = await interpret('10', { claimVerification: 'enforce' });
		const language = await interpret('10', {});
		expect(await total(decision.t)).toBeLessThan(await total(language.t));
	});

	it('exhausted decision capacity refuses the run before extraction, holding nothing', async () => {
		// $10 a day: the decision plane may hold $2, and someone else holds all but $0.01.
		const t = await setup('10', { claimVerification: 'enforce' }, 1_990_000);
		const out = await runOne(t);
		expect(out).toMatchObject({ status: 'failed', errorCode: 'budget' });
		expect(extractions()).toBe(0);
		expect(mocks.runDecision).not.toHaveBeenCalled();
		expect(await ofRun(t)).toEqual([]);
	});

	it('concurrent runs: only as many decision allocations as the plane holds; the other run never extracts', async () => {
		const probe = await interpret('10', { claimVerification: 'enforce' });
		const oneRun = (await holdsOf(probe.t)).find((h) => h.plane === 'decision')!.heldMicrousd;
		mocks.runLlmObject.mockClear();
		mocks.runDecision.mockClear();
		// Room for one run's decision allocation, not two.
		const t = await setup(
			'10',
			{ claimVerification: 'enforce' },
			2_000_000 - Math.floor(1.5 * oneRun)
		);
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			await barrier; // both runs are admitted (or refused) before either extracts
			return schema === briefModelSchema ? { object: OUTPUT } : { object: { verdicts: [] } };
		});
		const runs = [runOne(t), runOne(t)];
		// The refused run returns at once; the admitted one waits at its extraction.
		await Promise.race(runs);
		const decisionHolds = (await ofRun(t)).filter((h) => h.plane === 'decision');
		expect(decisionHolds).toHaveLength(1);
		release();
		const outs = await Promise.all(runs);
		expect(outs.filter((o) => o.status === 'complete')).toHaveLength(1);
		expect(outs.filter((o) => o.status === 'failed')).toEqual([
			expect.objectContaining({ errorCode: 'budget' }),
		]);
		expect(extractions()).toBe(1);
	});

	it('the cap lowers the language path’s hold to the claims it allows', async () => {
		const capped = await interpret('10', { verifyClaimCapPerMessage: 1 });
		const full = await interpret('10', {});
		const [cappedHold] = await holdsOf(capped.t);
		const [fullHold] = await holdsOf(full.t);
		expect(cappedHold!.heldMicrousd).toBeLessThan(fullHold!.heldMicrousd);
	});
});
