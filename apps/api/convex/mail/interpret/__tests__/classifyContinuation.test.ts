/**
 * D10 with Sol r4 F1: a Reply Queue candidate whose thread holds more
 * deferred predecessors than one run reads (the budget) is not left on its
 * heuristic baseline. The classifier's own run continues: the thread stays
 * pending, the classification is rescheduled with the same arguments, and
 * once the predecessors are read it applies the model's verdict, asks its
 * clarification and schedules draft-on-arrival. Real interpretation runs; the
 * model is stubbed.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { replySlotsSchema } from '../../../inbox/clarificationSlots';
import { addMessageToThread, modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource } from '../sources';
import { deferSource } from '../outstanding';
import { PREDECESSOR_BUDGET } from '../defer';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn() }));

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

const text = (tag: string) => `[${tag}] could you send me the signed contract by Friday?`;

function modelOutput(segmentId: string) {
	return {
		mode: 'brief',
		items: [
			{
				matchItemId: null,
				intent: 'request',
				facets: ['file', 'signature'],
				consequences: ['signature'],
				assertion: 'Send the signed contract',
				display: {
					en: 'Send Jonas the signed contract',
					de: 'Schick Jonas den unterschriebenen Vertrag',
				},
				requester: { ref: 'p1', name: null, email: null },
				responsible: { ref: null, name: null, email: 'me@owlat.test' },
				beneficiary: null,
				due: { phrase: 'by Friday', at: '2026-10-09', tz: null, ambiguous: false, condition: null },
				amount: null,
				options: null,
				quotes: [{ segmentId, text: 'send me the signed contract by Friday' }],
			},
		],
		transitions: [],
		replyIntent: 'request_for_action',
		urgency: 'normal',
		meetingIntent: null,
		coverage: { segmentsRead: [segmentId], uncertain: false, overflow: false },
		latest: {
			en: [
				{
					text: 'Jonas wants the signed contract.',
					quotes: [{ segmentId, text: 'signed contract' }],
				},
			],
			de: [{ text: 'Jonas will den Vertrag.', quotes: [{ segmentId, text: 'signed contract' }] }],
		},
		facts: [],
	};
}

beforeEach(() => {
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
		const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
		if (schema === briefModelSchema) {
			return { object: modelOutput('s0'), tokenUsage: usage, modelUsed: 'stub-model' };
		}
		if (schema === replySlotsSchema) {
			// A file the reply cannot go out without: asked without the divergence samples.
			return {
				object: {
					slots: [
						{
							slotType: 'attachment',
							question: 'Please attach the signed contract',
							answerableFromContext: false,
							decisionRelevant: true,
							options: [],
						},
					],
				},
				tokenUsage: usage,
				modelUsed: 'stub-model',
			};
		}
		// The verifier and the question translations.
		return {
			object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }], translations: [] },
			tokenUsage: usage,
			modelUsed: 'stub-model',
		};
	});
});

/** The text a mocked model call was asked about (a prompt, or a cache-split message list). */
function promptText(opts: unknown): string {
	const call = opts as { prompt?: string; messages?: { content: unknown }[] };
	return call.prompt ?? JSON.stringify(call.messages?.map((m) => m.content) ?? []);
}

const T0 = Date.UTC(2026, 9, 7, 9, 0);

const readTags = () =>
	llm.runLlmObject.mock.calls
		.filter(([opts]) => (opts as { schema: unknown }).schema === briefModelSchema)
		.map(([opts]) => promptText(opts).match(/\[(\w+)\]/)?.[1] ?? '?');

async function pendingJobs(t: Test, fragment: string) {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending' && job.name.includes(fragment))
			.map((job) => job.args[0] as Record<string, unknown>)
	);
}

describe('D10: the Reply Queue classification continues past its predecessors (Sol r4 F1)', () => {
	it('stays pending, continues itself, then applies the verdict and clarifies', async () => {
		// Scheduled jobs wait for the test to run them.
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai', 'mail.external', 'postbox.aiDraft']);
		const count = PREDECESSOR_BUDGET + 1;
		const { mailboxId, threadId, messageId: first } = await seedMailThread(t, { text: text('p0') });
		const predecessors: Id<'mailMessages'>[] = [first];
		for (let i = 1; i < count; i++) {
			predecessors.push(
				await addMessageToThread(
					t,
					{ mailboxId, threadId },
					{ text: text(`p${i}`), receivedAt: T0 + i * 60_000 }
				)
			);
		}
		const candidate = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: text('ask'), receivedAt: T0 + count * 60_000 }
		);
		await t.run(async (ctx) => {
			for (const id of predecessors) {
				await captureInterpretSource(ctx, { source: { kind: 'mail', id }, isLive: true });
				await deferSource(ctx, `mail:${id}`, 'display_only');
			}
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: candidate }, isLive: true });
			await ctx.db.patch(threadId, { latestMessageId: candidate, needsReplyPendingAt: Date.now() });
		});
		const args = { threadId, interpretMessageId: candidate };

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, args);

		// The first run read the budget's worth, oldest first, and not the candidate.
		expect(readTags()).toEqual(Array.from({ length: PREDECESSOR_BUDGET }, (_, i) => `p${i}`));
		let thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.needsReplyPendingAt).toBeDefined();
		expect(thread?.needsReply).toMatchObject({ source: 'heuristic' });
		// The CLASSIFIER continues (not a bare interpretation run).
		expect(await pendingJobs(t, 'needsReplyClassify')).toContainEqual(args);
		expect(await pendingJobs(t, 'interpret/run')).toEqual([]);

		// The continuation (the scheduled job, run here).
		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, args);

		expect(readTags()).toEqual([...Array.from({ length: count }, (_, i) => `p${i}`), 'ask']);
		thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		expect(thread?.needsReply).toMatchObject({ messageId: candidate, source: 'llm' });
		expect(thread?.needsReply?.clarification?.questions).toEqual([
			expect.objectContaining({ slotType: 'attachment', answerKind: 'file' }),
		]);
		// The owner is asked first: no reply is drafted until the file is given.
		expect(await pendingJobs(t, 'draftOnArrival')).toEqual([]);
		vi.useRealTimers();
	});
});
