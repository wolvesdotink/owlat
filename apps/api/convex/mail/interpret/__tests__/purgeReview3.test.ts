/**
 * Review round 3 regressions of the thread brief erasure: the re-read of a
 * redacted thread is budgeted and resumable, large parent rows still make
 * progress, a team follow-up's Sends go with the message it answered, and a
 * verified claim refills what a purge redacted.
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
import {
	drainShrinking,
	scanRange,
	unitBudget,
	type DrainBudget,
	type PurgeCursor,
} from '../purgeDrain';
import { drivePurgeJob } from '../purgeRun';
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';
import { SENT, addSibling, applyArgs, insertItem } from './purge.testlib';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const MIB = 1024 * 1024;

async function drive(
	t: Test,
	fields: Parameters<typeof drivePurgeJob>[2],
	budget: () => DrainBudget,
	onSlice?: () => Promise<void>
): Promise<number> {
	for (let slice = 1; slice <= 100; slice++) {
		const isDone = await t.run((ctx) => drivePurgeJob(ctx, 'test', fields, budget()));
		await onSlice?.();
		if (isDone) return slice;
	}
	throw new Error('purge never finished');
}

async function completeRead(ctx: MutationCtx, ref: ThreadRef, source: InterpretationSource) {
	const sourceKey = `${source.kind}:${source.id}`;
	await ctx.db.insert('messageInterpretations', {
		...threadRefToFields(ref),
		source,
		sourceKey,
		contentRevision: 'rev-1',
		extractorVersion: 1,
		mode: ref.kind === 'mail' ? 'brief' : 'actions',
		status: 'complete',
		payload: await sealBodyAtWrite(JSON.stringify(reduceResult({ items: [] }))),
		deletionEpoch: 0,
		isCurrent: true,
		isCounted: true,
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

describe('the re-read of a redacted thread', () => {
	it('schedules every surviving source over budgeted slices, never more per slice than the budget', async () => {
		const t = convexTest(schema, modules);
		const { messageId: purgedId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		const purged = { kind: 'mail' as const, id: purgedId };
		const survivors: InterpretationSource[] = [];
		for (let i = 0; i < 30; i++) {
			survivors.push({ kind: 'mail', id: await addSibling(t, purgedId) });
		}
		await t.run(async (ctx) => {
			for (const source of survivors) await completeRead(ctx, ref, source);
			await insertItem(ctx, ref, [purged, survivors[0]!]);
		});
		const scheduled = () =>
			t.run(
				async (ctx) =>
					(await ctx.db.system.query('_scheduled_functions').collect()).filter(
						(s) => s.name === 'mail/interpret/run:interpretMessage'
					).length
			);
		const perSlice: number[] = [];
		let before = 0;
		await drive(
			t,
			{ ref, kind: 'sources', sources: [purged] },
			() => unitBudget(20),
			async () => {
				const now = await scheduled();
				perSlice.push(now - before);
				before = now;
			}
		);
		expect(before).toBe(30);
		expect(Math.max(...perSlice)).toBeLessThanOrEqual(20);
		expect(perSlice.filter((n) => n > 0).length).toBeGreaterThan(1);
	});
});

describe('large parent rows', () => {
	it('eight 900 KiB parents with children finish, one or more per slice', async () => {
		const parents = Array.from({ length: 8 }, (_, i) => ({
			at: i + 1,
			body: 'x'.repeat(900 * 1024),
			children: [`c${i}a`, `c${i}b`],
		}));
		let cursor: PurgeCursor | undefined;
		const doneChildren = new Set<string>();
		const finishedPerSlice: number[] = [];
		for (let slice = 0; slice < 20; slice++) {
			const budget = unitBudget(1000, 8 * MIB);
			let finished = 0;
			const outcome = await scanRange(
				budget,
				cursor,
				async (after, n) =>
					parents.filter((p) => after === undefined || p.at > (after as number)).slice(0, n),
				(p) => p.at,
				async (parent) => {
					const isEmpty = await drainShrinking(
						budget,
						async (n) => parent.children.filter((c) => !doneChildren.has(c)).slice(0, n),
						async (child) => {
							doneChildren.add(child);
							return true;
						}
					);
					if (isEmpty) finished += 1;
					return isEmpty;
				}
			);
			finishedPerSlice.push(finished);
			if (outcome.isDone) break;
			cursor = outcome.cursor;
		}
		expect(doneChildren.size).toBe(16);
		expect(finishedPerSlice.every((n) => n >= 1)).toBe(true);
	});
});

describe('team follow-ups', () => {
	it('take their Sends’ derived rows with the message they answered', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const ref = { kind: 'team' as const, id: threadId };
		const items = await t.run(async (ctx) => {
			const followUpId = await ctx.db.insert('inboxFollowUps', {
				threadId,
				inReplyToMessageId: inboundId,
				subject: 'Re: Order 42',
				body: 'One more thing',
				status: 'sent',
				createdBy: 'user-A',
				createdAt: SENT,
				sendAt: SENT,
			});
			const ids: Id<'threadItems'>[] = [];
			for (let i = 0; i < 2; i++) {
				const sendId = await ctx.db.insert('transactionalSends', {
					kind: 'team_reply',
					email: 'customer@example.com',
					status: 'sent',
					followUpId,
				});
				if (i === 0) await ctx.db.patch(followUpId, { sendId });
				const source = { kind: 'teamReply' as const, id: sendId };
				await completeRead(ctx, ref, source);
				ids.push(await insertItem(ctx, ref, [source]));
			}
			return ids;
		});

		await drive(
			t,
			{
				ref,
				kind: 'sources',
				sources: [{ kind: 'inbound', id: inboundId }],
				inboundMessageId: inboundId,
			},
			() => unitBudget(400)
		);

		await t.run(async (ctx) => {
			expect(await ctx.db.query('messageInterpretations').collect()).toHaveLength(0);
			expect(await ctx.db.query('interpretSources').collect()).toHaveLength(0);
			for (const id of items) expect(await ctx.db.get(id)).toBeNull();
		});
	});
});

describe('a redacted field', () => {
	it('is refilled by a later verified claim, and the marker cleared', async () => {
		const t = convexTest(schema, modules);
		const { messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, applyArgs(a, threadId));
		const item = await t.run(async (ctx) => {
			const row = (await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first())!;
			await ctx.db.patch(row._id, {
				amount: undefined,
				due: undefined,
				assertion: await sealBodyAtWrite('Details removed with the deleted message'),
				redactedFields: ['assertion', 'display', 'due', 'amount'],
			});
			return row;
		});
		const brief = await t.run((ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);

		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			...applyArgs(b, threadId),
			expectedRevision: brief!.interpretationRevision,
			deletionEpoch: brief!.deletionEpoch,
			sourceAt: SENT + 60_000,
			result: reduceResult({
				items: [
					reduceItem({
						matchItemId: item._id,
						amount: { value: 500, currency: 'EUR' },
						verify: 'passed',
					}),
				],
				latest: undefined,
			}),
		});

		const after = (await t.run((ctx) => ctx.db.get(item._id)))!;
		expect(after.amount).toEqual({ value: 500, currency: 'EUR' });
		expect(after.redactedFields).toBeUndefined();
		// The text came back too: the verified claim refilled the redacted fields
		// directly (a plain fill never rewrites the wording).
		expect(await openMessageBody(after.assertion)).toBe('Send the signed contract');
	});
});
