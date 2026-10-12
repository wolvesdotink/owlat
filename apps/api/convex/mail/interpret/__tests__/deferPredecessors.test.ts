/**
 * D10 with Sol r2 F1: a source turning eager reads its thread's EARLIER
 * deferred sources first. An earlier message (an invoice) can hold the item a
 * later one cancels or completes; the later run reads only items that exist,
 * so the earlier one is promoted (outstanding again) and interpreted first,
 * oldest first, for an inbound and for an outbound (sent) eager source.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { addMessageToThread, modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource } from '../sources';
import { STALE_MS, deferSource } from '../outstanding';
import { PREDECESSOR_RETRY_MS, resumeDeferredSources, runDeferredPredecessors } from '../defer';
import type { InterpretationSource } from '../../../lib/validators/threadBrief';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn(), spend: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', () => ({ runLlmObject: llm.runLlmObject }));
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));
vi.mock('../../../analytics/llmUsage', () => ({ recordLlmSpend: llm.spend }));

const INVOICE = 'Invoice 77: could you send me the signed contract by Friday?';
const CANCEL = 'Never mind, no need to send me the signed contract by Friday anymore.';
const SENT = 'Here it is: you asked me to send me the signed contract by Friday, attached.';

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

/** Which message each interpretation prompt read, in call order. */
const readOrder = () =>
	llm.runLlmObject.mock.calls
		.filter(([opts]) => (opts as { schema: unknown }).schema === briefModelSchema)
		.map(([opts]) => {
			const text = JSON.stringify(opts);
			return text.includes('Invoice 77')
				? 'invoice'
				: text.includes('Never mind')
					? 'cancel'
					: text.includes('Here it is')
						? 'sent'
						: '?';
		});

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
		return {
			object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] },
			tokenUsage: { totalTokens: 2 },
			modelUsed: 'stub-model',
		};
	});
});

const T0 = Date.UTC(2026, 9, 7, 9, 0);

/** An invoice thread whose first message was deferred (display-only). */
async function seedDeferredInvoice(t: Test) {
	const seeded = await seedMailThread(t, { text: INVOICE });
	await t.run(async (ctx) => {
		await captureInterpretSource(ctx, {
			source: { kind: 'mail', id: seeded.messageId },
			isLive: true,
		});
		await deferSource(ctx, `mail:${seeded.messageId}`, 'display_only');
	});
	return seeded;
}

async function snapshotOf(t: Test, source: InterpretationSource) {
	return t.run((ctx) =>
		ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', `${source.kind}:${source.id}`))
			.first()
	);
}

async function capture(t: Test, source: InterpretationSource) {
	await t.run((ctx) => captureInterpretSource(ctx, { source, isLive: true }));
}

describe('D10: an eager run reads its deferred predecessors first (Sol r2 F1)', () => {
	it('inbound: the later message is read after the deferred invoice', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { mailboxId, threadId, messageId: invoiceId } = await seedDeferredInvoice(t);
		const cancelId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: CANCEL, receivedAt: T0 + 60_000 }
		);
		const cancel = { kind: 'mail' as const, id: cancelId };
		await capture(t, cancel);

		await t.action(internal.mail.interpret.run.interpretMessage, { source: cancel });

		expect(readOrder()).toEqual(['invoice', 'cancel']);
		const invoice = await snapshotOf(t, { kind: 'mail', id: invoiceId });
		expect(invoice?.isDeferred).toBeUndefined();
		expect(invoice?.isOutstanding).toBeUndefined();
		const brief = await t.run((ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(brief?.deferredSources).toBeUndefined();
		expect(brief?.pendingSources).toBeUndefined();
	});

	it('outbound: a sent reply is read after the deferred invoice', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { mailboxId, threadId } = await seedDeferredInvoice(t);
		const sentId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{
				text: SENT,
				receivedAt: T0 + 60_000,
				fromAddress: 'me@owlat.test',
			}
		);
		await t.run((ctx) => ctx.db.patch(sentId, { outbound: { state: 'sent', recipients: [] } }));
		const sent = { kind: 'outboundMail' as const, id: sentId };
		await capture(t, sent);

		await t.action(internal.mail.interpret.outboundRun.interpretSent, { source: sent });

		expect(readOrder()).toEqual(['invoice', 'sent']);
	});

	it('a deferred message LATER than the eager one stays deferred', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { mailboxId, threadId, messageId: firstId } = await seedMailThread(t, { text: INVOICE });
		const laterId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: CANCEL, receivedAt: T0 + 60_000 }
		);
		await t.run(async (ctx) => {
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: laterId }, isLive: true });
			await deferSource(ctx, `mail:${laterId}`, 'display_only');
		});
		const first = { kind: 'mail' as const, id: firstId };
		await capture(t, first);

		await t.action(internal.mail.interpret.run.interpretMessage, { source: first });

		expect(readOrder()).toEqual(['invoice']);
		expect((await snapshotOf(t, { kind: 'mail', id: laterId }))?.isDeferred).toBe(true);
	});

	it('runs nothing out of order on a thread with no deferred mail', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedMailThread(t, { text: INVOICE });
		const only = { kind: 'mail' as const, id: messageId };
		await capture(t, only);
		await t.action(internal.mail.interpret.run.interpretMessage, { source: only });
		expect(readOrder()).toEqual(['invoice']);
	});
});

/**
 * Sol r3: the loop takes the OLDEST remaining deferred predecessor, reads it,
 * and only its committed run clears its deferral. Bounded per action, with a
 * reschedule of the eager source; crash-safe because what was not read is
 * still deferred, in place.
 */
describe('D10: the predecessor loop is bounded and crash-safe (Sol r3)', () => {
	const TAG = /\[(\w)\]/;
	const readTags = () =>
		llm.runLlmObject.mock.calls
			.filter(([opts]) => (opts as { schema: unknown }).schema === briefModelSchema)
			.map(([opts]) => JSON.stringify(opts).match(TAG)?.[1] ?? '?');
	const text = (tag: string) => `[${tag}] could you send me the signed contract by Friday?`;

	/** Three deferred messages a < b < c, then the eager message d (captured outstanding). */
	async function seedChain(t: Test) {
		const { mailboxId, threadId, messageId: a } = await seedMailThread(t, { text: text('a') });
		const ids: Record<string, Id<'mailMessages'>> = { a };
		for (const [i, tag] of ['b', 'c', 'd'].entries()) {
			ids[tag] = await addMessageToThread(
				t,
				{ mailboxId, threadId },
				{ text: text(tag), receivedAt: T0 + (i + 1) * 60_000 }
			);
		}
		await t.run(async (ctx) => {
			for (const tag of ['a', 'b', 'c']) {
				await captureInterpretSource(ctx, {
					source: { kind: 'mail', id: ids[tag]! },
					isLive: true,
				});
				await deferSource(ctx, `mail:${ids[tag]}`, 'display_only');
			}
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: ids['d']! }, isLive: true });
		});
		return { ids, threadId, eager: { kind: 'mail' as const, id: ids['d']! } };
	}

	const deferredTags = async (t: Test, ids: Record<string, Id<'mailMessages'>>) => {
		const out: string[] = [];
		for (const tag of ['a', 'b', 'c']) {
			if ((await snapshotOf(t, { kind: 'mail', id: ids[tag]! }))?.isDeferred) out.push(tag);
		}
		return out;
	};

	/** The loop as `runInterpretation` drives it, with an injected budget and runner. */
	function loop(
		t: Test,
		source: InterpretationSource,
		run: (s: InterpretationSource) => Promise<unknown>,
		budget?: number
	) {
		const scheduled: { delayMs: number; args: unknown }[] = [];
		const ctx = {
			runQuery: t.query,
			runMutation: t.mutation,
			scheduler: {
				runAfter: async (delayMs: number, _ref: unknown, args: unknown) => {
					scheduled.push({ delayMs, args });
				},
			},
		} as unknown as Parameters<typeof runDeferredPredecessors>[0];
		const done = runDeferredPredecessors(ctx, source, run, budget ? { budget } : {});
		return { done, scheduled };
	}

	const realRun = (t: Test) => (s: InterpretationSource) =>
		t.action(internal.mail.interpret.run.interpretMessage, { source: s });

	it('more predecessors than the budget: reads the oldest ones, reschedules, then the rest', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { ids, eager } = await seedChain(t);

		const first = loop(t, eager, realRun(t), 2);
		expect(await first.done).toEqual({ retryAt: expect.any(Number) });
		expect(readTags()).toEqual(['a', 'b']);
		expect(await deferredTags(t, ids)).toEqual(['c']);
		// The eager source's own run is rescheduled to resume the loop.
		expect(first.scheduled).toEqual([{ delayMs: 0, args: { source: eager } }]);

		const second = loop(t, eager, realRun(t), 2);
		expect(await second.done).toBeNull();
		expect(readTags()).toEqual(['a', 'b', 'c']);
		expect(await deferredTags(t, ids)).toEqual([]);
	});

	it('a crash after one predecessor completes: the retry resumes at the next', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { ids, eager } = await seedChain(t);
		let calls = 0;
		const dying = (s: InterpretationSource) => {
			calls++;
			if (calls === 2) throw new Error('action killed');
			return realRun(t)(s);
		};
		await expect(loop(t, eager, dying).done).rejects.toThrow('action killed');
		expect(readTags()).toEqual(['a']);
		expect(await deferredTags(t, ids)).toEqual(['b', 'c']);

		// The retry of the eager source (the real run) resumes in order, then reads itself.
		await t.action(internal.mail.interpret.run.interpretMessage, { source: eager });
		expect(readTags()).toEqual(['a', 'b', 'c', 'd']);
		expect(await deferredTags(t, ids)).toEqual([]);
	});

	it('a crash before any completes: nothing moved, the stale sweep re-runs only the eager source', async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules);
			await enableFeatures(t, ['ai']);
			const { ids, eager } = await seedChain(t);
			const dead = async () => {
				throw new Error('action killed');
			};
			await expect(loop(t, eager, dead).done).rejects.toThrow('action killed');
			expect(readTags()).toEqual([]);
			expect(await deferredTags(t, ids)).toEqual(['a', 'b', 'c']);

			vi.advanceTimersByTime(STALE_MS * 2);
			expect(await t.mutation(internal.mail.interpret.outstanding.sweep, {})).toEqual({
				rerun: 1,
				unread: 0,
			});
			const rerun = await t.run(async (ctx) =>
				(await ctx.db.system.query('_scheduled_functions').collect())
					.filter((job) => job.state.kind === 'pending' && job.name.includes('interpretMessage'))
					.map((job) => job.args[0])
			);
			// Never a deferred predecessor on its own.
			expect(rerun).toEqual([{ source: eager }]);
		} finally {
			vi.useRealTimers();
		}
		const t2 = convexTest(schema, modules);
		await enableFeatures(t2, ['ai']);
		const chain = await seedChain(t2);
		await t2.action(internal.mail.interpret.run.interpretMessage, { source: chain.eager });
		expect(readTags()).toEqual(['a', 'b', 'c', 'd']);
	});

	it('a predecessor its own run did not settle: look again later, do not spin', async () => {
		const t = convexTest(schema, modules);
		const { ids, eager } = await seedChain(t);
		const noop = vi.fn(async () => undefined);
		const { done, scheduled } = loop(t, eager, noop);
		expect(await done).toEqual({ retryAt: expect.any(Number) });
		expect(noop).toHaveBeenCalledTimes(1);
		expect(scheduled).toEqual([{ delayMs: PREDECESSOR_RETRY_MS, args: { source: eager } }]);
		expect(await deferredTags(t, ids)).toEqual(['a', 'b', 'c']);
	});
});

/**
 * Sol r4 F2: the oldest predecessor and the newest deferred source come from
 * the thread-order index, one indexed read each, whatever the backlog, and in
 * thread order however the rows were written.
 */
describe('D10: indexed thread order (Sol r4 F2)', () => {
	const settleRun =
		(t: Test, order: string[], tags: Map<string, string>) => async (s: InterpretationSource) => {
			order.push(tags.get(s.id as string) ?? '?');
			// What a committed run does to a deferred source: settle it.
			await t.mutation(internal.mail.interpret.outstanding.settleRecorded, { source: s });
		};

	function drive(
		t: Test,
		source: InterpretationSource,
		run: (s: InterpretationSource) => Promise<unknown>,
		budget: number
	) {
		const ctx = {
			runQuery: t.query,
			runMutation: t.mutation,
			scheduler: { runAfter: async () => undefined },
		} as unknown as Parameters<typeof runDeferredPredecessors>[0];
		return runDeferredPredecessors(ctx, source, run, { budget });
	}

	/** `count` deferred predecessors written NEWEST first, then the eager message. */
	async function seedBacklog(t: Test, count: number) {
		const { mailboxId, threadId, messageId: seedId } = await seedMailThread(t, { text: INVOICE });
		const tags = new Map<string, string>();
		const ids: Id<'mailMessages'>[] = [];
		for (let i = count - 1; i >= 0; i--) {
			const id = await addMessageToThread(
				t,
				{ mailboxId, threadId },
				{
					text: `[p${i}] ${INVOICE}`,
					receivedAt: T0 + (i + 1) * 60_000,
				}
			);
			tags.set(id, `p${i}`);
			ids.push(id);
		}
		await t.run(async (ctx) => {
			for (const id of ids) {
				await captureInterpretSource(ctx, { source: { kind: 'mail', id }, isLive: true });
				await deferSource(ctx, `mail:${id}`, 'display_only');
			}
		});
		const eagerId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{
				text: CANCEL,
				receivedAt: T0 + (count + 1) * 60_000,
			}
		);
		await capture(t, { kind: 'mail', id: eagerId });
		return { threadId, seedId, tags, ids, eager: { kind: 'mail' as const, id: eagerId } };
	}

	it('a large backlog is read in thread order, a few per run, to the end', async () => {
		const t = convexTest(schema, modules);
		const { tags, eager } = await seedBacklog(t, 30);
		const order: string[] = [];
		let runs = 0;
		while ((await drive(t, eager, settleRun(t, order, tags), 4)) !== null) runs++;
		expect(order).toEqual(Array.from({ length: 30 }, (_, i) => `p${i}`));
		expect(runs).toBe(Math.ceil(30 / 4) - 1);
	});

	it('a legacy deferred row without an order key is read first', async () => {
		const t = convexTest(schema, modules);
		const { tags, ids, eager } = await seedBacklog(t, 3);
		// p2 (written first) loses its key, as a row from before the key.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${ids[0]}`))
				.first();
			await ctx.db.patch(row!._id, { sourceOrderKey: undefined });
		});
		const order: string[] = [];
		expect(await drive(t, eager, settleRun(t, order, tags), 10)).toBeNull();
		expect(order).toEqual(['p2', 'p0', 'p1']);
	});

	it('a predecessor whose message is gone is released, not waited on forever', async () => {
		const t = convexTest(schema, modules);
		const { tags, ids, eager } = await seedBacklog(t, 2);
		const gone = ids[ids.length - 1]!; // p0, the oldest
		await t.run((ctx) => ctx.db.delete(gone));
		const order: string[] = [];
		// A gone message's run records nothing (the real run answers `gone`).
		const run = async (s: InterpretationSource) => {
			if (s.id === gone) {
				order.push('gone');
				return;
			}
			await settleRun(t, order, tags)(s);
		};
		expect(await drive(t, eager, run, 10)).toBeNull();
		expect(order).toEqual(['gone', 'p1']);
		expect((await snapshotOf(t, { kind: 'mail', id: gone }))?.isDeferred).toBeUndefined();
	});

	it('opening a thread schedules its newest deferred source, by the index', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedBacklog(t, 5);
		await t.run((ctx) => resumeDeferredSources(ctx, { kind: 'mail', id: threadId }));
		// ids[0] was written first and is the newest (p4).
		expect(await snapshotOf(t, { kind: 'mail', id: ids[0]! })).toMatchObject({
			isOutstanding: true,
		});
		for (const id of ids.slice(1)) {
			expect((await snapshotOf(t, { kind: 'mail', id }))?.isDeferred).toBe(true);
		}
	});
});

/**
 * Sol r5: a keyless deferred row (written before the order key) never matches
 * its own predecessor lookup, a predecessor the loop selected is read without
 * re-entering the selection, and every row deferral writes carries a key.
 */
describe('D10: keyless rows and predecessor mode (Sol r5)', () => {
	it('a keyless deferred row and a later eager source settle with the real runner, no self-recursion', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { mailboxId, threadId, messageId: legacyId } = await seedMailThread(t, { text: INVOICE });
		const legacy = { kind: 'mail' as const, id: legacyId };
		// A deferred row as a release before the key wrote it: inserted directly.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('interpretSources', {
				threadKind: 'mail',
				mailThreadId: threadId,
				source: legacy,
				sourceKey: `mail:${legacyId}`,
				eligibility: {
					isLive: true,
					isThreadMuted: false,
					isBulkHeaderPresent: false,
					isSenderKnown: true,
				},
				isDeferred: true,
				deferredAt: now,
				deferReason: 'display_only',
				createdAt: now,
				updatedAt: now,
			});
		});
		// Its own lookup never returns itself.
		expect(
			await t.query(internal.mail.interpret.defer.oldestDeferredBefore, { source: legacy })
		).toBeNull();

		const cancelId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{
				text: CANCEL,
				receivedAt: T0 + 60_000,
			}
		);
		const cancel = { kind: 'mail' as const, id: cancelId };
		await capture(t, cancel);
		const out = await t.action(internal.mail.interpret.run.interpretMessage, { source: cancel });

		expect(out.status).toBe('complete');
		expect(readOrder()).toEqual(['invoice', 'cancel']);
		expect((await snapshotOf(t, legacy))?.isDeferred).toBeUndefined();
	});

	it('a predecessor read in already_read mode never re-enters the selection', async () => {
		const runQuery = vi.fn();
		const ctx = {
			runQuery,
			runMutation: vi.fn(),
			scheduler: { runAfter: vi.fn() },
		} as unknown as Parameters<typeof runDeferredPredecessors>[0];
		const run = vi.fn();
		const source = { kind: 'mail' as const, id: 'm1' as Id<'mailMessages'> };
		expect(
			await runDeferredPredecessors(ctx, source, run, { predecessors: 'already_read' })
		).toBeNull();
		expect(runQuery).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it('every deferred row carries its order key, and a source without one is not deferred', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId, messageId } = await seedMailThread(t, { text: INVOICE });
		const goneId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{
				text: CANCEL,
				receivedAt: T0 + 60_000,
			}
		);
		const results = await t.run(async (ctx) => {
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: messageId }, isLive: true });
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: goneId }, isLive: true });
			// A legacy capture without a key, then its message gone.
			const goneRow = await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${goneId}`))
				.first();
			await ctx.db.patch(goneRow!._id, { sourceOrderKey: undefined });
			await ctx.db.delete(goneId);
			return {
				kept: await deferSource(ctx, `mail:${messageId}`, 'display_only'),
				gone: await deferSource(ctx, `mail:${goneId}`, 'display_only'),
			};
		});
		expect(results).toEqual({ kept: true, gone: false });
		const kept = await snapshotOf(t, { kind: 'mail', id: messageId });
		expect(kept).toMatchObject({ isDeferred: true, sourceOrderKey: expect.any(String) });
		expect((await snapshotOf(t, { kind: 'mail', id: goneId }))?.isDeferred).toBeUndefined();
	});
});
