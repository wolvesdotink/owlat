/**
 * The decisions lane's admission seam, wired to the admission lane
 * (`decision/bundleAdmission.ts`): a shadow bundle call goes through the
 * counted quota and the shadow allowance (`analytics/shadowAdmission.ts`),
 * an advisory one through an ordinary hold (`analytics/admissionPorts.ts`),
 * and a hold the ceiling refuses stops the call before any request leaves,
 * on either rung. The SDK and the decision adapters are mocked; admission,
 * the quota and the ledger are real (a convex-test instance behind an action
 * ctx).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ generateObject: vi.fn(), typesafe: vi.fn() }));

vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	generateObject: (args: unknown) => sdk.generateObject(args),
}));
vi.mock('../../lib/decisionProviders', async () => ({
	...(await vi.importActual<object>('../../lib/decisionProviders')),
	decisionProviderFor: () => ({
		kind: 'typesafe',
		ask: sdk.typesafe,
		defaultDeadlineMs: 10_000,
		handlesRetries: false,
	}),
}));

import { z } from 'zod';
import { newHarness } from '../../__tests__/testModules';
import { actionCtxOver, reconcileSpend } from '../../aiRouting/__tests__/spend.testlib';
import { shadowSamplePoint } from '../../lib/aiRouting/shadowSampling';
import { AdmissionRefusedError } from '../../lib/llm/admissionPort';
import { stampModelEndpoint } from '../../lib/llm/modelEndpoint';
import { runLlmObject } from '../../lib/llm/dispatch';
import { meterLlmCall } from '../../analytics/meteredSpend';
import { runDecision } from '../../lib/decision/dispatch';
import { noul } from '../../lib/decision/questions';
import { admitBundle } from '../bundleAdmission';
import { insertLlmUsage } from '../../analytics/ledgerInsert';

type T = ReturnType<typeof newHarness>;

const model = stampModelEndpoint(
	{ modelId: 'gpt-4o', specificationVersion: 'v2' } as never,
	'openai-native'
);
/** A fast-tier model whose worst-case hold fits the day's shadow allowance. */
const fastModel = stampModelEndpoint(
	{ modelId: 'gpt-4o-mini', specificationVersion: 'v2' } as never,
	'openai-native'
);

/** A message key the hash makes a triage candidate. */
function sampledKey(): string {
	for (let index = 0; ; index++) {
		if (shadowSamplePoint('mail.triage', `m${index}`) < 0.2) return `m${index}`;
	}
}

async function triageShadowPolicy(t: T) {
	await t.run((ctx) =>
		ctx.db.insert('aiRoutingPolicy', {
			triageBundle: 'shadow',
			policyVersion: 3,
			updatedAt: Date.now(),
			updatedBy: 'admin',
		})
	);
}

/** Thirty earlier eligible messages today, so the day's quota has room for three. */
async function earlierTraffic(t: T) {
	await t.run((ctx) =>
		ctx.db.insert('shadowQuotaDays', {
			task: 'mail.triage',
			dayKey: new Date().toISOString().slice(0, 10),
			eligibleCount: 30,
			admittedCount: 0,
			updatedAt: Date.now(),
		})
	);
}

async function setup(dailyUsd: string) {
	vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', dailyUsd);
	const t = newHarness();
	await reconcileSpend(t);
	return { t, ...actionCtxOver(t) };
}

const request = (
	subjectKey: string,
	mode: 'shadow' | 'advisory',
	plane: 'decision' | 'language' = 'decision'
) => ({
	task: 'mail.triage' as const,
	mode,
	subjectKey,
	feature: 'decision_triage',
	root: { rootRequestId: `team:${subjectKey}` },
	policyVersion: 3,
	plane,
});

beforeEach(() => {
	sdk.generateObject.mockReset();
	sdk.typesafe.mockReset();
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('admitBundle, wired to admission', () => {
	it('admits a shadow call inside the counted quota, and its dispatch holds against the shadow allowance', async () => {
		const { t, ctx } = await setup('10');
		await triageShadowPolicy(t);
		await earlierTraffic(t);
		const key = sampledKey();

		const admitted = await admitBundle(ctx, request(key, 'shadow'));

		if (!admitted.isAdmitted) throw new Error(`refused: ${admitted.why}`);
		expect(admitted.target).toMatchObject({
			feature: 'decision_triage',
			task: 'mail.triage',
			budgetClass: 'shadow',
			priority: 'background',
		});
		const [day] = await t.run((c) => c.db.query('shadowQuotaDays').collect());
		expect(day).toMatchObject({ eligibleCount: 31, admittedCount: 1 });

		// A decision-rung call through the admitted options reserves as shadow traffic.
		sdk.typesafe.mockImplementation(async () => {
			const holds = await t.run((c) => c.db.query('llmReservations').collect());
			expect(holds).toEqual([
				expect.objectContaining({
					status: 'held',
					budgetClass: 'shadow',
					priority: 'background',
					plane: 'decision',
				}),
			]);
			return {
				answers: { isWork: { kind: 'noul', probability: 0.9 } },
				usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				modelUsed: 'jev-1.13.0',
				provenance: 'typesafe-native',
				calibrated: true,
			};
		});
		await runDecision({
			feature: 'decision_triage',
			task: 'mail.triage',
			root: { rootRequestId: `team:${key}` },
			state: 'Subject: hello',
			questions: { isWork: noul('Does this need work?') },
			provider: { kind: 'typesafe', config: { apiKey: 'not-a-key' }, modelId: 'jev-1.13.0' },
			allowance: { allowed: true, fallbackAllowed: false },
			rateLimiter: { reserve: () => {} },
			...admitted.decision,
		});
		expect(sdk.typesafe).toHaveBeenCalledTimes(1);
		const rows = await t.run((c) => c.db.query('llmUsageEvents').collect());
		expect(rows.find((r) => r.feature === 'decision_triage')).toMatchObject({
			budgetClass: 'shadow',
			plane: 'decision',
		});
		const [hold] = await t.run((c) => c.db.query('llmReservations').collect());
		expect(hold).toMatchObject({ plane: 'decision' });
	});

	it("holds and records a language-rung call on the language plane, whatever the task's catalog plane (Sol r7 F1)", async () => {
		const { t, ctx } = await setup('10');
		await triageShadowPolicy(t);
		await earlierTraffic(t);
		// $2 of decision spend: the decision plane's 20% cap of a $10 ceiling is used up.
		await t.run((c) =>
			insertLlmUsage(
				c,
				'decision_triage',
				{ promptTokens: 800_000, completionTokens: 0, totalTokens: 800_000 },
				'gpt-4o',
				undefined,
				{ plane: 'decision' }
			)
		);
		const key = sampledKey();
		const admitted = await admitBundle(ctx, request(key, 'shadow', 'language'));
		if (!admitted.isAdmitted) throw new Error(`refused: ${admitted.why}`);
		expect(admitted.target).toMatchObject({ plane: 'language', budgetClass: 'shadow' });

		sdk.generateObject.mockImplementation(async () => {
			const holds = await t.run((c) => c.db.query('llmReservations').collect());
			expect(holds).toEqual([expect.objectContaining({ status: 'held', plane: 'language' })]);
			return {
				object: { triage: 'needs_work' },
				usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
				finishReason: 'stop',
				response: { modelId: 'gpt-4o-mini' },
			};
		});
		// As the runner's language rung meters it (`decision/bundleRunner.ts` askLanguageRung).
		await meterLlmCall(
			ctx,
			{ ...admitted.target, task: 'mail.triage', plane: 'language' },
			(meter) =>
				runLlmObject({
					meter,
					model: fastModel,
					schema: z.object({ triage: z.string() }),
					prompt: 'Is this work?',
				})
		);
		expect(sdk.generateObject).toHaveBeenCalledTimes(1);
		const rows = await t.run((c) => c.db.query('llmUsageEvents').collect());
		expect(rows.find((r) => r.feature === 'decision_triage' && r.reservationId)).toMatchObject({
			plane: 'language',
			budgetClass: 'shadow',
		});

		// The decision rung is still bounded by its own plane's cap.
		const onDecision = await admitBundle(ctx, request(key, 'shadow', 'decision'));
		expect(onDecision).toEqual({ isAdmitted: false, why: 'no_allowance' });
	});

	it('refuses a shadow call outside the counted quota, with no hold', async () => {
		const { t, ctx } = await setup('10');
		await triageShadowPolicy(t);
		// The day's first eligible message: floor(10% × 1) = 0 slots.
		const admitted = await admitBundle(ctx, request(sampledKey(), 'shadow'));
		expect(admitted).toEqual({ isAdmitted: false, why: 'not_sampled' });
		expect(await t.run((c) => c.db.query('llmReservations').collect())).toEqual([]);
	});

	it('refuses a shadow call while the task is not shadowed', async () => {
		const { ctx } = await setup('10');
		expect(await admitBundle(ctx, request(sampledKey(), 'shadow'))).toEqual({
			isAdmitted: false,
			why: 'not_shadowed',
		});
	});

	it('holds an advisory call at the priority its caller waits at (Answer mode: interactive)', async () => {
		const { ctx } = await setup('10');
		const admitted = await admitBundle(ctx, {
			...request('m-int', 'advisory', 'language'),
			priority: 'interactive',
		});
		if (!admitted.isAdmitted) throw new Error('advisory admission refused up front');
		expect(admitted.target).toMatchObject({ priority: 'interactive' });
	});

	describe('a hold the ceiling refuses makes no call', () => {
		it('on the language rung', async () => {
			// $0.0001 a day: the gate-sized probe fits, a real request's hold does not.
			const { t, ctx } = await setup('0.0001');
			const admitted = await admitBundle(ctx, request('m-lang', 'advisory', 'language'));
			if (!admitted.isAdmitted) throw new Error('advisory admission refused up front');
			expect(admitted.target).toMatchObject({ task: 'mail.triage', priority: 'background' });

			await expect(
				meterLlmCall(ctx, admitted.target, (meter) =>
					runLlmObject({
						meter,
						model,
						schema: z.object({ triage: z.string() }),
						prompt: 'Is this work?',
					})
				)
			).rejects.toBeInstanceOf(AdmissionRefusedError);
			expect(sdk.generateObject).not.toHaveBeenCalled();
			expect(await t.run((c) => c.db.query('llmReservations').collect())).toEqual([]);
			expect(await t.run((c) => c.db.query('llmUsageEvents').collect())).toEqual([]);
		});

		it('on the decision rung', async () => {
			const { t, ctx } = await setup('0.0001');
			const admitted = await admitBundle(ctx, request('m-dec', 'advisory'));
			if (!admitted.isAdmitted) throw new Error('advisory admission refused up front');

			await expect(
				runDecision({
					feature: 'decision_triage',
					task: 'mail.triage',
					root: { rootRequestId: 'team:m-dec' },
					state: 'Subject: hello '.repeat(200),
					questions: { isWork: noul('Does this need work?') },
					provider: { kind: 'typesafe', config: { apiKey: 'not-a-key' }, modelId: 'jev-1.13.0' },
					allowance: { allowed: true, fallbackAllowed: false },
					rateLimiter: { reserve: () => {} },
					...admitted.decision,
				})
			).rejects.toBeInstanceOf(AdmissionRefusedError);
			expect(sdk.typesafe).not.toHaveBeenCalled();
			expect(await t.run((c) => c.db.query('llmUsageEvents').collect())).toEqual([]);
		});
	});
});
