/**
 * `applyInterpretation` and `appendActivity` against a real (convex-test)
 * database: item ids, activity in the same transaction, compare-and-set,
 * deletion epochs, vanished sources, replays, completeness and D4.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { appendActivity } from '../activity';
import {
	EMPTY_SOURCE_COUNTS,
	completenessOfCounts,
	shiftCount,
	type SourceCounts,
} from '../counters';
import {
	addMessageToThread,
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);

function applyArgs(
	source: { kind: 'mail'; id: Id<'mailMessages'> },
	threadId: Id<'mailThreads'>,
	overrides: Record<string, unknown> = {}
) {
	return {
		source,
		threadRef: { kind: 'mail' as const, id: threadId },
		mode: 'brief' as const,
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound' as const,
		status: 'complete' as const,
		result: reduceResult(),
		...overrides,
	};
}

async function rows(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) => ({
		items: await ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		activity: await ctx.db
			.query('threadActivity')
			.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		brief: await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first(),
		interpretations: await ctx.db
			.query('messageInterpretations')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect(),
	}));
}

describe('applyInterpretation', () => {
	it('creates items, the extraction row, activity and the brief revision in one go', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, mailboxId } = await seedMailThread(t);
		const out = await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs({ kind: 'mail', id: messageId }, threadId)
		);
		expect(out).toMatchObject({
			outcome: 'applied',
			interpretationRevision: 1,
			completeness: 'complete',
		});
		const state = await rows(t, threadId);
		expect(state.items).toHaveLength(1);
		expect(state.items[0]).toMatchObject({
			mailboxId,
			status: 'open',
			disposition: 'unanswered',
			responsibility: 'us',
			counterpartyKey: 'jonas@example.com',
			consequences: ['signature'],
			askedAt: SENT,
			revision: 1,
		});
		expect(state.items[0]?.evidence[0]).toMatchObject({
			source: { kind: 'mail', id: messageId },
			contentRevision: 'rev-1',
			quote: 'send the signed contract',
		});
		expect(state.activity.map((a) => [a.seq, a.type])).toEqual([
			[1, 'message_received'],
			[2, 'item_opened'],
		]);
		expect(state.brief).toMatchObject({
			interpretationRevision: 1,
			lastActivitySeq: 2,
			completeness: 'complete',
			checkpoint: { sourceKey: `mail:${messageId}`, sourceAt: SENT },
		});
		expect(state.interpretations[0]).toMatchObject({
			status: 'complete',
			appliedAt: expect.any(Number),
		});
	});

	it('answers stale when the revision moved, and writes nothing', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs({ kind: 'mail', id: messageId }, threadId)
		);
		const stale = await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs({ kind: 'mail', id: messageId }, threadId, {
				contentRevision: 'rev-2',
				expectedRevision: 0,
			})
		);
		expect(stale).toEqual({ outcome: 'stale', interpretationRevision: 1 });
		expect((await rows(t, threadId)).items).toHaveLength(1);
	});

	it('replays an applied extraction as a no-op', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const args = applyArgs({ kind: 'mail', id: messageId }, threadId);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, args);
		const again = await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			...args,
			expectedRevision: 1,
		});
		expect(again).toMatchObject({ outcome: 'replayed' });
		const state = await rows(t, threadId);
		expect(state.items).toHaveLength(1);
		expect(state.activity).toHaveLength(2);
	});

	it('drops the write when a purge bumped the deletion epoch meanwhile', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.run(async (ctx) => {
			const id = await ctx.db.insert('threadBriefs', {
				threadKind: 'mail',
				mailThreadId: threadId,
				mode: 'brief',
				sourceRevision: 0,
				interpretationRevision: 0,
				lastActivitySeq: 0,
				completeness: 'none',
				deletionEpoch: 1,
				updatedAt: 0,
			});
			return id;
		});
		const out = await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs({ kind: 'mail', id: messageId }, threadId)
		);
		expect(out).toEqual({ outcome: 'erased' });
		expect((await rows(t, threadId)).items).toHaveLength(0);
	});

	it('drops the write when the source left the thread', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.run(async (ctx) => ctx.db.delete(messageId));
		const out = await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs({ kind: 'mail', id: messageId }, threadId)
		);
		expect(out).toEqual({ outcome: 'gone' });
	});

	it('closes an item on a verified transition from a later message', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, mailboxId } = await seedMailThread(t);
		const later = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'it is signed', receivedAt: SENT + 1000 }
		);
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs({ kind: 'mail', id: messageId }, threadId)
		);
		const [item] = (await rows(t, threadId)).items;
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs({ kind: 'mail', id: later }, threadId, {
				expectedRevision: 1,
				sourceAt: SENT + 1000,
				result: reduceResult({
					items: [],
					transitions: [
						{
							itemId: item!._id,
							to: 'done',
							evidence: [{ segmentId: 's0', start: 30, end: 40, quote: 'it is signed' }],
							isVerified: true,
							isReviewNeeded: false,
						},
					],
				}),
			})
		);
		const state = await rows(t, threadId);
		expect(state.items[0]).toMatchObject({ status: 'done', completion: 'reported', revision: 2 });
		expect(state.items[0]?.evidence).toHaveLength(2);
		expect(state.activity[state.activity.length - 1]).toMatchObject({
			type: 'item_closed',
			itemId: item!._id,
			itemRevision: 2,
			delta: { statusFrom: 'open', statusTo: 'done', completion: 'reported' },
		});
	});

	it('records a failed run as incomplete and never as nothing to do', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const out = await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs({ kind: 'mail', id: messageId }, threadId, {
				status: 'failed',
				errorCode: 'model_error',
				result: undefined,
			})
		);
		expect(out).toMatchObject({ outcome: 'applied', completeness: 'partial' });
		const state = await rows(t, threadId);
		expect(state.activity.map((a) => a.type)).toEqual([
			'message_received',
			'interpretation_incomplete',
		]);
	});

	it('assigns new team items to the thread assignee (D4) and writes no facts', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t, { assignedTo: 'user-B' });
		const out = await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: { kind: 'inbound', id: inboundId },
			threadRef: { kind: 'team', id: threadId },
			mode: 'actions',
			contentRevision: 'rev-1',
			extractorVersion: 1,
			expectedRevision: 0,
			deletionEpoch: 0,
			sourceAt: SENT,
			direction: 'inbound',
			status: 'complete',
			threadAssigneeUserId: 'user-B',
			result: reduceResult({
				items: [reduceItem({ responsible: { email: 'support@owlat.test', isUs: true } })],
				latest: undefined,
				facts: [
					{
						key: '["order","id",""]',
						assertion: 'Order 42',
						display: { en: 'Order 42', de: 'Bestellung 42' },
						evidence: [],
						isVerified: false,
						isReviewNeeded: false,
					},
				],
			}),
		});
		expect(out).toMatchObject({ outcome: 'applied' });
		const items = await t.run(async (ctx) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread_and_status', (q) =>
					q.eq('conversationThreadId', threadId)
				)
				.collect()
		);
		expect(items[0]).toMatchObject({ assigneeUserId: 'user-B', threadKind: 'team' });
		expect(await t.run(async (ctx) => ctx.db.query('threadFacts').collect())).toEqual([]);
	});
});

describe('appendActivity', () => {
	it('allocates sequential seqs and is idempotent per key and thread', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		const results = await t.run(async (ctx) => {
			const a = await appendActivity(ctx, {
				threadRef: ref,
				idempotencyKey: 'archive:1',
				type: 'archived',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
			});
			const b = await appendActivity(ctx, {
				threadRef: ref,
				idempotencyKey: 'send:1',
				type: 'reply_sent',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
				payload: { text: 'Replied to Jonas' },
			});
			const again = await appendActivity(ctx, {
				threadRef: ref,
				idempotencyKey: 'send:1',
				type: 'reply_sent',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
			});
			return { a, b, again };
		});
		expect(results.a).toMatchObject({ seq: 1, isDuplicate: false });
		expect(results.b).toMatchObject({ seq: 2, isDuplicate: false });
		expect(results.again).toMatchObject({ seq: 2, isDuplicate: true });
		const activity = (await rows(t, threadId)).activity;
		expect(activity.map((a) => a.visibility)).toEqual(['housekeeping', 'substance']);
		expect(activity[1]?.payloadVersion).toBe(1);
	});

	it('writes nothing for a thread that is gone', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedMailThread(t);
		await t.run(async (ctx) => ctx.db.delete(threadId));
		const out = await t.run(async (ctx) =>
			appendActivity(ctx, {
				threadRef: { kind: 'mail', id: threadId },
				idempotencyKey: 'x',
				type: 'muted',
				actor: { kind: 'user' },
				provenance: 'recorded',
			})
		);
		expect(out).toBeNull();
	});
});

describe('source counters', () => {
	it('read completeness from the current extraction of every source', () => {
		const counts = (c: Partial<SourceCounts>): SourceCounts => ({ ...EMPTY_SOURCE_COUNTS, ...c });
		expect(completenessOfCounts(EMPTY_SOURCE_COUNTS)).toBe('none');
		expect(completenessOfCounts(counts({ complete: 3 }))).toBe('complete');
		expect(completenessOfCounts(counts({ complete: 300, failed: 1 }))).toBe('partial');
		expect(completenessOfCounts(counts({ skipped: 1 }))).toBe('complete');
		expect(completenessOfCounts(counts({ unreadable: 1 }))).toBe('partial');
		expect(shiftCount(counts({ failed: 1 }), 'failed', 'complete')).toEqual(counts({ complete: 1 }));
	});
});
