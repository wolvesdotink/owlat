/**
 * The Phase 3 bundles through the decisions lane's runner and artifact claim
 * (ADR-0073, D5): the necessity judgment and the claim check, asked inline.
 * The provider calls and the admission seam are mocked. Never a paid provider.
 *
 * - The claim plans them from the CURRENT policy (a switch turned off stops a
 *   queued call), and an owner correction of the message's category does not
 *   settle them.
 * - Necessity on the language rung is ONE fast-tier call, metered once under
 *   `mail.necessity`, and a settled key hands its answer back without a call.
 * - The claim check has no language rung (today's verifier is that rung).
 * - A failed call reaches the caller's error hook, after the lease is released.
 * - Answer mode's master gate (`ai`) holds for a Team message.
 * - An owner correction still invalidates the Phase 2 artifacts however many
 *   claim checks the message holds.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import {
	createTestContact,
	createTestInboundMessage,
	enableFeatures,
} from '../../__tests__/factories';

const mocks = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	admitBundle: vi.fn(),
	roles: [] as string[],
	/** The language plane the rung resolves (kind and fast model). */
	language: { kind: 'openai', modelId: 'gpt-6-luna' } as {
		kind: string;
		modelId: string;
		baseUrl?: string;
	},
}));

vi.mock('../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../analytics/__tests__/meteredDispatch.testlib');
	return {
		...(await vi.importActual<object>('../../lib/llm/dispatch')),
		runLlmObject: metered((opts: unknown) => mocks.runLlmObject(opts)),
	};
});
vi.mock('../../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async (_ctx: unknown, role: string) => {
		mocks.roles.push(role);
		return 'mock-model';
	}),
	resolveLanguageModelWithProvenance: vi.fn(async (_ctx: unknown, task: string) => {
		mocks.roles.push(task);
		const { languageModelIdentity } = await import('../../lib/llm/languageIdentity');
		return {
			model: 'mock-model',
			modelId: mocks.language.modelId,
			endpointProvenance: 'openai-native',
			// The resolver's own identity builder, over the plane the test configures.
			identity: languageModelIdentity(
				mocks.language.kind,
				mocks.language.modelId,
				mocks.language.baseUrl
			),
		};
	}),
}));
vi.mock('../bundleAdmission', async () => ({
	...(await vi.importActual<object>('../bundleAdmission')),
	admitBundle: mocks.admitBundle,
}));

import { runBundle } from '../bundleRunner';
import { CLAIM_CHECK_BUNDLE, NECESSITY_BUNDLE } from '../../lib/decision/bundles';
import { necessityState } from '../../lib/decision/necessityState';
import { recordOwnerCorrection } from '../artifacts';
import type { RoutingContext } from '../context';
import { admitUnderOuterHold } from '../bundleAdmission';
import { reconcileSpend } from '../../aiRouting/__tests__/spend.testlib';
import { ACTION_MODEL_BUDGET_MS, anchorActionDeadline } from '../../lib/llm/actionDeadline';

const rootGlob = import.meta.glob('../../**/*.*s');
const decisionGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../decision/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...decisionGlob }).filter(
		([path]) => !path.includes('knowledgeExtraction') && !path.includes('llmProvider')
	)
);

type T = ReturnType<typeof convexTest>;

/** An action context over the test deployment, for calling the runner directly. */
function actionCtx(t: T): ActionCtx {
	const run = t as unknown as Record<
		'query' | 'mutation' | 'action',
		(ref: unknown, args: unknown) => Promise<unknown>
	>;
	return {
		runQuery: (ref: unknown, args: unknown) => run.query(ref, args),
		runMutation: (ref: unknown, args: unknown) => run.mutation(ref, args),
		runAction: (ref: unknown, args: unknown) => run.action(ref, args),
	} as unknown as ActionCtx;
}

async function setup(
	policy: Record<string, unknown>,
	flags: Parameters<typeof enableFeatures>[1] = ['ai.agent', 'ai']
): Promise<T> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, flags);
	await t.run(async (ctx) => {
		await ctx.db.insert('aiRoutingPolicy', {
			...policy,
			shadowCapUsd: 1,
			policyVersion: 4,
			updatedAt: Date.now(),
			updatedBy: 'admin-1',
		});
	});
	return t;
}

async function seedTeamMessage(t: T): Promise<Id<'inboundMessages'>> {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'ada@example.com' })
		);
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'New date',
			normalizedSubject: 'new date',
			contactId,
			contactIdentifier: 'ada@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
		});
		return ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				from: 'Ada <ada@example.com>',
				to: 'support@owlat.test',
				subject: 'New date',
				textBody: 'Can we move the launch, and at what price?',
				contactId,
				threadId,
			})
		);
	});
}

const routing = async (t: T): Promise<RoutingContext> =>
	t.query(internal.decision.context.routingContext, {});

const ADMITTED = {
	isAdmitted: true,
	target: { feature: 'decision_necessity', task: 'mail.necessity' },
	decision: { recordUsage: vi.fn() },
};

beforeEach(() => {
	mocks.roles.length = 0;
	mocks.language = { kind: 'openai', modelId: 'gpt-6-luna' };
	mocks.admitBundle.mockResolvedValue(ADMITTED);
	mocks.runLlmObject.mockResolvedValue({
		object: { necessity: 0.9 },
		tokenUsage: { promptTokens: 200, completionTokens: 2, totalTokens: 202 },
		modelUsed: 'gpt-6-luna',
	});
});
afterEach(() => vi.clearAllMocks());

function necessityRun(t: T, routed: RoutingContext, id: Id<'inboundMessages'>, extra = {}) {
	return runBundle(actionCtx(t), {
		bundle: NECESSITY_BUNDLE,
		plan: { task: 'mail.necessity', mode: 'advisory' },
		routing: routed,
		subject: { kind: 'inbound_message', inboundMessageId: id },
		built: necessityState('Customer: can we move the launch, and at what price?'),
		root: { rootRequestId: `team:${id}` },
		...extra,
	});
}

describe('the necessity judgment through the runner', () => {
	it('is one fast-tier call on the language rung, metered once, and answered from the key after', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		const routed = await routing(t);

		const first = await necessityRun(t, routed, id);
		expect(first).toEqual({ hasRun: true, status: 'complete', labels: { necessity: 'needed' } });
		expect(mocks.roles).toEqual(['mail.necessity']); // the decision task's own fast tier
		const ledger = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({
			feature: 'decision_necessity',
			task: 'mail.necessity',
			plane: 'language',
			rootRequestId: `team:${id}`,
		});

		const again = await necessityRun(t, routed, id);
		expect(again).toEqual({ hasRun: false, why: 'settled', labels: { necessity: 'needed' } });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
	});

	it.each([
		['the language provider changes', { kind: 'anthropic', modelId: 'gpt-6-luna' }],
		['the fast model changes', { kind: 'openai', modelId: 'gpt-6-sol-mini' }],
	])('re-asks on the language rung when %s (Sol r4 F1)', async (_label, next) => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		const routed = await routing(t);
		await necessityRun(t, routed, id);
		const [first] = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(first).toMatchObject({ contextVersion: 'language|openai|gpt-6-luna|' });
		// Same configuration again: the stored answer is reused, nothing is asked.
		expect(await necessityRun(t, routed, id)).toMatchObject({ hasRun: false, why: 'settled' });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);

		mocks.language = next;
		const again = await necessityRun(t, routed, id);
		expect(again).toMatchObject({ hasRun: true, status: 'complete' });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(2);
		const [row] = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(row).toMatchObject({ contextVersion: `language|${next.kind}|${next.modelId}|` });
	});

	it('re-asks when the base path of the same provider and model changes (Sol r5 F1)', async () => {
		mocks.language = {
			kind: 'openaiCompatible',
			modelId: 'gpt-6-luna',
			baseUrl: 'https://gateway.example/a/v1',
		};
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		const routed = await routing(t);
		await necessityRun(t, routed, id);
		// Unchanged endpoint: the stored answer is reused.
		expect(await necessityRun(t, routed, id)).toMatchObject({ hasRun: false, why: 'settled' });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);

		mocks.language = { ...mocks.language, baseUrl: 'https://gateway.example/b/v1' };
		expect(await necessityRun(t, routed, id)).toMatchObject({ hasRun: true, status: 'complete' });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(2);
	});

	it('re-asks when the stored answer came from another plane (Sol r3 F2)', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		const routed = await routing(t);
		await necessityRun(t, routed, id);
		await t.run(async (ctx) => {
			const [row] = await ctx.db.query('decisionArtifacts').collect();
			await ctx.db.patch(row!._id, {
				contextVersion: 'typesafe|jev-1.13.0|https://api.typesafe.ai',
			});
		});
		expect(await necessityRun(t, routed, id)).toMatchObject({ hasRun: true, status: 'complete' });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(2);
	});

	it('the dispatched model is the one the identity was resolved from (resolved once)', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		await necessityRun(t, await routing(t), id);
		expect(mocks.roles).toEqual(['mail.necessity']);
		expect(mocks.runLlmObject.mock.calls[0]![0]).toMatchObject({ model: 'mock-model' });
	});

	it('reclaims at the claim on a model change, and never hands back another model’s labels', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		const before = 'typesafe|jev-1.13.0|https://api.typesafe.ai';
		const after = 'typesafe|jev-2.0.0|https://api.typesafe.ai';
		await t.run(async (ctx) => {
			await ctx.db.insert('decisionArtifacts', {
				artifactKey: 'key-1',
				task: 'mail.necessity',
				kind: 'advisory',
				status: 'complete',
				subjectKind: 'inbound_message',
				inboundMessageId: id,
				contentHash: 'h',
				policyVersion: 4,
				contextVersion: before,
				answers: JSON.stringify({ labels: { necessity: 'needed' } }),
				expiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		expect(
			await t.query(internal.decision.artifacts.answeredLabels, {
				artifactKey: 'key-1',
				contextVersion: after,
			})
		).toBeNull();
		expect(
			await t.query(internal.decision.artifacts.answeredLabels, {
				artifactKey: 'key-1',
				contextVersion: before,
			})
		).toEqual({ necessity: 'needed' });
		const languageClaim = (contextVersion: string) =>
			t.mutation(internal.decision.artifacts.claim, {
				artifactKey: 'key-1',
				task: 'mail.necessity',
				kind: 'advisory',
				subjectKind: 'inbound_message',
				inboundMessageId: id,
				contentHash: 'h',
				policyVersion: 4,
				endpoint: { rung: 'language', isLocal: false, isDecisionPlaneOn: false },
				contextVersion,
			});
		expect(await languageClaim(before)).toEqual({ outcome: 'settled' });
		expect(await languageClaim(after)).toMatchObject({ outcome: 'claimed' });
	});

	it('stops a call planned under a policy that has since been switched off', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		const routed = await routing(t);
		await t.run(async (ctx) => {
			const row = await ctx.db.query('aiRoutingPolicy').first();
			await ctx.db.patch(row!._id, { clarifyNecessity: 'off', policyVersion: 5 });
		});
		expect(await necessityRun(t, routed, id)).toEqual({ hasRun: false, why: 'policy_changed' });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it('is not settled by an owner correction of the message', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		await t.run((ctx) => recordOwnerCorrection(ctx, { inboundMessageId: id }));
		const outcome = await necessityRun(t, await routing(t), id);
		expect(outcome).toMatchObject({ hasRun: true, labels: { necessity: 'needed' } });
		const [artifact] = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(artifact).not.toHaveProperty('invalidatedAt');
	});

	it('honours the caller’s master gate: Answer mode needs `ai`, not the agent', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' }, ['ai']);
		const id = await seedTeamMessage(t);
		const routed = await routing(t);
		expect(await necessityRun(t, routed, id)).toEqual({ hasRun: false, why: 'disabled' });
		const outcome = await necessityRun(t, routed, id, { masterGate: 'ai' });
		expect(outcome).toMatchObject({ hasRun: true, status: 'complete' });
	});

	it('hands a failed call to the caller’s hook after releasing the lease', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		const refusal = new Error('refused');
		mocks.runLlmObject.mockRejectedValueOnce(refusal);
		const seen: unknown[] = [];
		const outcome = await necessityRun(t, await routing(t), id, {
			onCallError: (error: unknown) => seen.push(error),
		});
		expect(outcome).toEqual({ hasRun: true, status: 'failed' });
		expect(seen).toEqual([refusal]);
		const [artifact] = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(artifact).toMatchObject({ status: 'failed' });
	});

	it('asks admission at the caller’s priority, on the selected rung’s plane', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		await necessityRun(t, await routing(t), id, { priority: 'interactive' });
		expect(mocks.admitBundle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				task: 'mail.necessity',
				mode: 'advisory',
				priority: 'interactive',
				plane: 'language',
			})
		);
	});

	it('bounds the root by the action’s model budget before admission and dispatch', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		await necessityRun(t, await routing(t), id);
		const [, request] = mocks.admitBundle.mock.calls[0]!;
		expect(request.root).toMatchObject({ rootRequestId: `team:${id}` });
		expect(request.root.deadlineAt).toBeGreaterThan(Date.now());
		expect(request.root.deadlineAt).toBeLessThanOrEqual(Date.now() + ACTION_MODEL_BUDGET_MS);
	});

	it('stops asking once the action’s budget is spent: no admission, no claim, no call', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const start = Date.parse('2026-10-12T10:00:00Z');
			vi.setSystemTime(start);
			const t = await setup({ clarifyNecessity: 'enforce' });
			const id = await seedTeamMessage(t);
			const routed = await routing(t);
			const ctx = actionCtx(t); // one action: one budget across its calls
			anchorActionDeadline(ctx, start);
			const ask = (context: string) =>
				runBundle(ctx, {
					bundle: NECESSITY_BUNDLE,
					plan: { task: 'mail.necessity', mode: 'advisory' },
					routing: routed,
					subject: { kind: 'inbound_message', inboundMessageId: id },
					built: necessityState(context),
					root: { rootRequestId: `team:${id}` },
				});
			expect(await ask('first')).toMatchObject({ hasRun: true, status: 'complete' });
			vi.setSystemTime(start + ACTION_MODEL_BUDGET_MS);
			expect(await ask('second')).toEqual({ hasRun: false, why: 'deadline' });
			expect(await ask('third')).toEqual({ hasRun: false, why: 'deadline' });
			expect(mocks.admitBundle).toHaveBeenCalledTimes(1);
			expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
			const rows = await t.run((c) => c.db.query('decisionArtifacts').collect());
			expect(rows).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('an advisory call under the caller’s hold asks no admission and reports its requests', async () => {
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		const count = vi.fn();
		const outcome = await necessityRun(t, await routing(t), id, {
			outerHold: { reservationId: 'run-hold', requestId: 'req-1', count },
		});
		expect(outcome).toMatchObject({ hasRun: true, status: 'complete' });
		expect(mocks.admitBundle).not.toHaveBeenCalled();
		expect(count).toHaveBeenCalledWith(1);
		const rows = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
		expect(rows.filter((r) => r.feature === 'decision_necessity')).toEqual([
			expect.objectContaining({ reservationId: 'run-hold', requestId: 'req-1' }),
		]);
	});

	it('runs nothing without admission', async () => {
		mocks.admitBundle.mockResolvedValue({ isAdmitted: false, why: 'admission_unavailable' });
		const t = await setup({ clarifyNecessity: 'enforce' });
		const id = await seedTeamMessage(t);
		expect(await necessityRun(t, await routing(t), id)).toEqual({
			hasRun: false,
			why: 'admission_unavailable',
		});
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});
});

describe('the claim check through the runner', () => {
	it('has no language rung: today’s verifier is that rung', async () => {
		const t = await setup({ claimVerification: 'enforce' });
		const id = await seedTeamMessage(t);
		const outcome = await runBundle(actionCtx(t), {
			bundle: CLAIM_CHECK_BUNDLE,
			plan: { task: 'mail.claim_check', mode: 'advisory' },
			routing: await routing(t),
			subject: { kind: 'inbound_message', inboundMessageId: id },
			built: { state: { claim: 'x', quotes: ['y'] }, isComplete: false, contentFingerprint: 'f' },
			root: { rootRequestId: `team:${id}` },
		});
		expect(outcome).toEqual({ hasRun: false, why: 'language_rung' });
		expect(mocks.admitBundle).not.toHaveBeenCalled();
	});
});

describe('owner corrections with many claim checks', () => {
	it('still invalidate the category artifact past 64 claim-check artifacts', async () => {
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		const id = await seedTeamMessage(t);
		await t.run(async (ctx) => {
			const base = {
				kind: 'advisory' as const,
				status: 'complete' as const,
				subjectKind: 'inbound_message' as const,
				inboundMessageId: id,
				policyVersion: 4,
				expiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			for (let i = 0; i < 70; i++) {
				await ctx.db.insert('decisionArtifacts', {
					...base,
					artifactKey: `claim-${i}`,
					task: 'mail.claim_check',
					contentHash: `c${i}`,
				});
			}
			await ctx.db.insert('decisionArtifacts', {
				...base,
				artifactKey: 'category',
				task: 'mail.category',
				contentHash: 'm',
			});
			await recordOwnerCorrection(ctx, { inboundMessageId: id });
		});
		const rows = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(rows.find((row) => row.task === 'mail.category')).toMatchObject({
			invalidationReason: 'owner_correction',
		});
		expect(rows.filter((row) => row.invalidatedAt !== undefined)).toHaveLength(1);
	});
});

describe('a claim check under the run hold, when its usage write fails (Sol r4 F3)', () => {
	it('counts each request once across the failed write and its replay, and settles exactly', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		try {
			const t = await setup({ claimVerification: 'enforce' });
			await reconcileSpend(t);
			await t.mutation(internal.aiRouting.admission.reserve, {
				reservationId: 'run-dec',
				rootRequestId: 'team:m',
				plane: 'decision',
				task: 'mail.claim_check',
				budgetClass: 'standard',
				priority: 'pipeline',
				heldMicrousd: 1_000,
				maxRequests: 2,
				requestBound: { requestId: 'req-1', attempt: 1, microusd: 500 },
				requestBounds: [{ requestId: 'req-1', attempt: 2, microusd: 500 }],
				expiresAt: Date.now() + 600_000,
			});
			// The first batch cannot be written at all: both direct tries and both
			// scheduled tries fail. Later batches go through.
			let failures = 4;
			const base = actionCtx(t);
			const ctx = {
				...base,
				runMutation: (ref: never, args: never) =>
					failures-- > 2 ? Promise.reject(new Error('write failed')) : base.runMutation(ref, args),
				scheduler: {
					runAfter: () =>
						failures-- > 0 ? Promise.reject(new Error('schedule failed')) : Promise.resolve(),
				},
			} as unknown as ActionCtx;
			let counted = 0;
			const admitted = admitUnderOuterHold(
				ctx,
				{
					task: 'mail.claim_check',
					feature: 'decision_claim_check',
					root: { rootRequestId: 'team:m' },
					policyVersion: 4,
					plane: 'decision',
				},
				{ reservationId: 'run-dec', requestId: 'req-1', count: (n) => (counted += n) }
			);
			const record = (requests: { attempt: number }[]) => ({
				feature: 'decision_claim_check',
				requestId: 'req-1',
				provider: 'typesafe' as const,
				attempt: requests.length,
				fallback: false,
				outcome: 'failed' as const,
				durationMs: 5,
				requests: requests.map((r) => ({
					...r,
					outcome: 'failed' as const,
					latencyMs: 5,
					modelUsed: 'jev-1.13.0',
				})),
			});
			const recordUsage = admitted.decision.recordUsage!;
			// Attempt 1's write fails; its request stays pending and rides with attempt 2's.
			await expect(recordUsage(record([{ attempt: 1 }]) as never)).rejects.toThrow();
			await recordUsage(record([{ attempt: 1 }, { attempt: 2 }]) as never);
			expect(counted).toBe(2);
			const rows = (await t.run((c) => c.db.query('llmUsageEvents').collect())).filter(
				(r) => r.reservationId === 'run-dec' && r.feature === 'decision_claim_check'
			);
			expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2]);
			await t.mutation(internal.aiRouting.admission.settle, {
				reservationId: 'run-dec',
				expectedRequests: counted,
			});
			const hold = (await t.run((c) => c.db.query('llmReservations').collect())).find(
				(row) => row.reservationId === 'run-dec'
			);
			expect(hold).toMatchObject({ status: 'settled' });
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
