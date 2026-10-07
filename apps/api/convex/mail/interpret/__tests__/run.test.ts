/**
 * `interpretMessage` end to end with a stubbed model (mail/interpret/run.ts):
 * load → scope → segment → gate → model → ground → verify → reduce, the
 * fail-soft paths, eligibility skips, and dedupe of an applied revision.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { modules, seedMailThread } from './interpret.testlib';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn(), spend: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', () => ({ runLlmObject: llm.runLlmObject }));
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));
vi.mock('../../../analytics/llmUsage', () => ({ recordLlmSpend: llm.spend }));

const TEXT = 'Could you send me the signed contract by Friday?';

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
				display: { en: 'Send Jonas the signed contract', de: 'Schick Jonas den unterschriebenen Vertrag' },
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
			en: [{ text: 'Jonas wants the signed contract.', quotes: [{ segmentId, text: 'signed contract' }] }],
			de: [{ text: 'Jonas will den Vertrag.', quotes: [{ segmentId, text: 'signed contract' }] }],
		},
		facts: [],
	};
}

beforeEach(() => {
	llm.runLlmObject.mockReset();
	llm.spend.mockReset();
	llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
		if (schema === briefModelSchema) {
			return { object: modelOutput('s0'), tokenUsage: { totalTokens: 10 }, modelUsed: 'stub-model' };
		}
		// The verifier: support every claim it is asked about.
		return {
			object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] },
			tokenUsage: { totalTokens: 2 },
			modelUsed: 'stub-model',
		};
	});
});

describe('interpretMessage', () => {
	it('interprets, verifies and folds the message into its thread', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId, threadId } = await seedMailThread(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({
			status: 'complete',
			createdItemIds: [expect.any(String)],
			projection: {
				replyIntent: 'request_for_action',
				askSummary: 'Send Jonas the signed contract',
				dueHint: '2026-10-09',
				isOnlyTheirs: false,
			},
		});
		const items = await t.run(async (ctx) => ctx.db.query('threadItems').collect());
		expect(items[0]).toMatchObject({ mailThreadId: threadId, verify: 'passed', responsibility: 'us' });
		expect(llm.spend.mock.calls.map((c) => c[1])).toEqual(['interpret', 'interpret_verify']);
		// The verifier read the claim and its quote, nothing else.
		const verifyPrompt = llm.runLlmObject.mock.calls[1]?.[0]?.prompt as string;
		expect(verifyPrompt).toContain('CLAIM item:0');
		expect(verifyPrompt).toContain('send me the signed contract by Friday');
	});

	it('reuses an applied revision instead of calling the model again', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedMailThread(t, { text: TEXT });
		await t.action(internal.mail.interpret.run.interpretMessage, { source: { kind: 'mail', id: messageId } });
		llm.runLlmObject.mockClear();
		const again = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(again).toMatchObject({ status: 'replayed', projection: { askSummary: 'Send Jonas the signed contract' } });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('records ai_off as an incomplete brief without calling the model', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'failed', errorCode: 'ai_off' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const brief = await t.run(async (ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(brief?.completeness).toBe('partial');
	});

	it('fails soft when the model throws', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		llm.runLlmObject.mockRejectedValue(new Error('provider down'));
		const { messageId } = await seedMailThread(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'failed', errorCode: 'model_error' });
	});

	it('skips a muted thread and backfilled mail without a model call', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedMailThread(t, { text: TEXT });
		const backfill = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
			isLive: false,
		});
		expect(backfill).toMatchObject({ status: 'skipped' });
		// A second look at the same skipped message is a replay, not a second row.
		expect(
			await t.action(internal.mail.interpret.run.interpretMessage, {
				source: { kind: 'mail', id: messageId },
				isLive: false,
			})
		).toMatchObject({ status: 'replayed' });

		const second = await seedMailThread(t, { text: TEXT, address: 'two@owlat.test' });
		await t.run(async (ctx) => ctx.db.patch(second.threadId, { mutedAt: 1 }));
		const muted = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: second.messageId },
		});
		expect(muted).toMatchObject({ status: 'skipped' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('drops a claim the verifier rejects', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) =>
			schema === briefModelSchema
				? { object: modelOutput('s0') }
				: { object: { verdicts: [{ claimId: 'item:0', verdict: 'unsupported' }] } }
		);
		const { messageId } = await seedMailThread(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'complete', createdItemIds: [] });
	});
});
