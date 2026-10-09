/**
 * Review round 2 regressions of the thread brief erasure (Sol F1–F6): every
 * team reply erased, sub-range progress kept, reads bounded by rows and
 * bytes, survivors rebuilt field by field, no undo of purged values, and a
 * bounced send's `failed` reset.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { threadRefToFields, type ThreadRef } from '../../../lib/validators/threadRef';
import type { InterpretationSource } from '../../../lib/validators/threadBrief';
import { sealBodyAtWrite } from '../../../lib/messageBody';
import { scanRange, unitBudget, type DrainBudget } from '../purgeDrain';
import { CONTINUATION_BYTES, CONTINUATION_UNITS, drivePurgeJob } from '../purgeRun';
import { mailMessageSources } from '../purge';
import { itemLineage } from '../fold';
import { planReaction } from '../reactionRules';
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';
import { SENT, addSibling, insertItem } from './purge.testlib';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const MIB = 1024 * 1024;

/** Drive a sources job in slices of `budget()` until it finishes; the slice count. */
async function drive(
	t: Test,
	fields: Parameters<typeof drivePurgeJob>[2],
	budget: () => DrainBudget
): Promise<number> {
	for (let slice = 1; slice <= 50; slice++) {
		if (await t.run((ctx) => drivePurgeJob(ctx, 'test', fields, budget()))) return slice;
	}
	throw new Error('purge never finished');
}

async function extraction(
	ctx: MutationCtx,
	ref: ThreadRef,
	source: InterpretationSource,
	result: object | null,
	sourceAt = SENT
) {
	return ctx.db.insert('messageInterpretations', {
		...threadRefToFields(ref),
		source,
		sourceKey: `${source.kind}:${source.id}`,
		contentRevision: 'rev-1',
		extractorVersion: 1,
		mode: ref.kind === 'mail' ? 'brief' : 'actions',
		status: 'complete',
		...(result ? { payload: await sealBodyAtWrite(JSON.stringify(result)) } : {}),
		deletionEpoch: 0,
		isCurrent: true,
		isCounted: true,
		sourceAt,
		appliedAt: SENT,
		createdAt: SENT,
		updatedAt: SENT,
	});
}

describe('F1: every team reply of an erased message is erased', () => {
	it('pages 70 replies into the job and erases what each one fed the brief', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const ref = { kind: 'team' as const, id: threadId };
		const replyItems = await t.run(async (ctx) => {
			const items: Id<'threadItems'>[] = [];
			for (let i = 0; i < 70; i++) {
				const sendId = await ctx.db.insert('transactionalSends', {
					kind: 'team_reply',
					email: 'customer@example.com',
					status: 'sent',
					inboundMessageId: inboundId,
				});
				const source = { kind: 'teamReply' as const, id: sendId };
				await extraction(ctx, ref, source, null);
				items.push(await insertItem(ctx, ref, [source]));
			}
			return items;
		});

		await drive(
			t,
			{
				ref,
				kind: 'sources',
				sources: [{ kind: 'inbound', id: inboundId }],
				inboundMessageId: inboundId,
			},
			() => unitBudget(120, 2 * MIB)
		);

		await t.run(async (ctx) => {
			expect(await ctx.db.query('messageInterpretations').collect()).toHaveLength(0);
			for (const id of replyItems) expect(await ctx.db.get(id)).toBeNull();
		});
	});
});

describe('F2: sub-range progress is kept across slices', () => {
	it('finishes a 201-message purge within a few continuation slices', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		const ids = [messageId];
		for (let i = 0; i < 200; i++) ids.push(await addSibling(t, messageId));
		const last = ids[ids.length - 1]!;
		await t.run((ctx) => extraction(ctx, ref, { kind: 'mail', id: last }, null));

		const slices = await drive(
			t,
			{ ref, kind: 'sources', sources: ids.flatMap(mailMessageSources) },
			() => unitBudget(CONTINUATION_UNITS, CONTINUATION_BYTES)
		);

		// ~2,800 sub-range queries: two continuation slices, not a restart loop.
		expect(slices).toBeLessThanOrEqual(3);
		expect(await t.run((ctx) => ctx.db.query('messageInterpretations').collect())).toHaveLength(0);
	});
});

describe('F3: reads are bounded by rows and bytes', () => {
	async function scan(rowBytes: number) {
		const budget = unitBudget(1000, 3 * MIB);
		let charged = 0;
		const counting: DrainBudget = {
			isExhausted: budget.isExhausted,
			chunk: budget.chunk,
			range: budget.range,
			charge: (doc) => {
				charged += 1;
				budget.charge(doc);
			},
		};
		const asked: Array<[number | undefined, number]> = [];
		const rows = Array.from({ length: 10 }, (_, i) => ({ at: i + 1, body: 'x'.repeat(rowBytes) }));
		const outcome = await scanRange(
			counting,
			undefined,
			async (after, n) => {
				asked.push([after as number | undefined, n]);
				return rows.filter((r) => after === undefined || r.at > (after as number)).slice(0, n);
			},
			(row) => row.at,
			async () => true
		);
		return { outcome, asked, charged };
	}

	it('asks for no more rows than the bytes left could hold, and never re-reads', async () => {
		const { outcome, asked, charged } = await scan(10);
		expect(outcome.isDone).toBe(true);
		// 3 MiB at the 1 MiB document maximum: reads of at most 3 rows.
		expect(asked.every(([, n]) => n <= 3)).toBe(true);
		const afters = asked.map(([after]) => after ?? 0);
		expect(new Set(afters).size).toBe(afters.length);
		expect(afters).toEqual([...afters].sort((a, b) => a - b));
		expect(charged).toBe(10);
	});

	it('stops when the fetched bytes use up the slice, and resumes after the last row', async () => {
		const { outcome, charged } = await scan(700 * 1024);
		expect(outcome).toMatchObject({ isDone: false, cursor: { at: charged } });
		expect(charged).toBeLessThanOrEqual(4);
	});
});

describe('F4/F5: a survivor is rebuilt field by field', () => {
	async function thousandFromB(t: Test) {
		const { messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		const ref = { kind: 'mail' as const, id: threadId };
		const srcA = { kind: 'mail' as const, id: a };
		const srcB = { kind: 'mail' as const, id: b };
		const claimA = reduceItem({ due: undefined, amount: undefined });
		const claimB = reduceItem({
			assertion: 'Pay the invoice',
			display: { en: 'Pay the invoice', de: 'Bezahl die Rechnung' },
			amount: { value: 1000, currency: 'EUR' },
			due: { phrase: 'by Friday', at: Date.UTC(2026, 9, 9), isAmbiguous: false },
		});
		const keyA = itemLineage(`mail:${a}`, claimA);
		const keyB = itemLineage(`mail:${b}`, claimB);
		const itemId = await t.run(async (ctx) => {
			await extraction(ctx, ref, srcA, reduceResult({ items: [claimA] }), SENT);
			await extraction(ctx, ref, srcB, reduceResult({ items: [claimB] }), SENT + 60_000);
			return insertItem(ctx, ref, [srcA, srcB], {
				lineage: keyA,
				lineageKeys: [keyA, keyB],
				amount: claimB.amount,
				due: claimB.due,
				options: ['card', 'transfer'],
				// A confirmed held change whose undo would put €1,000 back as pending.
				correction: { by: 'user-A', at: SENT, kind: 'confirmed' },
				confirmedFrom: {
					kind: 'heldChange',
					confirmation: { by: 'user-A', at: SENT, kind: 'confirmed' },
					verify: 'passed',
					amount: { value: 1000, currency: 'EUR' },
					pendingUpdate: { amount: { value: 1000, currency: 'EUR' } },
					addedEvidenceKeys: [`mail:${b}|rev-1|s0:0:4`],
				},
				pendingUpdate: {
					evidence: [{ source: srcB, segmentId: 's1', start: 0, end: 4, contentRevision: 'rev-1' }],
					amount: { value: 2000, currency: 'EUR' },
				},
			});
		});
		return { ref, srcB, itemId, claimA };
	}

	it('drops the amount and deadline only the purged message supplied', async () => {
		const t = convexTest(schema, modules);
		const { ref, srcB, itemId } = await thousandFromB(t);

		await drive(t, { ref, kind: 'sources', sources: [srcB] }, () => unitBudget(400));

		const item = (await t.run((ctx) => ctx.db.get(itemId)))!;
		expect(item.amount).toBeUndefined();
		expect(item.due).toBeUndefined();
		// A's claim states no options either: nothing stands without a claim behind it.
		expect(item.options).toBeUndefined();
		expect(item.evidence.map((e) => e.source.id)).not.toContain(srcB.id);
	});

	it('leaves no held update or undo snapshot that could restore the purged values', async () => {
		const t = convexTest(schema, modules);
		const { ref, srcB, itemId } = await thousandFromB(t);

		await drive(t, { ref, kind: 'sources', sources: [srcB] }, () => unitBudget(400));

		const item = (await t.run((ctx) => ctx.db.get(itemId)))!;
		expect(item.pendingUpdate).toBeUndefined();
		expect(item.confirmedFrom).toBeUndefined();
		const plan = planReaction(item as never, 'undo', { userId: 'user-A', now: SENT + 1 });
		expect(JSON.stringify(plan)).not.toContain('1000');
	});
});

describe('claim records', () => {
	it('drop their entries for the claims a purge deleted', async () => {
		const t = convexTest(schema, modules);
		const { messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		const ref = { kind: 'mail' as const, id: threadId };
		const srcA = { kind: 'mail' as const, id: a };
		const srcB = { kind: 'mail' as const, id: b };
		const seeded = await t.run(async (ctx) => {
			const doomed = await insertItem(ctx, ref, [srcB]);
			const kept = await insertItem(ctx, ref, [srcA]);
			const record = await ctx.db.insert('interpretSources', {
				...threadRefToFields(ref),
				source: srcA,
				sourceKey: `mail:${a}`,
				eligibility: {
					isLive: true,
					isThreadMuted: false,
					isBulkHeaderPresent: false,
					isSenderKnown: true,
				},
				claimIds: [
					{ key: `mail:${a}#one`, itemId: doomed },
					{ key: `mail:${a}#two`, itemId: kept },
				],
				createdAt: SENT,
				updatedAt: SENT,
			});
			return { doomed, kept, record };
		});

		await drive(t, { ref, kind: 'sources', sources: [srcB] }, () => unitBudget(400));

		const record = (await t.run((ctx) => ctx.db.get(seeded.record)))!;
		expect(record.claimIds).toEqual([{ key: `mail:${a}#two`, itemId: seeded.kept }]);
	});
});

describe('F6: erasing a bounced send resets its failed disposition', () => {
	it('matches the op:<sourceKey> the send failure recorded', async () => {
		const t = convexTest(schema, modules);
		const { messageId: a, threadId } = await seedMailThread(t);
		const sent = await addSibling(t, a);
		const ref = { kind: 'mail' as const, id: threadId };
		const itemId = await t.run((ctx) =>
			insertItem(ctx, ref, [{ kind: 'mail', id: a }], {
				disposition: 'failed',
				dispositionSource: { sourceKey: `op:outboundMail:${sent}`, at: SENT },
			})
		);

		await drive(t, { ref, kind: 'sources', sources: mailMessageSources(sent) }, () =>
			unitBudget(400)
		);

		const item = (await t.run((ctx) => ctx.db.get(itemId)))!;
		expect(item).toMatchObject({ disposition: 'unanswered', isReviewNeeded: true });
		expect(item.dispositionSource).toBeUndefined();
	});
});
