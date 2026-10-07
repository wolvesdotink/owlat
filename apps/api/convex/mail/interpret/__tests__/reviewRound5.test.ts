/**
 * Review round 5: refinements of the monotone reducer. Confirmed fields are
 * locked (F1); reaffirmations advance the order stamp (F2); status and
 * disposition are ordered independently (F3); terminal items take part in
 * identity (F4); identity reaches past the bounded scan (F5); a re-read fact
 * merges before any relation is considered (F6); a completion read before its
 * request is applied when the request's item appears (F7); a human team
 * follow-up resolves its thread through the follow-up (W1).
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { ReduceFact, ReduceResult } from '../reduceInput';
import { captureInterpretSource } from '../sources';
import { loadSourceInfo } from '../load';
import { FOLD_MAX_ITEMS } from '../reduceState';
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

const T1 = Date.UTC(2026, 9, 5, 9, 0);
const T2 = Date.UTC(2026, 9, 6, 9, 0);
const T3 = Date.UTC(2026, 9, 7, 9, 0);
const T4 = Date.UTC(2026, 9, 8, 9, 0);

async function apply(
	t: Test,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	over: { contentRevision?: string; result?: ReduceResult; sourceAt?: number } = {}
) {
	const revision = await t.run(async (ctx) => {
		const brief = await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first();
		return brief?.interpretationRevision ?? 0;
	});
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: over.contentRevision ?? 'rev-1',
		extractorVersion: 4,
		expectedRevision: revision,
		deletionEpoch: 0,
		sourceAt: over.sourceAt ?? T1,
		direction: 'inbound',
		status: 'complete',
		result: over.result ?? reduceResult(),
	});
}

const items = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) =>
		ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);

const facts = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) =>
		ctx.db
			.query('threadFacts')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);

const invoice = reduceItem({
	facets: ['payment'],
	consequences: ['payment'],
	assertion: 'Pay invoice 2041',
	display: { en: 'Pay invoice 2041', de: 'Bezahl Rechnung 2041' },
	due: undefined,
	amount: { value: 100, currency: 'EUR' },
	evidence: [{ segmentId: 's0', start: 0, end: 16, quote: 'pay invoice 2041' }],
});

const move = (
	itemId: Id<'threadItems'>,
	change: { to?: 'done' | 'open' | 'superseded'; disposition?: 'answered' }
) =>
	reduceResult({
		items: [],
		transitions: [
			{
				itemId,
				...change,
				evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
				isVerified: true,
				isReviewNeeded: false,
			},
		],
	});

async function threeMessages(t: Test) {
	const seeded = await seedMailThread(t);
	const at = { mailboxId: seeded.mailboxId, threadId: seeded.threadId };
	const b = await addMessageToThread(t, at, { text: 'paid', receivedAt: T2 });
	const c = await addMessageToThread(t, at, { text: 'reopen', receivedAt: T3 });
	const d = await addMessageToThread(t, at, { text: 'paid, really', receivedAt: T4 });
	return { ...seeded, a: seeded.messageId, b, c, d };
}

describe('F1: confirmed fields are locked', () => {
	it('keeps a confirmed amount; a verified re-read with another one waits for review', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, { result: reduceResult({ items: [invoice] }) });
		const [item] = await items(t, threadId);
		await t.run(async (ctx) => {
			await ctx.db.patch(item!._id, { correction: { by: 'user-A', at: T1, kind: 'confirmed' } });
		});
		await apply(t, messageId, threadId, {
			contentRevision: 'rev-2',
			result: reduceResult({
				items: [{ ...invoice, matchItemId: item!._id, amount: { value: 900, currency: 'EUR' } }],
			}),
		});
		const after = await items(t, threadId);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			amount: { value: 100, currency: 'EUR' },
			correction: { kind: 'confirmed' },
			isReviewNeeded: true,
			pendingUpdate: { amount: { value: 900, currency: 'EUR' } },
		});
	});
});

describe('F2: a reaffirmation advances the order stamp', () => {
	it('done@T2, reaffirmed done@T4, a late reopen@T3 stays out', async () => {
		const t = convexTest(schema, modules);
		const { a, b, c, d, threadId } = await threeMessages(t);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		const [item] = await items(t, threadId);
		await apply(t, b, threadId, { sourceAt: T2, result: move(item!._id, { to: 'done' }) });
		await apply(t, d, threadId, { sourceAt: T4, result: move(item!._id, { to: 'done' }) });
		await apply(t, c, threadId, { sourceAt: T3, result: move(item!._id, { to: 'open' }) });
		const [after] = await items(t, threadId);
		expect(after).toMatchObject({
			status: 'done',
			statusSource: { sourceKey: `mail:${d}`, at: T4 },
		});
		// The reaffirmation and the late reopen keep their quotes.
		const sources = new Set(after!.evidence.map((e) => e.source.id));
		expect(sources).toEqual(new Set([a, b, c, d]));
	});
});

describe('F3: status and disposition are ordered independently', () => {
	it('applies an older disposition change after a newer status change', async () => {
		const t = convexTest(schema, modules);
		const { a, b, c, threadId } = await threeMessages(t);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		const [item] = await items(t, threadId);
		await apply(t, c, threadId, { sourceAt: T3, result: move(item!._id, { to: 'done' }) });
		await apply(t, b, threadId, {
			sourceAt: T2,
			result: move(item!._id, { disposition: 'answered' }),
		});
		const [after] = await items(t, threadId);
		expect(after).toMatchObject({
			status: 'done',
			disposition: 'answered',
			statusSource: { sourceKey: `mail:${c}`, at: T3 },
			dispositionSource: { sourceKey: `mail:${b}`, at: T2 },
			lastTransitionAt: T3,
		});
	});
});

describe('F4: terminal items take part in identity', () => {
	it('a re-read of a replaced request merges into it, never a new open item', async () => {
		const t = convexTest(schema, modules);
		const { a, b, threadId } = await threeMessages(t);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		const [item] = await items(t, threadId);
		await apply(t, b, threadId, { sourceAt: T2, result: move(item!._id, { to: 'superseded' }) });
		await apply(t, a, threadId, {
			contentRevision: 'rev-2',
			result: reduceResult({ items: [invoice] }),
		});
		const after = await items(t, threadId);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ _id: item!._id, status: 'superseded' });
	});
});

describe('F5: identity reaches past the bounded scan', () => {
	/** `count` closed copies of `template`, newer than it. Returns the newest. */
	async function closedCopies(t: Test, template: Doc<'threadItems'>, count: number) {
		return t.run(async (ctx) => {
			const { _id, _creationTime, lineage, lineageKeys, ...row } = template;
			let last: Id<'threadItems'> | null = null;
			for (let i = 0; i < count; i++) {
				last = await ctx.db.insert('threadItems', { ...row, status: 'done' });
			}
			return last!;
		});
	}

	it('merges an explicit match to the newest of more than the scan', async () => {
		const t = convexTest(schema, modules);
		const { a, b, threadId } = await threeMessages(t);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		const [template] = await items(t, threadId);
		const newest = await closedCopies(t, template!, FOLD_MAX_ITEMS + 1);
		const before = (await items(t, threadId)).length;
		const out = await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [
					{
						...invoice,
						matchItemId: newest,
						evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
					},
				],
			}),
		});
		expect(out).toMatchObject({ outcome: 'applied', createdItemIds: [], isItemScanCut: true });
		expect(await items(t, threadId)).toHaveLength(before);
		const target = await t.run(async (ctx) => ctx.db.get(newest));
		expect(target?.evidence.some((e) => e.source.id === b)).toBe(true);
	});

	it('resolves a re-read through the source’s claim record, past the scan', async () => {
		const t = convexTest(schema, modules);
		const { a, b, threadId } = await threeMessages(t);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		const [template] = await items(t, threadId);
		await closedCopies(t, template!, FOLD_MAX_ITEMS + 1);
		await t.run(async (ctx) => {
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: b }, isLive: true });
		});
		const venue = reduceItem({
			intent: 'question',
			facets: ['meeting'],
			consequences: [],
			assertion: 'Confirm the venue',
			display: { en: 'Confirm the venue', de: 'Bestätig den Ort' },
			due: undefined,
			evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
		});
		const first = await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({ items: [venue] }),
		});
		const created = first.outcome === 'applied' ? first.createdItemIds[0] : undefined;
		expect(created).toBeDefined();
		// Closed: past the scan (the open items come first, then the oldest).
		await t.run(async (ctx) => {
			await ctx.db.patch(created!, { status: 'done' });
		});
		const sourceRow = await t.run(async (ctx) =>
			ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${b}`))
				.first()
		);
		expect(sourceRow?.claimIds?.map((c) => c.itemId)).toContain(created);
		const before = (await items(t, threadId)).length;
		const again = await apply(t, b, threadId, {
			contentRevision: 'rev-2',
			sourceAt: T2,
			result: reduceResult({ items: [venue] }),
		});
		expect(again).toMatchObject({ outcome: 'applied', createdItemIds: [] });
		expect(await items(t, threadId)).toHaveLength(before);
	});
});

describe('F6: a re-read fact merges before any relation', () => {
	const price = (over: Partial<ReduceFact> = {}): ReduceFact => ({
		key: 'invoice 2041|amount|',
		assertion: 'Invoice 2041 is EUR 100',
		display: { en: 'Invoice 2041: EUR 100', de: 'Rechnung 2041: 100 EUR' },
		value: { kind: 'money', value: 100, currency: 'EUR' },
		evidence: [{ segmentId: 's0', start: 0, end: 10, quote: 'EUR 100' }],
		isVerified: false,
		isReviewNeeded: false,
		...over,
	});

	it('keeps two facts after a conflicting fact is re-read, as worded before or reworded', async () => {
		const t = convexTest(schema, modules);
		const { a, b, threadId } = await threeMessages(t);
		await apply(t, a, threadId, { result: reduceResult({ items: [], facts: [price()] }) });
		const [first] = await facts(t, threadId);
		const conflicting = price({
			assertion: 'Invoice 2041 is EUR 900',
			value: { kind: 'money', value: 900, currency: 'EUR' },
			evidence: [{ segmentId: 's0', start: 0, end: 7, quote: 'EUR 900' }],
			conflictsWith: first!._id,
		});
		await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({ items: [], facts: [conflicting] }),
		});
		expect(await facts(t, threadId)).toHaveLength(2);
		await apply(t, b, threadId, {
			contentRevision: 'rev-2',
			sourceAt: T2,
			result: reduceResult({ items: [], facts: [conflicting] }),
		});
		expect(await facts(t, threadId)).toHaveLength(2);
		await apply(t, b, threadId, {
			contentRevision: 'rev-3',
			sourceAt: T2,
			result: reduceResult({
				items: [],
				facts: [{ ...conflicting, assertion: 'The amount of invoice 2041 is EUR 900' }],
			}),
		});
		const after = await facts(t, threadId);
		expect(after).toHaveLength(2);
		expect(after.filter((f) => f.conflictsWithId === first!._id)).toHaveLength(1);
	});
});

describe('F7: a completion read before its request', () => {
	it('is kept, and applied when the request creates the item', async () => {
		const t = convexTest(schema, modules);
		const { a, b, threadId } = await threeMessages(t);
		await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [],
				transitions: [
					{
						about: 'Pay invoice 2041',
						to: 'done',
						evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		const pending = await t.run(async (ctx) =>
			ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread_pending', (q) =>
					q.eq('mailThreadId', threadId).eq('isPendingTransitions', true)
				)
				.collect()
		);
		expect(pending.map((r) => r.pendingTransitions)).toEqual([[0]]);
		expect(await items(t, threadId)).toHaveLength(0);

		await apply(t, a, threadId, { sourceAt: T1, result: reduceResult({ items: [invoice] }) });
		const [item] = await items(t, threadId);
		expect(item).toMatchObject({
			status: 'done',
			completion: 'reported',
			statusSource: { sourceKey: `mail:${b}`, at: T2 },
		});
		const settled = await t.run(async (ctx) =>
			ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread_pending', (q) =>
					q.eq('mailThreadId', threadId).eq('isPendingTransitions', true)
				)
				.collect()
		);
		expect(settled).toHaveLength(0);
		const brief = await t.run(async (ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(brief?.itemCounts).toMatchObject({ us: 0, closed: 1 });
	});

	it('leaves a pending transition that names no new item pending', async () => {
		const t = convexTest(schema, modules);
		const { a, b, threadId } = await threeMessages(t);
		await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [],
				transitions: [
					{
						about: 'Book the train to Hamburg',
						to: 'done',
						evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		await apply(t, a, threadId, { sourceAt: T1, result: reduceResult({ items: [invoice] }) });
		const [item] = await items(t, threadId);
		expect(item?.status).toBe('open');
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows.find((r) => r.source.id === b)?.pendingTransitions).toEqual([0]);
	});
});

describe('W1: a human team follow-up resolves its thread through the follow-up', () => {
	async function seedFollowUpSend(t: Test) {
		const { threadId, inboundId } = await seedTeamThread(t);
		const sendId = await t.run(async (ctx) => {
			const now = Date.UTC(2026, 9, 7, 10, 0);
			const followUpId = await ctx.db.insert('inboxFollowUps', {
				threadId,
				inReplyToMessageId: inboundId,
				subject: 'Re: Order 42',
				body: 'The refund went out today.',
				status: 'sent',
				createdBy: 'user-A',
				createdAt: now,
				sendAt: now,
			});
			const id = await ctx.db.insert('transactionalSends', {
				kind: 'team_reply',
				email: 'customer@example.com',
				status: 'sent',
				queuedAt: now,
				subject: 'Re: Order 42',
				followUpId,
			});
			await ctx.db.patch(followUpId, { sendId: id });
			return id;
		});
		return { threadId, sendId };
	}

	it('finds the thread for the source info, the source snapshot and the reducer', async () => {
		const t = convexTest(schema, modules);
		const { threadId, sendId } = await seedFollowUpSend(t);
		const source = { kind: 'teamReply' as const, id: sendId };
		const info = await t.run(async (ctx) => loadSourceInfo(ctx, source));
		expect(info).toMatchObject({
			threadRef: { kind: 'team', id: threadId },
			direction: 'outbound',
		});
		const sourceRowId = await t.run(async (ctx) =>
			captureInterpretSource(ctx, { source, isLive: true })
		);
		expect(sourceRowId).not.toBeNull();
		const out = await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source,
			threadRef: { kind: 'team', id: threadId },
			mode: 'actions',
			contentRevision: 'rev-1',
			extractorVersion: 4,
			expectedRevision: 0,
			deletionEpoch: 0,
			sourceAt: T3,
			direction: 'outbound',
			status: 'complete',
			result: reduceResult({ items: [], latest: undefined, facts: undefined }),
		});
		expect(out.outcome).toBe('applied');
	});

	it('refuses a follow-up whose answered message sits in another thread', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await seedFollowUpSend(t);
		const other = await seedTeamThread(t);
		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			await ctx.db.patch(send!.followUpId!, { inReplyToMessageId: other.inboundId });
		});
		const info = await t.run(async (ctx) => loadSourceInfo(ctx, { kind: 'teamReply', id: sendId }));
		expect(info).toBeNull();
	});
});
