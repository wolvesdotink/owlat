/**
 * Review round 2 regressions against a real (convex-test) database: a failed
 * later attempt keeps the last good read (F2), identity by content, not list
 * position (F3), pending updates held apart (F4), each derived field updated
 * on its own (F5).
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { ReduceResult } from '../reduceInput';
import {
	addMessageToThread,
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
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

async function apply(
	t: Test,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	over: {
		contentRevision?: string;
		status?: 'complete' | 'partial' | 'failed';
		errorCode?: string;
		result?: ReduceResult | null;
		retryCount?: number;
		sourceAt?: number;
	} = {}
) {
	const revision = await t.run(async (ctx) => {
		const brief = await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first();
		return brief?.interpretationRevision ?? 0;
	});
	const { result, ...rest } = over;
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 3,
		expectedRevision: revision,
		deletionEpoch: 0,
		sourceAt: T1,
		direction: 'inbound',
		status: 'complete',
		...(result === null ? {} : { result: result ?? reduceResult() }),
		...rest,
	});
}

async function items(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) =>
		ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);
}

async function brief(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) =>
		ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first()
	);
}

const payment = reduceItem({
	facets: ['payment'],
	consequences: ['payment'],
	assertion: 'Pay invoice 2041',
	display: { en: 'Pay invoice 2041', de: 'Bezahl Rechnung 2041' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 0, end: 16, quote: 'pay invoice 2041' }],
});
const signature = reduceItem({
	facets: ['signature'],
	consequences: ['signature'],
	assertion: 'Sign the contract',
	display: { en: 'Sign the contract', de: 'Unterschreib den Vertrag' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 20, end: 37, quote: 'sign the contract' }],
});

describe('F2: a failed later attempt keeps the last good read', () => {
	it('keeps items and facts, and shows the failure as incomplete', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, { result: reduceResult({ items: [payment] }) });
		const out = await apply(t, messageId, threadId, {
			contentRevision: 'rev-2',
			status: 'failed',
			errorCode: 'model_error',
			result: null,
		});
		expect(out).toMatchObject({ outcome: 'applied', status: 'failed', completeness: 'partial' });
		const [item] = await items(t, threadId);
		expect(item?.status).toBe('open');
		expect(await brief(t, threadId)).toMatchObject({
			completeness: 'partial',
			sourceCounts: { complete: 0, failed: 1 },
		});
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows.find((r) => r.contentRevision === 'rev-1')).toMatchObject({
			isCurrent: true,
			isCounted: false,
		});
		// The failed attempt is its own row beside the good read (round 3 P3).
		expect(rows.find((r) => r.contentRevision === 'rev-2~attempt')).toMatchObject({
			isCurrent: false,
			isCounted: true,
			errorCode: 'model_error',
		});

		// The next good read of the new revision replaces it and completes the brief.
		await apply(t, messageId, threadId, {
			contentRevision: 'rev-2',
			result: reduceResult({ items: [payment] }),
		});
		expect(await brief(t, threadId)).toMatchObject({
			completeness: 'complete',
			sourceCounts: { complete: 1, failed: 0 },
		});
		expect((await items(t, threadId)).filter((i) => i.status === 'open')).toHaveLength(1);
	});
});

describe('F3: identity by content, never by list position', () => {
	it('never hands a corrected payment id to a signature request after a repair', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, {
			status: 'partial',
			errorCode: 'verify',
			result: reduceResult({ items: [payment, signature] }),
		});
		const before = await items(t, threadId);
		const paymentId = before.find((i) => i.facets.includes('payment'))!._id;
		const signatureId = before.find((i) => i.facets.includes('signature'))!._id;
		await t.run(async (ctx) =>
			ctx.db.patch(paymentId, {
				status: 'done',
				completion: 'asserted',
				correction: { by: 'user-A', at: T1 + 1, kind: 'markedDone' },
			})
		);
		// The repair drops the payment: the signature request is now at index 0.
		await apply(t, messageId, threadId, {
			retryCount: 1,
			result: reduceResult({ items: [signature] }),
		});
		const after = await items(t, threadId);
		const sig = after.find((i) => i._id === signatureId);
		expect(sig).toMatchObject({ status: 'open', facets: ['signature'] });
		expect(sig?.correction).toBeUndefined();
		expect(after.find((i) => i._id === paymentId)).toMatchObject({
			status: 'done',
			correction: { kind: 'markedDone' },
			facets: ['payment'],
		});
	});
});

describe('F4: an unconfirmed claim waits as a pending update', () => {
	it('stores it apart and shows it on the brief item', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, mailboxId } = await seedMailThread(t);
		const later = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'FW: EUR 900', receivedAt: T1 + 1000 }
		);
		await apply(t, messageId, threadId, { result: reduceResult({ items: [payment] }) });
		const [tracked] = await items(t, threadId);
		await apply(t, later, threadId, {
			sourceAt: T1 + 1000,
			result: reduceResult({
				items: [
					{
						...payment,
						matchItemId: tracked!._id,
						verify: 'proposal',
						amount: { value: 900, currency: 'EUR' },
						evidence: [{ segmentId: 's1', start: 0, end: 7, quote: 'EUR 900' }],
					},
				],
			}),
		});
		const [after] = await items(t, threadId);
		expect(after?.amount).toBeUndefined();
		expect(after?.verify).toBe('passed');
		expect(after?.pendingUpdate).toMatchObject({ amount: { value: 900, currency: 'EUR' } });
		const view = await t.query(api.mail.interpret.brief.get, {
			threadRef: { kind: 'mail', id: threadId },
			locale: 'en',
		});
		if (view?.mode !== 'brief') throw new Error('unreachable');
		expect(view.forYou[0]?.pendingUpdate).toMatchObject({
			amount: { value: 900, currency: 'EUR' },
			evidence: [{ quote: 'EUR 900' }],
		});
	});
});

describe('F5: a repair updates each derived field on its own', () => {
	it('moves the owner and the counters although the wording is unchanged', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, {
			status: 'partial',
			errorCode: 'verify',
			result: reduceResult({ items: [payment] }),
		});
		expect((await brief(t, threadId))?.itemCounts).toMatchObject({ us: 1, them: 0 });
		await apply(t, messageId, threadId, {
			retryCount: 1,
			result: reduceResult({
				items: [{ ...payment, responsible: { email: 'jonas@example.com', isUs: false } }],
			}),
		});
		const [after] = await items(t, threadId);
		expect(after).toMatchObject({
			responsible: { email: 'jonas@example.com', isUs: false },
			responsibility: 'them',
			listBucket: 'waitingOnOthers',
		});
		expect((await brief(t, threadId))?.itemCounts).toMatchObject({ us: 0, them: 1 });
	});
});

describe('the current extraction is found however many revisions a source has', () => {
	it('retires the old current row, its exact-wording flag and its count past 50 revisions', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const sourceKey = `mail:${messageId}`;
		// 60 older, already-replaced extractions of the same source.
		await t.run(async (ctx) => {
			for (let i = 0; i < 60; i++) {
				await ctx.db.insert('messageInterpretations', {
					threadKind: 'mail',
					mailThreadId: threadId,
					source: { kind: 'mail', id: messageId },
					sourceKey,
					contentRevision: `old-${String(i).padStart(2, '0')}`,
					extractorVersion: 3,
					mode: 'brief',
					status: 'complete',
					isCurrent: false,
					isCounted: false,
					deletionEpoch: 0,
					createdAt: i,
					updatedAt: i,
				});
			}
		});
		await apply(t, messageId, threadId, {
			contentRevision: 'zz-1',
			result: reduceResult({ items: [payment], exactWording: { reason: 'payment_details' } }),
		});
		await apply(t, messageId, threadId, {
			contentRevision: 'zz-2',
			result: reduceResult({ items: [payment] }),
		});
		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('messageInterpretations')
				.withIndex('by_source_revision', (q) => q.eq('sourceKey', sourceKey))
				.collect()
		);
		expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
		expect(rows.filter((r) => r.isCounted)).toHaveLength(1);
		expect(rows.find((r) => r.contentRevision === 'zz-1')).toMatchObject({ isCurrent: false });
		expect(rows.find((r) => r.contentRevision === 'zz-1')?.isExactWordingRequired).not.toBe(true);
		expect((await brief(t, threadId))?.sourceCounts).toMatchObject({ complete: 1 });
	});
});

describe('review round 3: identity and human state belong to the thread', () => {
	it('keeps the id, recorded completion, reminder and assignee through a rephrased repair (F1)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, {
			status: 'partial',
			errorCode: 'verify',
			result: reduceResult({ items: [payment] }),
		});
		const [first] = await items(t, threadId);
		await t.run(async (ctx) =>
			ctx.db.patch(first!._id, {
				status: 'done',
				completion: 'recorded',
				remindAt: 123,
				assigneeUserId: 'user-B',
			})
		);
		await apply(t, messageId, threadId, {
			retryCount: 1,
			result: reduceResult({
				items: [
					{
						...payment,
						matchItemId: first!._id,
						assertion: 'Settle invoice 2041 with the supplier',
						display: { en: 'Settle invoice 2041', de: 'Begleich Rechnung 2041' },
					},
				],
			}),
		});
		const after = await items(t, threadId);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			_id: first!._id,
			status: 'done',
			completion: 'recorded',
			remindAt: 123,
			assigneeUserId: 'user-B',
		});
		expect(after[0]?.lineageKeys).toHaveLength(2);
	});

	it('updates a fact value when the wording stays the same (F5)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const fact = (value: number) => ({
			key: '["invoice","total",""]',
			assertion: 'The invoice total is due',
			display: { en: `Invoice total: EUR ${value}`, de: `Rechnungssumme: EUR ${value}` },
			value: { kind: 'money' as const, value, currency: 'EUR' },
			evidence: [{ segmentId: 's0', start: 0, end: 7, quote: 'EUR 100' }],
			isVerified: false,
			isReviewNeeded: false,
		});
		await apply(t, messageId, threadId, {
			status: 'partial',
			errorCode: 'verify',
			result: reduceResult({ items: [], facts: [fact(100)] }),
		});
		await apply(t, messageId, threadId, {
			retryCount: 1,
			result: reduceResult({ items: [], facts: [fact(900)] }),
		});
		const facts = await t.run(async (ctx) =>
			ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread_and_status', (q) =>
					q.eq('mailThreadId', threadId).eq('status', 'current')
				)
				.collect()
		);
		expect(facts).toHaveLength(1);
		expect(facts[0]?.value).toEqual({ kind: 'money', value: 900, currency: 'EUR' });
		expect(facts[0]?.display.en).toBe('Invoice total: EUR 900');
	});
});
