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
		expect(mocks.roles).toEqual(['classify']);
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
