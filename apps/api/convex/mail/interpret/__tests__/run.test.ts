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
import { actionsModelSchema, briefModelSchema } from '../schema';
import { modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource } from '../sources';

/** Seed a message and take its enqueue-time snapshot, as delivery does. */
async function seedCaptured(
	t: Test,
	seed: Parameters<typeof seedMailThread>[1] & { isLive?: boolean } = {}
) {
	const seeded = await seedMailThread(t, seed);
	await t.run(async (ctx) =>
		captureInterpretSource(ctx, {
			source: { kind: 'mail', id: seeded.messageId },
			isLive: seed.isLive ?? true,
		})
	);
	return seeded;
}

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
	llm.spend.mockReset();
	llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
		if (schema === briefModelSchema) {
			return {
				object: modelOutput('s0'),
				tokenUsage: { totalTokens: 10 },
				modelUsed: 'stub-model',
			};
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
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
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
		expect(items[0]).toMatchObject({
			mailThreadId: threadId,
			verify: 'passed',
			responsibility: 'us',
		});
		expect(llm.spend.mock.calls.map((c) => c[1])).toEqual(['interpret', 'interpret_verify']);
		// The verifier read the claim and its quote, nothing else.
		const verifyPrompt = llm.runLlmObject.mock.calls[1]?.[0]?.prompt as string;
		expect(verifyPrompt).toContain('CLAIM item:0');
		expect(verifyPrompt).toContain('send me the signed contract by Friday');
	});

	it('reuses an applied revision instead of calling the model again', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedCaptured(t, { text: TEXT });
		await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		llm.runLlmObject.mockClear();
		const again = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(again).toMatchObject({
			status: 'complete',
			isReplayed: true,
			projection: { askSummary: 'Send Jonas the signed contract' },
		});
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('records ai_off as an incomplete brief without calling the model', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
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
		const { messageId } = await seedCaptured(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'failed', errorCode: 'model_error' });
	});

	it('skips a muted thread and backfilled mail without a model call', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedCaptured(t, { text: TEXT, isLive: false });
		const source = { kind: 'mail' as const, id: messageId };
		const backfill = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(backfill).toMatchObject({ status: 'skipped', errorCode: 'not_live' });
		// A retry decides on the enqueue snapshot: a caller claiming "live" changes nothing.
		expect(
			await t.action(internal.mail.interpret.run.interpretMessage, { source, isLive: true })
		).toMatchObject({ status: 'skipped', isReplayed: true });

		const second = await seedMailThread(t, { text: TEXT, address: 'two@owlat.test' });
		await t.run(async (ctx) => ctx.db.patch(second.threadId, { mutedAt: 1 }));
		await t.run(async (ctx) =>
			captureInterpretSource(ctx, { source: { kind: 'mail', id: second.messageId }, isLive: true })
		);
		const muted = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: second.messageId },
		});
		expect(muted).toMatchObject({ status: 'skipped', errorCode: 'muted' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('does not interpret a message without an enqueue snapshot (F15)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedMailThread(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
			isLive: true,
		});
		expect(out).toMatchObject({ status: 'skipped', errorCode: 'no_snapshot' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('reports a partial run as partial, and repairs it once its retry is due (F2)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		// The first verifier call fails: the run is partial ('verify').
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			if (schema === briefModelSchema) return { object: modelOutput('s0') };
			throw new Error('verifier down');
		});
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
		const source = { kind: 'mail' as const, id: messageId };
		const first = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(first).toMatchObject({ status: 'partial', isReplayed: false, errorCode: 'verify' });
		if (first.status === 'gone') throw new Error('unreachable');
		expect(first.retryAt).toBeGreaterThan(Date.now());

		// Not due yet: reported as partial, never as a bare replay.
		llm.runLlmObject.mockClear();
		const early = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(early).toMatchObject({ status: 'partial', isReplayed: true });
		expect(llm.runLlmObject).not.toHaveBeenCalled();

		// Due: the repair runs, the verifier answers, the thread is rebuilt without duplicates.
		await t.run(async (ctx) => {
			const row = await ctx.db.query('messageInterpretations').first();
			if (row) await ctx.db.patch(row._id, { nextRetryAt: 0 });
		});
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) =>
			schema === briefModelSchema
				? { object: modelOutput('s0') }
				: { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } }
		);
		const repaired = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(repaired).toMatchObject({ status: 'complete', isReplayed: false });
		const items = await t.run(async (ctx) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.collect()
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ verify: 'passed', status: 'open' });
		const brief = await t.run(async (ctx) => ctx.db.query('threadBriefs').first());
		expect(brief).toMatchObject({
			completeness: 'complete',
			sourceCounts: { complete: 1, partial: 0 },
		});
	});

	it('drops a claim the verifier rejects', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) =>
			schema === briefModelSchema
				? { object: modelOutput('s0') }
				: { object: { verdicts: [{ claimId: 'item:0', verdict: 'unsupported' }] } }
		);
		const { messageId } = await seedCaptured(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'complete', createdItemIds: [] });
	});

	it('checks the body on every attempt and records a body that keeps changing (round 2 F1)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
		let edits = 0;
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			if (schema === briefModelSchema) {
				// The body changes while every extraction is in flight.
				edits++;
				await t.run(async (ctx) =>
					ctx.db.patch(messageId, { textBodyInline: `${TEXT} (edit ${edits})` })
				);
				return { object: modelOutput('s0') };
			}
			return { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } };
		});
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'failed', errorCode: 'source_changed' });
		expect(edits).toBe(2);
		const items = await t.run(async (ctx) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.collect()
		);
		expect(items).toEqual([]);
	});

	it('re-extracts when the mailbox changes scope under the run (round 2 F6)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId, threadId, mailboxId } = await seedCaptured(t, { text: TEXT });
		const schemas: unknown[] = [];
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			schemas.push(schema);
			if (schema === briefModelSchema) {
				// The owner converts the mailbox to a team inbox meanwhile.
				await t.run(async (ctx) => ctx.db.patch(mailboxId, { scope: 'shared' }));
				return { object: modelOutput('s0') };
			}
			if (schema === actionsModelSchema) {
				const { latest: _l, facts: _f, ...actions } = modelOutput('s0');
				return { object: { ...actions, mode: 'actions' } };
			}
			return { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } };
		});
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'complete' });
		expect(schemas.filter((x) => x === briefModelSchema)).toHaveLength(1);
		expect(schemas.filter((x) => x === actionsModelSchema)).toHaveLength(1);
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows.every((r) => r.mode === 'actions')).toBe(true);
		const brief = await t.run(async (ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(brief?.mode).toBe('actions');
		expect(await t.run(async (ctx) => ctx.db.query('threadFacts').collect())).toEqual([]);
	});
});
