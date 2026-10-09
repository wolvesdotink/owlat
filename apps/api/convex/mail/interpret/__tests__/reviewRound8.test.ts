/**
 * Review round 8: a standing per-field provenance map on the item (F1); a
 * confirmed held reaffirmation moves the disposition source (F2); send
 * failure reconciles state independently of its activity row (F3).
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import betterAuthSchema from '../../../betterAuth/schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { ReduceItem, ReduceResult } from '../reduceInput';
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
const T4 = Date.UTC(2026, 9, 8, 9, 0);

function harness(): Test {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	return t;
}

type Source = { kind: 'mail' | 'outboundMail'; id: Id<'mailMessages'> };

async function apply(
	t: Test,
	source: Source,
	threadId: Id<'mailThreads'>,
	result: ReduceResult,
	over: { contentRevision?: string; sourceAt?: number } = {}
) {
	const revision = await t.run(
		async (ctx) =>
			(
				await ctx.db
					.query('threadBriefs')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
					.first()
			)?.interpretationRevision ?? 0
	);
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
		result,
	});
}

const mail = (id: Id<'mailMessages'>): Source => ({ kind: 'mail', id });
const out = (id: Id<'mailMessages'>): Source => ({ kind: 'outboundMail', id });
const itemOf = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(
		async (ctx) =>
			(await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.first())!
	);

const alice: ReduceItem = reduceItem({
	assertion: 'Send the contract to Alice',
	display: { en: 'Send the contract to Alice', de: 'Schick Alice den Vertrag' },
	requester: { email: 'me@owlat.test', isUs: true },
	responsible: { email: 'alice@example.com', name: 'Alice', isUs: false },
	amount: { value: 1000, currency: 'EUR' },
	due: undefined,
});
const quote = [{ segmentId: 's0', start: 0, end: 5, quote: 'Done.' }];

async function sent(
	t: Test,
	at: { mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'> },
	when: number
) {
	const id = await addMessageToThread(t, at, { text: 'Done.', receivedAt: when });
	await t.run(async (ctx) => {
		await ctx.db.patch(id, {
			outbound: {
				state: 'sent',
				recipients: [{ idx: 0, address: 'alice@example.com', mtaJobId: 'j', state: 'sent' }],
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
				recipients: [{ idx: 0, address: 'alice@example.com', mtaJobId: 'j', state: 'bounced' }],
			} as never,
		});
		return reconcileSendFailure(ctx, { kind: 'outboundMail', id });
	});

/** A held "answered" from send `id`, read before the item existed. */
const heldAnswer = reduceResult({
	items: [],
	transitions: [
		{
			about: 'Send the contract to Alice',
			disposition: 'answered',
			evidence: quote,
			isVerified: true,
			isReviewNeeded: false,
		},
	],
});

describe('F1: the item keeps a standing provenance per field', () => {
	it('confirm Alice→Bob from B, then an amount from C, purge B: Bob is gone', async () => {
		const t = harness();
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(t, { mailboxId, threadId }, { text: 'Bob', receivedAt: T2 });
		const c = await addMessageToThread(t, { mailboxId, threadId }, { text: '900', receivedAt: T3 });
		await apply(t, mail(a), threadId, reduceResult({ items: [alice] }));
		const { _id: itemId } = await itemOf(t, threadId);
		expect((await itemOf(t, threadId)).fieldSources?.responsible?.sourceKey).toBe(`mail:${a}`);
		await t.run(async (ctx) => {
			await ctx.db.patch(itemId, { correction: { by: 'user-A', at: T1, kind: 'confirmed' } });
		});
		const claim = (over: Partial<ReduceItem>) =>
			reduceResult({ items: [{ ...alice, ...over, matchItemId: itemId, evidence: [] }] });
		await apply(
			t,
			mail(b),
			threadId,
			claim({ responsible: { email: 'bob@example.com', name: 'Bob', isUs: false } }),
			{ sourceAt: T2 }
		);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		await apply(
			t,
			mail(c),
			threadId,
			claim({
				responsible: { email: 'bob@example.com', name: 'Bob', isUs: false },
				amount: { value: 900, currency: 'EUR' },
			}),
			{ sourceAt: T3 }
		);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		const confirmed = await itemOf(t, threadId);
		expect(confirmed.counterpartyKey).toBe('bob@example.com');
		expect(confirmed.fieldSources?.responsible?.sourceKey).toBe(`mail:${b}`);
		expect(confirmed.fieldSources?.amount?.sourceKey).toBe(`mail:${c}`);

		await t.run(async (ctx) =>
			stripItem(
				ctx,
				{ kind: 'mail', id: threadId },
				(await ctx.db.get(itemId))!,
				{ ids: new Set([b]), keys: new Set([`mail:${b}`]) },
				unitBudget(1000)
			)
		);
		const after = await itemOf(t, threadId);
		expect(after.responsible.email).toBeUndefined();
		expect(after.counterpartyKey).toBeUndefined();
		expect(after.amount).toEqual({ value: 900, currency: 'EUR' });
		expect(after.fieldSources?.amount?.sourceKey).toBe(`mail:${c}`);
	});
});

describe('F2 / F3: held answers and the sends they rest on', () => {
	it('confirming a newer held answer moves the dependency from A to B', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const at = { mailboxId, threadId };
		const replyB = await sent(t, at, T3);
		await apply(t, out(replyB), threadId, heldAnswer, { sourceAt: T3 });
		await apply(t, mail(a), threadId, reduceResult({ items: [alice] }));
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const { _id: itemId } = await itemOf(t, threadId);
		const replyA = await sent(t, at, T2);
		await apply(
			t,
			out(replyA),
			threadId,
			reduceResult({
				items: [],
				transitions: [
					{
						itemId,
						disposition: 'answered',
						evidence: quote,
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
			{ sourceAt: T2 }
		);
		expect((await itemOf(t, threadId)).dispositionSource?.sourceKey).toBe(`outboundMail:${replyA}`);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		expect((await itemOf(t, threadId)).dispositionSource).toEqual({
			sourceKey: `outboundMail:${replyB}`,
			at: T3,
		});
		expect(await bounce(t, replyA)).toEqual([]);
		expect(await bounce(t, replyB)).toEqual([itemId]);
	});

	it('confirm, bounce, undo, confirm: the bounced send fails the answer again', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const reply = await sent(t, { mailboxId, threadId }, T4);
		await apply(t, out(reply), threadId, heldAnswer, { sourceAt: T4 });
		await apply(t, mail(a), threadId, reduceResult({ items: [alice] }));
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const { _id: itemId } = await itemOf(t, threadId);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		expect(await bounce(t, reply)).toEqual([itemId]);
		await t.mutation(api.mail.interpret.reactions.undo, { itemId });
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId });
		expect((await itemOf(t, threadId)).disposition).toBe('failed');
	});
});
