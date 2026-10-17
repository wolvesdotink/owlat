/**
 * Explain (SPEC §4.1): "Why here?" answers from the newest inbound arrival
 * record, behind the Postbox mailbox access check, and a fenced thread shows
 * nothing a model derived.
 */

import { describe, expect, it, vi } from 'vitest';
import { api } from '../../../_generated/api';
import { seedMailbox } from '../../__tests__/helpers.testlib';
import { isReasonShownWhenFenced } from '../explain';
import { deliverLive, learnTest, patchRecord, seedPersonalMailbox } from './learn.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

describe('explain.forThread', () => {
	it('returns the record, the sender counters and what decided the placement', async () => {
		const t = learnTest();
		await seedPersonalMailbox(t);
		const { message, thread } = await deliverLive(t);
		await deliverLive(t, { subject: 'Another sale' });
		await patchRecord(t, message._id, {
			category: 'newsletter',
			categorySource: 'llm',
			depth: 'count',
			modelCalls: 0,
			reasonKeys: [
				{ key: 'arrival.reason.category', params: { category: 'newsletter', source: 'llm' } },
			],
		});

		const why = await t.query(api.mail.arrival.explain.forThread, { threadId: thread._id });
		expect(why).toMatchObject({
			threadId: thread._id,
			messageId: message._id,
			placement: 'digest',
			decidedBy: 'category',
			category: { label: 'newsletter', source: 'llm' },
			depth: 'count',
			modelCalls: 0,
			isFenced: false,
			sender: { address: 'news@shop.example', displayName: 'Shop', status: 'keep' },
		});
		expect(why!.sender.delivered).toBe(2);
		expect(why!.sender.opened).toBe(0);
		expect(why!.reasons).toEqual([
			{ key: 'arrival.reason.category', params: { category: 'newsletter', source: 'llm' } },
		]);
	});

	it('names a thread override set by a person', async () => {
		const t = learnTest();
		await seedPersonalMailbox(t);
		const { message, thread } = await deliverLive(t);
		await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'needs_me',
			scope: 'message',
		});
		const why = await t.query(api.mail.arrival.explain.forThread, { threadId: thread._id });
		expect(why).toMatchObject({
			placement: 'needs_me',
			decidedBy: 'thread_override',
			override: { scope: 'thread', placement: 'needs_me' },
		});
	});

	it('hides model-derived reasons and the model category on a fenced thread', async () => {
		const t = learnTest();
		await seedPersonalMailbox(t);
		const { message, thread } = await deliverLive(t);
		await patchRecord(t, message._id, {
			category: 'newsletter',
			categorySource: 'llm',
			reasonKeys: [
				{ key: 'arrival.reason.category', params: { category: 'newsletter', source: 'llm' } },
				{ key: 'arrival.reason.budget' },
				{ key: 'arrival.reason.someLaterLaneKey' },
			],
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(thread._id, { interpretationStaleSince: Date.now() });
		});
		const why = await t.query(api.mail.arrival.explain.forThread, { threadId: thread._id });
		expect(why!.isFenced).toBe(true);
		expect(why!.category).toBeUndefined();
		expect(why!.reasons).toEqual([{ key: 'arrival.reason.budget' }]);
	});

	it('is null for a mailbox the caller cannot read, and for a thread without a record', async () => {
		const t = learnTest();
		await seedPersonalMailbox(t);
		const { thread } = await deliverLive(t);
		const otherMailbox = await seedMailbox(t, {
			userId: 'user-B',
			organizationId: 'org-2',
			address: 'b@owlat.test',
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(thread._id, { mailboxId: otherMailbox });
		});
		expect(await t.query(api.mail.arrival.explain.forThread, { threadId: thread._id })).toBeNull();

		const bare = (await deliverLive(t, { from: 'Other <other@example.com>', subject: 'Hello' }))
			.thread._id;
		await t.run(async (ctx) => {
			for (const record of await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_thread_created', (q) => q.eq('threadId', bare))
				.collect()) {
				await ctx.db.delete(record._id);
			}
		});
		expect(await t.query(api.mail.arrival.explain.forThread, { threadId: bare })).toBeNull();
	});
});

describe('isReasonShownWhenFenced', () => {
	const noAi = { filterMatches: [] };
	const aiYes = {
		filterMatches: [{ filterId: 'f' as never, revision: 1, pass: 'ai' as const, answer: true }],
	};
	it('keeps deterministic rungs and a non-model category', () => {
		expect(isReasonShownWhenFenced({ key: 'arrival.reason.security' }, noAi)).toBe(true);
		expect(
			isReasonShownWhenFenced(
				{ key: 'arrival.reason.category', params: { source: 'heuristic' } },
				noAi
			)
		).toBe(true);
	});
	it('drops a rule digest when the rule matched on a model answer', () => {
		const reason = { key: 'arrival.reason.digest', params: { by: 'rule' } };
		expect(isReasonShownWhenFenced(reason, noAi)).toBe(true);
		expect(isReasonShownWhenFenced(reason, aiYes)).toBe(false);
	});
});
