/**
 * Review round 1 regressions against a real (convex-test) database: the body
 * fingerprint recheck (F1), source counters (F3), paged brief items with
 * maintained counts (F4), ordered replay with corrections (F5), the mode
 * recheck (F10), the team reply snapshot (F9), the closed lookback by update
 * time (F14) and the corrected-item conflict activity (F16).
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { ThreadRef } from '../../../lib/validators/threadRef';
import { threadRefToFields } from '../../../lib/validators/threadRef';
import { appendActivity } from '../activity';
import { recordItemChange } from '../counters';
import { loadPromptItemCandidates } from '../load';
import { sourceVersionOf } from '../sourceVersion';
import { captureTeamReplySnapshot } from '../sources';
import type { ReduceResult } from '../reduceInput';
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

async function revisionOf(t: Test, threadId: Id<'mailThreads'>): Promise<number> {
	return t.run(async (ctx) => {
		const brief = await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first();
		return brief?.interpretationRevision ?? 0;
	});
}

async function apply(
	t: Test,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	overrides: Partial<{
		status: 'complete' | 'partial' | 'failed';
		errorCode: string;
		result: ReduceResult | undefined;
		sourceAt: number;
		contentRevision: string;
		sourceVersion: string;
		mode: 'brief' | 'actions';
	}> = {}
) {
	const hasResult = 'result' in overrides;
	const { result, ...rest } = overrides;
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 2,
		expectedRevision: await revisionOf(t, threadId),
		deletionEpoch: 0,
		sourceAt: T1,
		direction: 'inbound',
		status: 'complete',
		...(hasResult ? (result ? { result } : {}) : { result: reduceResult() }),
		...rest,
	});
}

async function itemsOf(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) =>
		ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);
}

async function briefOf(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) =>
		ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first()
	);
}

const invoice = reduceItem({
	intent: 'request',
	facets: ['payment'],
	consequences: ['payment'],
	assertion: 'Pay invoice 2041',
	display: { en: 'Pay invoice 2041', de: 'Bezahl Rechnung 2041' },
	due: undefined,
});
const venue = reduceItem({
	intent: 'question',
	facets: ['meeting'],
	consequences: [],
	assertion: 'Confirm the venue',
	display: { en: 'Confirm the venue', de: 'Bestätig den Ort' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 0, end: 12, quote: 'which venue?' }],
});

describe('F1: the body the run read is the body stored now', () => {
	it('refuses a write whose body fingerprint no longer matches', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		expect(await apply(t, messageId, threadId, { sourceVersion: 'not-this-body' })).toEqual({
			outcome: 'sourceChanged',
		});
		expect(await itemsOf(t, threadId)).toHaveLength(0);
		const version = await t.run(async (ctx) =>
			sourceVersionOf(ctx, { kind: 'mail', id: messageId })
		);
		expect(await apply(t, messageId, threadId, { sourceVersion: version as string })).toMatchObject(
			{
				outcome: 'applied',
			}
		);
		// Editing the body moves the fingerprint.
		await t.run(async (ctx) => ctx.db.patch(messageId, { textBodyInline: 'edited' }));
		const edited = await t.run(async (ctx) =>
			sourceVersionOf(ctx, { kind: 'mail', id: messageId })
		);
		expect(edited).not.toBe(version);
	});
});

describe('F3: completeness from per-source counters', () => {
	it('keeps an old failure visible until that source is repaired', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(t, { mailboxId, threadId }, { text: 'b', receivedAt: T2 });
		const c = await addMessageToThread(t, { mailboxId, threadId }, { text: 'c', receivedAt: T3 });
		await apply(t, a, threadId, { status: 'failed', errorCode: 'model_error', result: undefined });
		await apply(t, b, threadId, { sourceAt: T2, result: reduceResult({ items: [] }) });
		await apply(t, c, threadId, { sourceAt: T3, result: reduceResult({ items: [] }) });
		expect(await briefOf(t, threadId)).toMatchObject({
			completeness: 'partial',
			sourceCounts: { complete: 2, failed: 1, partial: 0 },
		});
		await apply(t, a, threadId, { contentRevision: 'rev-1b', result: reduceResult({ items: [] }) });
		expect(await briefOf(t, threadId)).toMatchObject({
			completeness: 'complete',
			sourceCounts: { complete: 3, failed: 0 },
		});
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows.filter((r) => r.isCurrent)).toHaveLength(3);
	});
});

describe('F5: ordered replay', () => {
	it('closes the invoice when the late "paid" message arrives, keeping ids and corrections', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'paid', receivedAt: T2 }
		);
		const c = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'venue?', receivedAt: T3 }
		);
		const ref: ThreadRef = { kind: 'mail', id: threadId };

		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		await apply(t, c, threadId, { sourceAt: T3, result: reduceResult({ items: [venue] }) });
		const before = await itemsOf(t, threadId);
		const invoiceId = before.find((i) => i.intent === 'request')!._id;
		const venueId = before.find((i) => i.intent === 'question')!._id;

		// The owner marks the venue question done (a reaction: correction + asserted activity).
		await t.run(async (ctx) => {
			const row = (await ctx.db.get(venueId)) as Doc<'threadItems'>;
			await ctx.db.patch(venueId, {
				status: 'done',
				completion: 'asserted',
				correction: { by: 'user-A', at: T3 + 1, kind: 'markedDone' },
			});
			await recordItemChange(ctx, ref, row, { status: 'done', responsibility: row.responsibility });
			await appendActivity(ctx, {
				threadRef: ref,
				idempotencyKey: `mark:${venueId}`,
				type: 'item_corrected',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'asserted',
				itemId: venueId,
				delta: { statusFrom: 'open', statusTo: 'done', completion: 'asserted' },
			});
		});

		// The late message (sent before C) says the invoice was paid.
		const out = await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [],
				transitions: [
					{
						itemId: invoiceId,
						to: 'done',
						evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		expect(out).toMatchObject({ outcome: 'applied', status: 'complete' });
		const after = await itemsOf(t, threadId);
		expect(after.map((i) => i._id).sort()).toEqual([invoiceId, venueId].sort());
		expect(after.find((i) => i._id === invoiceId)).toMatchObject({
			status: 'done',
			completion: 'reported',
			lineage: expect.stringContaining('#0'),
		});
		expect(after.find((i) => i._id === venueId)).toMatchObject({
			status: 'done',
			completion: 'asserted',
			correction: { kind: 'markedDone' },
		});
		// The late message does not move the checkpoint back.
		expect((await briefOf(t, threadId))?.checkpoint?.sourceAt).toBe(T3);
		expect((await briefOf(t, threadId))?.itemCounts).toMatchObject({ us: 0, closed: 2 });
	});

	it('retires items a repaired extraction no longer produces', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, {
			status: 'partial',
			errorCode: 'verify',
			result: reduceResult({ items: [invoice, venue] }),
		});
		const [first] = await itemsOf(t, threadId);
		// The repair reads the same body again and finds only the invoice.
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: { kind: 'mail', id: messageId },
			threadRef: { kind: 'mail', id: threadId },
			mode: 'brief',
			contentRevision: 'rev-1',
			extractorVersion: 2,
			expectedRevision: await revisionOf(t, threadId),
			deletionEpoch: 0,
			sourceAt: T1,
			direction: 'inbound',
			status: 'complete',
			retryCount: 1,
			result: reduceResult({ items: [invoice] }),
		});
		const items = await itemsOf(t, threadId);
		expect(items).toHaveLength(2);
		expect(items.find((i) => i.intent === 'request')?._id).toBe(first?._id);
		expect(items.find((i) => i.intent === 'question')?.status).toBe('superseded');
		expect(await briefOf(t, threadId)).toMatchObject({ completeness: 'complete' });
	});
});

describe('F10: the mode is rechecked in the transaction', () => {
	it('refuses a personal-mode write after the mailbox became shared', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, mailboxId } = await seedMailThread(t);
		await apply(t, messageId, threadId);
		await t.run(async (ctx) => ctx.db.patch(mailboxId, { scope: 'shared' }));
		expect(await apply(t, messageId, threadId, { contentRevision: 'rev-2', sourceAt: T2 })).toEqual(
			{
				outcome: 'modeChanged',
			}
		);
		expect((await briefOf(t, threadId))?.mode).toBe('actions');
	});
});

describe('F16: a conflict on a corrected item is logged and kept', () => {
	it('appends item_changed and keeps the new quotes', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'again', receivedAt: T2 }
		);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		const [item] = await itemsOf(t, threadId);
		await t.run(async (ctx) =>
			ctx.db.patch(item!._id, {
				status: 'untracked',
				correction: { by: 'user-A', at: T1 + 1, kind: 'untracked' },
			})
		);
		await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [],
				transitions: [
					{
						itemId: item!._id,
						to: 'open',
						evidence: [{ segmentId: 's0', start: 0, end: 5, quote: 'again' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		const [after] = await itemsOf(t, threadId);
		expect(after).toMatchObject({ status: 'untracked', isReviewNeeded: true });
		expect(after?.evidence).toHaveLength(2);
		const activity = await t.run(async (ctx) => ctx.db.query('threadActivity').collect());
		expect(activity.some((a) => a.type === 'item_changed' && a.itemId === item!._id)).toBe(true);
	});
});

async function insertOpenItems(t: Test, threadId: Id<'mailThreads'>, n: number, now: number) {
	const ref: ThreadRef = { kind: 'mail', id: threadId };
	await t.run(async (ctx) => {
		for (let i = 0; i < n; i++) {
			await ctx.db.insert('threadItems', {
				...threadRefToFields(ref),
				revision: 1,
				intent: 'request',
				facets: [],
				assertion: `Item ${i}`,
				display: { en: `Item ${i}`, de: `Punkt ${i}` },
				requester: { email: 'jonas@example.com', isUs: false },
				responsible: { isUs: true },
				responsibility: 'us',
				status: 'open',
				disposition: 'unanswered',
				evidence: [],
				verify: 'na',
				askedAt: now - i,
				createdAt: now,
				updatedAt: now,
			});
			await recordItemChange(ctx, ref, null, { status: 'open', responsibility: 'us' });
		}
	});
}

describe('F4: paged brief items with maintained counts', () => {
	it('counts every item and pages the rest instead of cutting them', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedMailThread(t);
		await insertOpenItems(t, threadId, 105, Date.now());
		const ref = { kind: 'mail' as const, id: threadId };
		const first = await t.query(api.mail.interpret.brief.get, { threadRef: ref, locale: 'en' });
		if (first?.mode !== 'brief') throw new Error('unreachable');
		expect(first.counts.forYou).toBe(105);
		expect(first.forYou).toHaveLength(100);
		expect(first.page).toMatchObject({ isDone: false, isClosedTruncated: false });
		const second = await t.query(api.mail.interpret.brief.get, {
			threadRef: ref,
			locale: 'en',
			cursor: first.page?.cursor,
		});
		if (second?.mode !== 'brief') throw new Error('unreachable');
		expect(second.forYou).toHaveLength(5);
		expect(second.page?.isDone).toBe(true);
	});
});

describe('F14: the closed lookback reads by update time', () => {
	it('finds a recently closed item behind a long closed history', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedMailThread(t);
		const now = Date.now();
		const old = now - 90 * 24 * 60 * 60 * 1000;
		await insertOpenItems(t, threadId, 250, old);
		const recent = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.collect();
			for (const row of rows) await ctx.db.patch(row._id, { status: 'done' });
			const last = rows[rows.length - 1] as Doc<'threadItems'>;
			await ctx.db.patch(last._id, { updatedAt: now });
			return last._id;
		});
		const { rows, isScanCut } = await t.run(async (ctx) =>
			loadPromptItemCandidates(ctx, { kind: 'mail', id: threadId }, now)
		);
		expect(rows.map((r) => r._id)).toEqual([recent]);
		expect(isScanCut).toBe(false);
	});
});

describe('F9: a team reply is read from its send-time snapshot', () => {
	it('reads the captured text, never the mutable draft, and nothing without a snapshot', async () => {
		const t = convexTest(schema, modules);
		const { inboundId } = await seedTeamThread(t);
		const sendId = await t.run(async (ctx) => {
			await ctx.db.patch(inboundId, { draftResponse: 'We will refund you by Monday.' });
			return ctx.db.insert('transactionalSends', {
				kind: 'team_reply',
				email: 'customer@example.com',
				status: 'sent',
				inboundMessageId: inboundId,
			});
		});
		const source = { kind: 'teamReply' as const, id: sendId };
		expect(await t.query(internal.mail.interpret.scope.loadSourceForScope, { source })).toEqual({
			kind: 'teamReplyMissing',
		});
		await t.run(async (ctx) =>
			captureTeamReplySnapshot(ctx, {
				sendId,
				subject: 'Re: Order 42',
				text: 'We will refund you by Monday.',
			})
		);
		await t.run(async (ctx) => ctx.db.patch(inboundId, { draftResponse: 'edited after send' }));
		expect(
			await t.query(internal.mail.interpret.scope.loadSourceForScope, { source })
		).toMatchObject({
			kind: 'teamReply',
			subject: 'Re: Order 42',
			sealedText: 'We will refund you by Monday.',
		});
	});
});
