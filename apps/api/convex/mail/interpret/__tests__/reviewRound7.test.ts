/**
 * Review round 7: every held change and every disposition dependency carries
 * its source. A purge drops the held fields its message proposed (F1); undo
 * of a confirmation makes its settled transitions pending again (F2); a newer
 * removal deletes the held value (F3); changed parties move the counterparty
 * key (F4); send failure finds its items by `dispositionSource` (F5).
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import betterAuthSchema from '../../../betterAuth/schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { ReduceItem, ReduceResult } from '../reduceInput';
import { mergeHeld } from '../fold';
import { stripItem } from '../purgeClaims';
import { unitBudget } from '../purgeDrain';
import { reconcileSendFailure } from '../sendFailure';
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
const T3 = Date.UTC(2026, 9, 7, 9, 0);

function harness(): Test {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	return t;
}

async function apply(
	t: Test,
	source: { kind: 'mail' | 'outboundMail'; id: Id<'mailMessages'> },
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
		source,
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: over.contentRevision ?? 'rev-1',
		extractorVersion: 4,
		expectedRevision: revision,
		deletionEpoch: 0,
		sourceAt: over.sourceAt ?? T1,
		direction: source.kind === 'outboundMail' ? 'outbound' : 'inbound',
		status: 'complete',
		result: over.result ?? reduceResult(),
	});
}

const mail = (id: Id<'mailMessages'>) => ({ kind: 'mail' as const, id });
const itemOf = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(
		async (ctx) =>
			(
				await ctx.db
					.query('threadItems')
					.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
					.collect()
			)[0]!
	);

const alice: ReduceItem = reduceItem({
	assertion: 'Send the contract to Alice',
	display: { en: 'Send the contract to Alice', de: 'Schick Alice den Vertrag' },
	requester: { email: 'me@owlat.test', isUs: true },
	responsible: { email: 'alice@example.com', name: 'Alice', isUs: false },
	amount: { value: 1000, currency: 'EUR' },
	due: undefined,
});
const bob: ReduceItem = {
	...alice,
	assertion: 'Send the contract to Bob',
	display: { en: 'Send the contract to Bob', de: 'Schick Bob den Vertrag' },
	responsible: { email: 'bob@example.com', name: 'Bob', isUs: false },
};

/** An item from message a, also quoted by b, that a person confirmed. */
async function confirmedOnTwo(t: Test) {
	const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
	const b = await addMessageToThread(t, { mailboxId, threadId }, { text: 'Alice', receivedAt: T2 });
	await apply(t, mail(a), threadId, { result: reduceResult({ items: [alice] }) });
	const item = await itemOf(t, threadId);
	await apply(t, mail(b), threadId, {
		sourceAt: T2,
		result: reduceResult({
			items: [
				{
					...alice,
					matchItemId: item._id,
					evidence: [{ segmentId: 's0', start: 0, end: 5, quote: 'Alice' }],
				},
			],
		}),
	});
	await t.run(async (ctx) => {
		await ctx.db.patch(item._id, { correction: { by: 'user-A', at: T1, kind: 'confirmed' } });
	});
	return { a, b, threadId, itemId: item._id };
}

const purge = (t: Test, threadId: Id<'mailThreads'>, gone: Id<'mailMessages'>) =>
	t.run(async (ctx) => {
		const item = (await ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.first())!;
		return stripItem(
			ctx,
			{ kind: 'mail', id: threadId },
			item,
			{ ids: new Set([gone]), keys: new Set([`mail:${gone}`]) },
			unitBudget(1000)
		);
	});

describe('F1: a purge drops the held fields its message proposed', () => {
	it('held wording and party from the purged message go; the item survives on its other source', async () => {
		const t = convexTest(schema, modules);
		const { b, threadId } = await confirmedOnTwo(t);
		await apply(t, mail(b), threadId, {
			contentRevision: 'rev-2',
			sourceAt: T2,
			result: reduceResult({
				items: [
					{
						...bob,
						matchItemId: (await itemOf(t, threadId))._id,
						evidence: [{ segmentId: 's0', start: 0, end: 5, quote: 'Alice' }],
					},
				],
			}),
		});
		const held = (await itemOf(t, threadId)).pendingUpdate;
		expect(held?.assertion).toBeDefined();
		expect(held?.evidence).toEqual([]);
		expect(held?.fieldSources?.map((f) => f.sourceKey)).toContain(`mail:${b}`);

		expect(await purge(t, threadId, b)).toBe('survived');
		expect((await itemOf(t, threadId)).pendingUpdate).toBeUndefined();
	});

	it('a confirmed change from the purged message is redacted', async () => {
		const t = harness();
		const { b, threadId, itemId } = await confirmedOnTwo(t);
		await apply(t, mail(b), threadId, {
			contentRevision: 'rev-2',
			sourceAt: T2,
			result: reduceResult({
				items: [
					{
						...bob,
						matchItemId: (await itemOf(t, threadId))._id,
						evidence: [{ segmentId: 's0', start: 0, end: 5, quote: 'Alice' }],
					},
				],
			}),
		});
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		expect((await itemOf(t, threadId)).responsible.email).toBe('bob@example.com');
		await purge(t, threadId, b);
		// Round 8: the standing provenance redacts what the purged message set.
		const after = await itemOf(t, threadId);
		expect(after.responsible).toEqual({ isUs: false });
		expect(after.counterpartyKey).toBeUndefined();
		expect(after.isReviewNeeded).toBe(true);
		expect(after.fieldSources?.responsible).toBeUndefined();
	});
});

describe('F2: undo of a confirmation makes its transitions pending again', () => {
	it('confirm, undo, confirm again closes the item', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'paid', receivedAt: T2 }
		);
		await apply(t, mail(b), threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [],
				transitions: [
					{
						about: 'Send the contract to Alice',
						to: 'done',
						evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'paid' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		await apply(t, mail(a), threadId, { result: reduceResult({ items: [alice] }) });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const { _id: itemId } = await itemOf(t, threadId);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		expect((await itemOf(t, threadId)).status).toBe('done');
		await t.mutation(api.mail.interpret.reactions.undo, { itemId });
		expect((await itemOf(t, threadId)).status).toBe('open');
		const row = await t.run(async (ctx) =>
			(await ctx.db.query('messageInterpretations').collect()).find((r) => r.source.id === b)
		);
		expect(row?.pendingTransitions).toEqual([0]);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		expect((await itemOf(t, threadId)).status).toBe('done');
	});
});

describe('F3: a newer removal deletes the held value', () => {
	it('held EUR 100, then amount removed: only the removal is held', () => {
		const merged = mergeHeld(
			{ evidence: [], amount: { value: 100, currency: 'EUR' } },
			{ evidence: [], removes: ['amount'] }
		);
		expect(merged.amount).toBeUndefined();
		expect(merged.removes).toEqual(['amount']);
	});
});

describe('F4: changed parties move the counterparty key', () => {
	it('Alice → Bob on confirm, back to Alice on undo', async () => {
		const t = harness();
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		await apply(t, mail(a), threadId, { result: reduceResult({ items: [alice] }) });
		const item = await itemOf(t, threadId);
		expect(item.counterpartyKey).toBe('alice@example.com');
		await t.run(async (ctx) => {
			await ctx.db.patch(item._id, { correction: { by: 'user-A', at: T1, kind: 'confirmed' } });
		});
		await apply(t, mail(a), threadId, {
			contentRevision: 'rev-2',
			result: reduceResult({ items: [{ ...bob, matchItemId: item._id }] }),
		});
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: item._id });
		expect((await itemOf(t, threadId)).counterpartyKey).toBe('bob@example.com');
		await t.mutation(api.mail.interpret.reactions.undo, { itemId: item._id });
		expect((await itemOf(t, threadId)).counterpartyKey).toBe('alice@example.com');
		void mailboxId;
	});
});

describe('F5: send failure follows dispositionSource', () => {
	async function outbound(
		t: Test,
		mailboxId: Id<'mailboxes'>,
		threadId: Id<'mailThreads'>,
		at: number
	) {
		const id = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'Done.', receivedAt: at }
		);
		await t.run(async (ctx) => {
			await ctx.db.patch(id, {
				outbound: {
					state: 'sent',
					recipients: [{ idx: 0, address: 'alice@example.com', mtaJobId: 'pb-x-0', state: 'sent' }],
				} as never,
			});
		});
		return id;
	}
	const bounce = (t: Test, id: Id<'mailMessages'>) =>
		t.run(async (ctx) => {
			const message = await ctx.db.get(id);
			await ctx.db.patch(id, {
				outbound: {
					...message!.outbound!,
					recipients: [
						{ idx: 0, address: 'alice@example.com', mtaJobId: 'pb-x-0', state: 'bounced' },
					],
				} as never,
			});
			return reconcileSendFailure(ctx, { kind: 'outboundMail', id });
		});

	it('a reaffirming reply that later bounces fails the answer it now supports', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		await apply(t, mail(a), threadId, { result: reduceResult({ items: [alice] }) });
		const { _id: itemId } = await itemOf(t, threadId);
		const answer = (id: Id<'mailMessages'>, at: number) =>
			apply(t, { kind: 'outboundMail', id }, threadId, {
				sourceAt: at,
				result: reduceResult({
					items: [],
					transitions: [
						{
							itemId,
							disposition: 'answered',
							evidence: [{ segmentId: 's0', start: 0, end: 5, quote: 'Done.' }],
							isVerified: true,
							isReviewNeeded: false,
						},
					],
				}),
			});
		const first = await outbound(t, mailboxId, threadId, T2);
		const second = await outbound(t, mailboxId, threadId, T3);
		await answer(first, T2);
		await answer(second, T3);
		expect((await itemOf(t, threadId)).dispositionSource?.sourceKey).toBe(`outboundMail:${second}`);
		expect(await bounce(t, first)).toEqual([]);
		expect(await bounce(t, second)).toEqual([itemId]);
		expect((await itemOf(t, threadId)).disposition).toBe('failed');
	});

	it('confirming a held answer from a send that already bounced fails it at once', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const sent = await outbound(t, mailboxId, threadId, T2);
		await apply(t, { kind: 'outboundMail', id: sent }, threadId, {
			sourceAt: T2,
			result: reduceResult({
				items: [],
				transitions: [
					{
						about: 'Send the contract to Alice',
						disposition: 'answered',
						evidence: [{ segmentId: 's0', start: 0, end: 5, quote: 'Done.' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		await apply(t, mail(a), threadId, { result: reduceResult({ items: [alice] }) });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await bounce(t, sent)).toEqual([]);
		const { _id: itemId } = await itemOf(t, threadId);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		expect((await itemOf(t, threadId)).disposition).toBe('failed');
	});
});
