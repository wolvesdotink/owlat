/**
 * Review round 4 regressions of the thread brief erasure (Sol F1–F5): undo
 * ends with any erasure, incomplete provenance redacts the unstamped fields,
 * a refill touches only redacted fields, the range-read cap holds, and the
 * brief's completeness follows outstanding repairs in either order.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { threadRefToFields, type ThreadRef } from '../../../lib/validators/threadRef';
import type { InterpretationSource } from '../../../lib/validators/threadBrief';
import { openMessageBody, sealBodyAtWrite } from '../../../lib/messageBody';
import { MAX_RANGE_READS, unitBudget, type DrainBudget } from '../purgeDrain';
import { drivePurgeJob } from '../purgeRun';
import { mailMessageSources } from '../purge';
import { modules, reduceItem, reduceResult, seedMailThread, type Test } from './interpret.testlib';
import { SENT, addSibling, applyArgs, insertItem } from './purge.testlib';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

let jobs = 0;
async function drive(
	t: Test,
	fields: Parameters<typeof drivePurgeJob>[2],
	budget: () => DrainBudget = () => unitBudget(400)
): Promise<number> {
	const key = `test-${jobs++}`;
	for (let slice = 1; slice <= 200; slice++) {
		if (await t.run((ctx) => drivePurgeJob(ctx, key, fields, budget()))) return slice;
	}
	throw new Error('purge never finished');
}

async function threadOfThree(t: Test) {
	const { messageId: a, threadId } = await seedMailThread(t);
	const b = await addSibling(t, a);
	const c = await addSibling(t, a);
	return {
		threadId,
		ref: { kind: 'mail' as const, id: threadId },
		srcA: { kind: 'mail' as const, id: a },
		srcB: { kind: 'mail' as const, id: b },
		srcC: { kind: 'mail' as const, id: c },
	};
}

async function completeRead(
	ctx: MutationCtx,
	ref: ThreadRef,
	source: InterpretationSource,
	items: ReturnType<typeof reduceItem>[] = []
) {
	const sourceKey = `${source.kind}:${source.id}`;
	await ctx.db.insert('messageInterpretations', {
		...threadRefToFields(ref),
		source,
		sourceKey,
		contentRevision: 'rev-1',
		extractorVersion: 1,
		mode: 'brief',
		status: 'complete',
		payload: await sealBodyAtWrite(JSON.stringify(reduceResult({ items }))),
		deletionEpoch: 0,
		isCurrent: true,
		isCounted: true,
		sourceAt: SENT,
		appliedAt: SENT,
		createdAt: SENT,
		updatedAt: SENT,
	});
	await ctx.db.insert('interpretSources', {
		...threadRefToFields(ref),
		source,
		sourceKey,
		eligibility: {
			isLive: true,
			isThreadMuted: false,
			isBulkHeaderPresent: false,
			isSenderKnown: true,
		},
		createdAt: SENT,
		updatedAt: SENT,
	});
}

describe('F1: an erasure ends undo on every item of the thread', () => {
	it('drops the snapshot that would restore A’s deadline, and those of untouched items', async () => {
		const t = convexTest(schema, modules);
		const { ref, srcA, srcB, srcC } = await threadOfThree(t);
		const snapshot = {
			kind: 'heldChange' as const,
			confirmation: { by: 'user-A', at: SENT, kind: 'confirmed' as const },
			verify: 'passed' as const,
			due: { phrase: 'by Friday', at: Date.UTC(2026, 9, 9), isAmbiguous: false },
			addedEvidenceKeys: [`mail:${srcB.id}|rev-1|s1:0:4`],
		};
		const ids = await t.run(async (ctx) => ({
			replaced: await insertItem(ctx, ref, [srcA, srcB], {
				due: { phrase: 'by Monday', at: Date.UTC(2026, 9, 12), isAmbiguous: false },
				correction: { by: 'user-A', at: SENT, kind: 'confirmed' },
				confirmedFrom: snapshot,
			}),
			elsewhere: await insertItem(ctx, ref, [srcC], { confirmedFrom: snapshot }),
		}));

		await drive(t, { ref, kind: 'sources', sources: [srcA] });

		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.replaced))?.confirmedFrom).toBeUndefined();
			expect((await ctx.db.get(ids.elsewhere))?.confirmedFrom).toBeUndefined();
		});
	});
});

describe('F2: incomplete provenance redacts what is unstamped', () => {
	it('redacts unstamped wording and parties, keeps a field another source stamped', async () => {
		const t = convexTest(schema, modules);
		const { ref, srcA, srcB } = await threadOfThree(t);
		const deadline = { phrase: 'by Monday', at: Date.UTC(2026, 9, 12), isAmbiguous: false };
		const itemId = await t.run((ctx) =>
			insertItem(ctx, ref, [srcA, srcB], {
				requester: { email: 'ann@example.com', name: 'Ann', isUs: false },
				due: deadline,
				// Only the deadline is stamped (by surviving B): the rest predates provenance.
				fieldSources: { due: { sourceKey: `mail:${srcB.id}`, at: SENT } },
			})
		);

		await drive(t, { ref, kind: 'sources', sources: [srcA] });

		const item = (await t.run((ctx) => ctx.db.get(itemId)))!;
		expect(await openMessageBody(item.assertion)).toBe('Details removed with the deleted message');
		expect(item.requester).toEqual({ isUs: false });
		expect(item.due).toEqual(deadline);
		expect(item.redactedFields).toEqual(expect.arrayContaining(['assertion', 'requester']));
		expect(item.redactedFields).not.toContain('due');
	});
});

describe('F3: a refill touches only the redacted fields', () => {
	it('re-reading older A refills the deadline and leaves C’s wording, parties and amount', async () => {
		const t = convexTest(schema, modules);
		const { messageId: a, threadId } = await seedMailThread(t);
		const c = await addSibling(t, a);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, applyArgs(c, threadId));
		const { item, brief } = await t.run(async (ctx) => {
			const row = (await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first())!;
			await ctx.db.patch(row._id, {
				due: undefined,
				amount: { value: 700, currency: 'EUR' },
				redactedFields: ['due'],
			});
			return {
				item: (await ctx.db.get(row._id))!,
				brief: (await ctx.db
					.query('threadBriefs')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
					.first())!,
			};
		});
		const deadline = { phrase: 'by Friday', at: Date.UTC(2026, 9, 9), isAmbiguous: false };

		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			...applyArgs(a, threadId),
			expectedRevision: brief.interpretationRevision,
			deletionEpoch: brief.deletionEpoch,
			sourceAt: SENT - 60_000,
			result: reduceResult({
				items: [
					reduceItem({
						matchItemId: item._id,
						assertion: 'Send an old draft of the contract',
						display: { en: 'Send an old draft', de: 'Schick einen alten Entwurf' },
						requester: { email: 'old@example.com', isUs: false },
						due: deadline,
						amount: undefined,
						verify: 'passed',
					}),
				],
				latest: undefined,
			}),
		});

		const after = (await t.run((ctx) => ctx.db.get(item._id)))!;
		expect(after.due).toEqual(deadline);
		expect(after.redactedFields).toBeUndefined();
		expect(after.fieldSources?.due?.sourceKey).toBe(`mail:${a}`);
		expect(after.amount).toEqual({ value: 700, currency: 'EUR' });
		expect(after.requester).toEqual(item.requester);
		expect(await openMessageBody(after.assertion)).toBe(await openMessageBody(item.assertion));
	});
});

describe('F4: the range-read cap holds over many empty sub-ranges', () => {
	it('never queries more than the cap in a slice, and finishes', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		const ids = await t.run(async (ctx) => {
			const { _id, _creationTime, ...first } = (await ctx.db.get(messageId))!;
			const out: Id<'mailMessages'>[] = [messageId];
			for (let i = 0; i < 400; i++) {
				out.push(await ctx.db.insert('mailMessages', { ...first, uid: first.uid + i + 1 }));
			}
			return out;
		});
		const perSlice: number[] = [];
		const counting = (): DrainBudget => {
			const budget = unitBudget(1_000_000, 1024 * 1024 * 1024);
			let ranges = 0;
			perSlice.push(0);
			return {
				...budget,
				range: () => {
					ranges += 1;
					perSlice[perSlice.length - 1] = ranges;
					budget.range();
				},
			};
		};

		const slices = await drive(
			t,
			{ ref, kind: 'sources', sources: ids.flatMap(mailMessageSources) },
			counting
		);

		expect(slices).toBeGreaterThan(1);
		expect(Math.max(...perSlice)).toBeLessThanOrEqual(MAX_RANGE_READS);
	});
});

describe('F5: completeness follows outstanding repairs', () => {
	async function redactedThread(t: Test) {
		const { threadId, ref, srcA, srcB, srcC } = await threadOfThree(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('threadBriefs', {
				...threadRefToFields(ref),
				mode: 'brief',
				sourceRevision: 1,
				interpretationRevision: 1,
				lastActivitySeq: 0,
				completeness: 'complete',
				sourceCounts: { complete: 1, partial: 0, failed: 0, unreadable: 0, skipped: 0 },
				deletionEpoch: 0,
				updatedAt: SENT,
			});
			await completeRead(ctx, ref, srcB);
			await insertItem(ctx, ref, [srcA, srcB]);
			await insertItem(ctx, ref, [srcC]);
		});
		return { threadId, ref, srcA, srcB, srcC };
	}
	const briefOf = (t: Test, threadId: Id<'mailThreads'>) =>
		t.run(async (ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
	/** B's repair run recording its result, as the reducer does. */
	async function landRepair(t: Test, threadId: Id<'mailThreads'>, b: Id<'mailMessages'>) {
		const brief = (await briefOf(t, threadId))!;
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			...applyArgs(b, threadId),
			expectedRevision: brief.interpretationRevision,
			deletionEpoch: brief.deletionEpoch,
			retryCount: 1,
			result: reduceResult({ items: [], latest: undefined }),
		});
	}

	it('repair after settlement: partial while outstanding, complete once it lands', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ref, srcA, srcB } = await redactedThread(t);

		await drive(t, { ref, kind: 'sources', sources: [srcA] });
		expect(await briefOf(t, threadId)).toMatchObject({
			pendingRepairs: 1,
			completeness: 'partial',
		});

		await landRepair(t, threadId, srcB.id);
		const brief = (await briefOf(t, threadId))!;
		expect(brief.pendingRepairs).toBeUndefined();
		expect(brief.completeness).toBe('complete');
	});

	it('repair before a later settlement: the settlement derives complete, never forces partial', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ref, srcA, srcB, srcC } = await redactedThread(t);
		await drive(t, { ref, kind: 'sources', sources: [srcA] });
		await landRepair(t, threadId, srcB.id);

		// A second purge that settles after the repair landed (C held only its own item).
		await drive(t, { ref, kind: 'sources', sources: [srcC] });

		const brief = (await briefOf(t, threadId))!;
		expect(brief.pendingRepairs).toBeUndefined();
		expect(brief.completeness).toBe('complete');
	});
});
