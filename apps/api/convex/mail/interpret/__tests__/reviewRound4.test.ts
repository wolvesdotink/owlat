/**
 * Review round 4: the MONOTONE reducer (fold.ts). Every extraction merges on
 * top of the thread; identity is the thread's (match, claim key, content);
 * nothing is retired by omission; transitions are order-aware; failed
 * attempts never move the checkpoint or carry flags; retries count admitted
 * attempts.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { ReduceResult } from '../reduceInput';
import { MAX_RETRIES, nextRetryAtOf } from '../retry';
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
const T2 = Date.UTC(2026, 9, 6, 9, 0);
const T3 = Date.UTC(2026, 9, 7, 9, 0);

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

const items = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) =>
		ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);

const brief = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) =>
		ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first()
	);

const invoice = reduceItem({
	facets: ['payment'],
	consequences: ['payment'],
	assertion: 'Pay invoice 2041',
	display: { en: 'Pay invoice 2041', de: 'Bezahl Rechnung 2041' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 0, end: 16, quote: 'pay invoice 2041' }],
});
const venue = reduceItem({
	intent: 'question',
	facets: ['meeting'],
	consequences: [],
	assertion: 'Confirm the venue',
	display: { en: 'Confirm the venue', de: 'Bestätig den Ort' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 20, end: 32, quote: 'which venue?' }],
});

describe('F1: a re-read merges by identity', () => {
	it('merges a re-read claim without matchItemId into the item it produced', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, {
			status: 'partial',
			errorCode: 'verify',
			result: reduceResult({ items: [invoice] }),
		});
		const [first] = await items(t, threadId);
		await apply(t, messageId, threadId, {
			retryCount: 1,
			result: reduceResult({ items: [invoice] }),
		});
		const after = await items(t, threadId);
		expect(after).toHaveLength(1);
		expect(after[0]?._id).toBe(first?._id);
	});
});

describe('F2: a re-read never retires', () => {
	it('leaves a recorded-complete item untouched, flagged only when solely sourced there', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const other = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'venue?', receivedAt: T2 }
		);
		await apply(t, messageId, threadId, {
			status: 'partial',
			errorCode: 'verify',
			result: reduceResult({ items: [invoice, venue] }),
		});
		const before = await items(t, threadId);
		const invoiceId = before.find((i) => i.intent === 'request')!._id;
		const venueId = before.find((i) => i.intent === 'question')!._id;
		// The invoice was paid through a recorded operation; the venue question is
		// also asked in a later message.
		await t.run(async (ctx) => ctx.db.patch(invoiceId, { status: 'done', completion: 'recorded' }));
		await apply(t, other, threadId, {
			sourceAt: T2,
			result: reduceResult({ items: [{ ...venue, matchItemId: venueId }] }),
		});
		// The re-read of the first message shows neither.
		await apply(t, messageId, threadId, { retryCount: 1, result: reduceResult({ items: [] }) });
		const after = await items(t, threadId);
		expect(after.find((i) => i._id === invoiceId)).toMatchObject({
			status: 'done',
			completion: 'recorded',
			isReviewNeeded: true,
		});
		const v = after.find((i) => i._id === venueId);
		expect(v?.status).toBe('open');
		expect(v?.isReviewNeeded).not.toBe(true);
	});
});

describe('F3/M3: guards on every path', () => {
	it('holds an unverified re-read of a tracked item as a pending update', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, {
			status: 'partial',
			errorCode: 'verify',
			result: reduceResult({ items: [invoice] }),
		});
		await apply(t, messageId, threadId, {
			retryCount: 1,
			result: reduceResult({
				items: [{ ...invoice, verify: 'proposal', amount: { value: 900, currency: 'EUR' } }],
			}),
		});
		const [after] = await items(t, threadId);
		expect(after?.amount).toBeUndefined();
		expect(after?.pendingUpdate?.amount).toEqual({ value: 900, currency: 'EUR' });
	});

	it('promotes a proposal with the verified claim text and parties', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const later = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'yes', receivedAt: T2 }
		);
		await apply(t, messageId, threadId, {
			result: reduceResult({
				items: [{ ...invoice, verify: 'proposal', amount: { value: 900, currency: 'EUR' } }],
			}),
		});
		const [proposed] = await items(t, threadId);
		await apply(t, later, threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [
					{
						...invoice,
						matchItemId: proposed!._id,
						verify: 'passed',
						assertion: 'Pay invoice 2041 to the supplier',
						display: { en: 'Pay the supplier', de: 'Bezahl den Lieferanten' },
						responsible: { email: 'jonas@example.com', isUs: false },
						amount: { value: 100, currency: 'EUR' },
						evidence: [{ segmentId: 's0', start: 0, end: 3, quote: 'yes' }],
					},
				],
			}),
		});
		const [after] = await items(t, threadId);
		expect(after).toMatchObject({
			_id: proposed!._id,
			verify: 'passed',
			amount: { value: 100, currency: 'EUR' },
			responsible: { email: 'jonas@example.com', isUs: false },
			responsibility: 'them',
		});
	});
});

describe('M2: order-aware transitions', () => {
	const paid = (itemId: Id<'threadItems'>, to: 'done' | 'open') =>
		reduceResult({
			items: [],
			transitions: [
				{
					itemId,
					to,
					evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
					isVerified: true,
					isReviewNeeded: false,
				},
			],
		});

	it('closes the invoice on a late verified "paid" when nothing newer set its state', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'paid', receivedAt: T2 }
		);
		const c = await addMessageToThread(t, { mailboxId, threadId }, { text: 'hi', receivedAt: T3 });
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		await apply(t, c, threadId, { sourceAt: T3, result: reduceResult({ items: [] }) });
		const [item] = await items(t, threadId);
		await apply(t, b, threadId, { sourceAt: T2, result: paid(item!._id, 'done') });
		expect((await items(t, threadId))[0]).toMatchObject({
			status: 'done',
			completion: 'reported',
			lastTransitionAt: T2,
		});
		expect((await brief(t, threadId))?.checkpoint?.sourceAt).toBe(T3);
	});

	it('keeps an older message’s transition as evidence when a newer one set the state', async () => {
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
			{ text: 'reopen', receivedAt: T3 }
		);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		const [item] = await items(t, threadId);
		await apply(t, c, threadId, { sourceAt: T3, result: paid(item!._id, 'done') });
		await apply(t, b, threadId, { sourceAt: T2, result: paid(item!._id, 'open') });
		const [after] = await items(t, threadId);
		expect(after).toMatchObject({ status: 'done', lastTransitionAt: T3 });
		expect(after?.evidence.length).toBe(3);
	});
});

describe('M4: failed attempts never move the checkpoint or carry flags', () => {
	it('keeps the checkpoint and exact-wording flag on the last good read', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, {
			result: reduceResult({ items: [invoice], exactWording: { reason: 'payment_details' } }),
		});
		const good = (await brief(t, threadId))?.checkpoint?.interpretationId;
		await apply(t, messageId, threadId, {
			contentRevision: 'rev-2',
			status: 'failed',
			errorCode: 'model_error',
			result: null,
			sourceAt: T2,
		});
		expect((await brief(t, threadId))?.checkpoint?.interpretationId).toBe(good);
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		const attempt = rows.find((r) => r.contentRevision.endsWith('~attempt'));
		expect(attempt?.isExactWordingRequired).not.toBe(true);
		expect(rows.find((r) => r._id === good)?.isExactWordingRequired).toBe(true);
	});
});

describe('M5: the retry budget counts admitted attempts', () => {
	it('stops after the first read and MAX_RETRIES repairs; gate refusals are always due', () => {
		const now = 1000;
		for (let attempts = 1; attempts <= MAX_RETRIES; attempts++) {
			expect(
				nextRetryAtOf({ status: 'partial', errorCode: 'verify', retryCount: attempts }, now)
			).toBeGreaterThan(now);
		}
		expect(
			nextRetryAtOf({ status: 'partial', errorCode: 'verify', retryCount: MAX_RETRIES + 1 }, now)
		).toBeUndefined();
		expect(nextRetryAtOf({ status: 'failed', errorCode: 'ai_off', retryCount: 99 }, now)).toBe(now);
	});
});

describe('transition sources (for purges)', () => {
	it('records which message set the status and the disposition', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'paid', receivedAt: T2 }
		);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoice] }) });
		const [item] = await items(t, threadId);
		await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [],
				transitions: [
					{
						itemId: item!._id,
						to: 'done',
						disposition: 'answered',
						evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		const [after] = await items(t, threadId);
		expect(after?.statusSource).toEqual({ sourceKey: `mail:${b}`, at: T2 });
		expect(after?.dispositionSource).toEqual({ sourceKey: `mail:${b}`, at: T2 });
	});
});
