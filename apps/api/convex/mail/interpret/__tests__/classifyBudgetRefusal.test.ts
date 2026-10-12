/**
 * Sol r1 F2 (clarify lane): an interpretation that met a spend refusal in its
 * verification (a refused claim check, or a refused verifier batch) ends
 * `partial`/`verify` with `budgetRefusal`. The Reply Queue classification
 * defers on it BEFORE applying the projection: the thread stays pending on its
 * heuristic baseline, no clarification is asked, and the classification is
 * rescheduled. Real interpretation runs; the model and the verifier routing
 * are stubbed.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { addMessageToThread, modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource } from '../sources';
import { isBudgetRefused } from '../../ai/needsReplyClassify';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn(), refused: true }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return {
		...(await vi.importActual<object>('../../../lib/llm/dispatch')),
		runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)),
	};
});
vi.mock('../../../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../../../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));
// The claim checks were refused by spend admission: no verdict, and the refusal.
vi.mock('../verifyRoute', () => ({
	verifyRouted: vi.fn(async () => ({
		verdicts: new Map(),
		isIncomplete: true,
		isUnsendable: false,
		isCapped: false,
		isUnavailable: false,
		...(llm.refused
			? { refusal: { code: 'AI_BUDGET_EXHAUSTED', reason: 'daily_ceiling', limit: '$1.00' } }
			: {}),
	})),
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

async function pendingJobs(t: Test, fragment: string) {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending' && job.name.includes(fragment))
			.map((job) => job.args[0] as Record<string, unknown>)
	);
}

async function classify(t: Test) {
	llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
		if (schema === briefModelSchema) return { object: OUTPUT, modelUsed: 'stub-model' };
		throw new Error('no other model call is expected');
	});
	await enableFeatures(t, ['ai', 'mail.external']);
	const seeded = await seedMailThread(t, { text: 'Hello there.' });
	const threadId = seeded.threadId;
	const messageId = await addMessageToThread(
		t,
		{ mailboxId: seeded.mailboxId, threadId },
		{ text: TEXT, receivedAt: Date.UTC(2026, 9, 7, 10, 0) }
	);
	await t.run(async (ctx) => {
		await captureInterpretSource(ctx, { source: { kind: 'mail', id: messageId }, isLive: true });
		await ctx.db.patch(threadId, { latestMessageId: messageId, needsReplyPendingAt: Date.now() });
	});
	await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });
	return { threadId, messageId };
}

describe('the Reply Queue classification and a refused verification (Sol r1 F2)', () => {
	it('defers before applying the projection: pending, baseline kept, nothing asked', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			llm.refused = true;
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const { threadId } = await classify(t);
			const thread = await t.run((ctx) => ctx.db.get(threadId));
			expect(thread?.needsReplyPendingAt).toBeDefined();
			expect(thread?.needsReply).toMatchObject({ source: 'heuristic' });
			expect(thread?.needsReply?.clarification).toBeUndefined();
			expect(await pendingJobs(t, 'needsReplyClassify')).toEqual([
				expect.objectContaining({ threadId, deferrals: 1 }),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('applies the partial projection as before when nothing was refused', async () => {
		llm.refused = false;
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { threadId } = await classify(t);
		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		expect(thread?.needsReply).toMatchObject({ source: 'llm' });
		expect(await pendingJobs(t, 'needsReplyClassify')).toEqual([]);
	});
});

describe('isBudgetRefused', () => {
	const base = { isReplayed: false, createdItemIds: [] };
	it.each([
		[{ ...base, status: 'failed' as const, errorCode: 'budget' }, true],
		[
			{
				...base,
				status: 'partial' as const,
				errorCode: 'verify',
				budgetRefusal: { reason: 'daily_ceiling' as const, limit: '$1' },
			},
			true,
		],
		[{ ...base, status: 'partial' as const, errorCode: 'verify' }, false],
		[{ status: 'gone' as const }, false],
	])('%o → %s', (run, expected) => {
		expect(isBudgetRefused(run)).toBe(expected);
	});
});
