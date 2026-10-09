/**
 * Review round 6: a wording match never moves a status by itself, it only
 * proposes (F1, R1); identity loads reach every claim the result names and
 * the claim record is merge-updated (F2); the pending-transition scan pages
 * through every pending row and keeps the brief partial until done (F3, R2);
 * every confirmed field is locked, removals included (F4, wiring W-F7); a fold
 * that read only part of the thread keeps the brief partial (wiring W-F8).
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import betterAuthSchema from '../../../betterAuth/schema';
import { api, internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { ReduceFact, ReduceResult } from '../reduceInput';
import { captureInterpretSource } from '../sources';
import { FOLD_MAX_ITEMS } from '../reduceState';
import { openMessageBody } from '../../../lib/messageBody';
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
		getSingletonOrganizationId: vi.fn(async () => 'org-1'),
	};
});

afterEach(() => {
	vi.useRealTimers();
});

const betterAuthModules = import.meta.glob('../../../betterAuth/**/*.*s');
const T1 = Date.UTC(2026, 9, 5, 9, 0);
const T2 = Date.UTC(2026, 9, 6, 9, 0);

function harness(): Test {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	return t;
}

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

const briefOf = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) =>
		ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first()
	);

const pendingRows = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) =>
		ctx.db
			.query('messageInterpretations')
			.withIndex('by_mail_thread_pending', (q) =>
				q.eq('mailThreadId', threadId).eq('isPendingTransitions', true)
			)
			.collect()
	);

const invoiceItem = (n: string) =>
	reduceItem({
		facets: ['payment'],
		consequences: ['payment'],
		assertion: `Pay invoice ${n}`,
		display: { en: `Pay invoice ${n}`, de: `Bezahl Rechnung ${n}` },
		due: undefined,
		evidence: [{ segmentId: 's0', start: 0, end: 16, quote: `pay invoice ${n}` }],
	});

const completion = (about: string) =>
	reduceResult({
		items: [],
		transitions: [
			{
				about,
				to: 'done',
				evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
				isVerified: true,
				isReviewNeeded: false,
			},
		],
	});

/** `count` closed copies of `template`, newer than it. Returns their ids. */
async function closedCopies(t: Test, template: Doc<'threadItems'>, count: number) {
	return t.run(async (ctx) => {
		const { _id, _creationTime, lineage, lineageKeys, ...row } = template;
		const ids: Id<'threadItems'>[] = [];
		for (let i = 0; i < count; i++) {
			ids.push(await ctx.db.insert('threadItems', { ...row, status: 'done' }));
		}
		return ids;
	});
}

describe('F1 (R1): a wording match only proposes', () => {
	it('"Pay invoice 2041" never closes "Pay invoice 2042"; a person confirms, and can undo', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'paid', receivedAt: T2 }
		);
		await apply(t, b, threadId, { sourceAt: T2, result: completion('Pay invoice 2041') });
		await apply(t, a, threadId, { result: reduceResult({ items: [invoiceItem('2042')] }) });
		// The scan is in flight: the brief is partial until it ends (R2).
		expect(await briefOf(t, threadId)).toMatchObject({
			completeness: 'partial',
			pendingMatchRuns: 1,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const brief = await briefOf(t, threadId);
		expect(brief?.completeness).toBe('complete');
		expect(brief?.pendingMatchRuns).toBeUndefined();

		const [item] = await items(t, threadId);
		expect(item).toMatchObject({
			status: 'open',
			isReviewNeeded: true,
			pendingUpdate: { transitions: [{ to: 'done', sourceKey: `mail:${b}`, at: T2 }] },
		});
		expect(item?.completion).toBeUndefined();
		expect(item?.pendingUpdate?.evidence.some((e) => e.source.id === b)).toBe(true);
		// Still pending: only a confirmation (or an exact re-read) settles it.
		expect((await pendingRows(t, threadId)).map((r) => r.pendingTransitions)).toEqual([[0]]);

		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: item!._id });
		const confirmed = (await items(t, threadId))[0];
		expect(confirmed).toMatchObject({
			status: 'done',
			completion: 'reported',
			statusSource: { sourceKey: `mail:${b}`, at: T2 },
			correction: { kind: 'confirmed' },
		});
		expect(confirmed?.pendingUpdate).toBeUndefined();
		expect(await pendingRows(t, threadId)).toHaveLength(0);

		await t.mutation(api.mail.interpret.reactions.undo, { itemId: item!._id });
		const undone = (await items(t, threadId))[0];
		expect(undone).toMatchObject({
			status: 'open',
			pendingUpdate: { transitions: [{ to: 'done' }] },
		});
		expect(undone?.completion).toBeUndefined();
		expect(undone?.statusSource).toBeUndefined();
	});
});

describe('F2: claim identities resolve before any budget; the record is merge-updated', () => {
	it('a record of more than 100 targets still resolves its last claim, and keeps every entry', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'venue?', receivedAt: T2 }
		);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoiceItem('2041')] }) });
		const [template] = await items(t, threadId);
		const copies = await closedCopies(t, template!, FOLD_MAX_ITEMS + 1);
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
			evidence: [{ segmentId: 's0', start: 0, end: 6, quote: 'venue?' }],
		});
		const first = await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({ items: [venue] }),
		});
		const created = first.outcome === 'applied' ? first.createdItemIds[0] : undefined;
		// Closed (past the scan), behind 150 other recorded targets.
		await t.run(async (ctx) => {
			await ctx.db.patch(created!, { status: 'done' });
			const row = await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${b}`))
				.first();
			const fake = copies.slice(0, 150).map((itemId, i) => ({ key: `mail:${b}#fake${i}`, itemId }));
			await ctx.db.patch(row!._id, { claimIds: [...fake, ...(row!.claimIds ?? [])] });
		});
		const before = (await items(t, threadId)).length;
		const again = await apply(t, b, threadId, {
			contentRevision: 'rev-2',
			sourceAt: T2,
			result: reduceResult({ items: [venue] }),
		});
		expect(again).toMatchObject({ outcome: 'applied', createdItemIds: [] });
		expect(await items(t, threadId)).toHaveLength(before);
		const record = await t.run(async (ctx) =>
			ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${b}`))
				.first()
		);
		expect(record?.claimIds).toHaveLength(151);
		expect(record?.claimIds?.map((c) => c.itemId)).toContain(created);
	});
});

describe('F3 (R2): every pending row is examined', () => {
	it('the 21st pending row still proposes to the new item', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		for (let i = 0; i < 21; i++) {
			const at = T2 + i * 60_000;
			const m = await addMessageToThread(
				t,
				{ mailboxId, threadId },
				{ text: 'done', receivedAt: at }
			);
			const about = i === 20 ? 'Pay invoice 2041' : `Book train ticket number ${i} to Hamburg`;
			await apply(t, m, threadId, { sourceAt: at, result: completion(about) });
		}
		expect(await pendingRows(t, threadId)).toHaveLength(21);
		await apply(t, a, threadId, { result: reduceResult({ items: [invoiceItem('2041')] }) });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const [item] = await items(t, threadId);
		expect(item?.pendingUpdate?.transitions).toHaveLength(1);
		expect(item?.status).toBe('open');
		expect((await briefOf(t, threadId))?.completeness).toBe('complete');
	});
});

describe('F4 / W-F7: every confirmed field is locked', () => {
	const alice = reduceItem({
		assertion: 'Send the contract to Alice',
		display: { en: 'Send the contract to Alice', de: 'Schick Alice den Vertrag' },
		responsible: { email: 'alice@example.com', name: 'Alice', isUs: false },
		amount: { value: 1000, currency: 'EUR' },
		due: undefined,
	});

	async function confirmedItem(t: Test) {
		const seeded = await seedMailThread(t);
		await apply(t, seeded.messageId, seeded.threadId, { result: reduceResult({ items: [alice] }) });
		const [item] = await items(t, seeded.threadId);
		await t.run(async (ctx) => {
			await ctx.db.patch(item!._id, { correction: { by: 'user-A', at: T1, kind: 'confirmed' } });
		});
		return { ...seeded, item: item! };
	}

	it('holds a sole-source re-read’s different amount (W-F7)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await confirmedItem(t);
		await apply(t, messageId, threadId, {
			contentRevision: 'rev-2',
			result: reduceResult({ items: [{ ...alice, amount: { value: 100, currency: 'EUR' } }] }),
		});
		const [after] = await items(t, threadId);
		expect(after).toMatchObject({
			amount: { value: 1000, currency: 'EUR' },
			isReviewNeeded: true,
			pendingUpdate: { amount: { value: 100, currency: 'EUR' } },
		});
	});

	it('holds a re-read’s new wording, party and dropped amount; confirm applies, undo restores', async () => {
		const t = harness();
		const { messageId, threadId, item } = await confirmedItem(t);
		const bob = {
			...alice,
			assertion: 'Send the contract to Bob',
			display: { en: 'Send the contract to Bob', de: 'Schick Bob den Vertrag' },
			responsible: { email: 'bob@example.com', name: 'Bob', isUs: false },
			amount: undefined,
		};
		await apply(t, messageId, threadId, {
			contentRevision: 'rev-2',
			result: reduceResult({ items: [{ ...bob, matchItemId: item._id }] }),
		});
		const [held] = await items(t, threadId);
		expect(held).toMatchObject({
			assertion: item.assertion,
			responsible: { email: 'alice@example.com' },
			amount: { value: 1000, currency: 'EUR' },
			isReviewNeeded: true,
			pendingUpdate: { responsible: { email: 'bob@example.com' }, removes: ['amount'] },
		});
		expect(await openMessageBody(held!.pendingUpdate!.assertion!)).toBe('Send the contract to Bob');

		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: item._id });
		const confirmed = (await items(t, threadId))[0]!;
		expect(await openMessageBody(confirmed.assertion)).toBe('Send the contract to Bob');
		expect(confirmed.responsible.email).toBe('bob@example.com');
		expect(confirmed.amount).toBeUndefined();

		await t.mutation(api.mail.interpret.reactions.undo, { itemId: item._id });
		const undone = (await items(t, threadId))[0]!;
		expect(await openMessageBody(undone.assertion)).toBe('Send the contract to Alice');
		expect(undone.responsible.email).toBe('alice@example.com');
		expect(undone.amount).toEqual({ value: 1000, currency: 'EUR' });
	});
});

describe('W-F8 (R2): a fold that read only part of the thread keeps the brief partial', () => {
	const price = (n: number): ReduceFact => ({
		key: `invoice ${n}|amount|`,
		assertion: `Invoice ${n} is EUR 100`,
		display: { en: `Invoice ${n}: EUR 100`, de: `Rechnung ${n}: 100 EUR` },
		value: { kind: 'money', value: 100, currency: 'EUR' },
		evidence: [{ segmentId: 's0', start: 0, end: 7, quote: 'EUR 100' }],
		isVerified: false,
		isReviewNeeded: false,
	});

	it('reports more than 200 current facts and marks the brief partial', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(t, { mailboxId, threadId }, { text: 'x', receivedAt: T2 });
		await apply(t, a, threadId, { result: reduceResult({ items: [], facts: [price(1)] }) });
		await t.run(async (ctx) => {
			const fact = await ctx.db.query('threadFacts').first();
			const { _id, _creationTime, lineage, ...row } = fact!;
			for (let i = 0; i < 200; i++)
				await ctx.db.insert('threadFacts', { ...row, factKey: `k${i}` });
		});
		const out = await apply(t, b, threadId, {
			sourceAt: T2,
			result: reduceResult({ items: [], facts: [price(2)] }),
		});
		expect(out).toMatchObject({ outcome: 'applied', isItemScanCut: true, completeness: 'partial' });
		expect(await briefOf(t, threadId)).toMatchObject({
			completeness: 'partial',
			isFoldScanCut: true,
		});
	});
});
