/**
 * Undo of an operator's bulk topic edit: the receipts `addContacts`
 * and `removeContacts` return, and the inverses that take them back
 * (`undoAddContacts` / `undoRemoveContacts`). The inverse touches exactly the
 * delta the forward call made, restores the membership metadata and the cached
 * count, and fires none of the subscribe path's effects.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestContact,
	createTestTopic,
} from './factories';
import { expectScheduledFailure } from './helpers/scheduledFailures';

beforeEach(() => {
	expectScheduledFailure('confirmationEmail:sendConfirmationEmail');
});

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

type T = TestConvex<typeof schema>;

async function seed(t: T, topic: Record<string, unknown> = {}) {
	return await t.run(async (ctx) => {
		const topicId = await ctx.db.insert(
			'topics',
			createTestTopic({ requireDoubleOptIn: false, cachedMemberCount: 0, ...topic })
		);
		const contacts: Id<'contacts'>[] = [];
		for (let i = 0; i < 4; i++) {
			contacts.push(
				await ctx.db.insert(
					'contacts',
					createTestContact({ email: `c${i}@example.com`, doiStatus: 'not_required' })
				)
			);
		}
		return { topicId, contacts };
	});
}

async function membersOf(t: T, topicId: Id<'topics'>) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('contactTopics')
			.withIndex('by_topic', (q) => q.eq('topicId', topicId))
			.collect()
	);
}

async function cachedCount(t: T, topicId: Id<'topics'>) {
	return await t.run(async (ctx) => (await ctx.db.get(topicId))?.cachedMemberCount);
}

describe('bulk add receipt and undo', () => {
	it('receipts only the memberships the add inserted, and the undo removes exactly those', async () => {
		const t = convexTest(schema, modules);
		const { topicId, contacts } = await seed(t);
		const [existing, a, b] = contacts as [Id<'contacts'>, Id<'contacts'>, Id<'contacts'>];
		await t.run(async (ctx) => {
			await ctx.db.insert('contactTopics', { contactId: existing, topicId, addedAt: 1 });
			await ctx.db.patch(topicId, { cachedMemberCount: 1 });
		});

		// An existing member and a duplicate id change nothing and are not receipted.
		const { added } = await t.mutation(api.topics.bulk.addContacts, {
			topicId,
			contactIds: [existing, a, b, a],
		});
		expect(added).toHaveLength(2);
		expect(await cachedCount(t, topicId)).toBe(3);

		const { reverted } = await t.mutation(api.topics.bulk.undoAddContacts, { topicId, added });
		expect(reverted).toBe(2);

		const left = await membersOf(t, topicId);
		expect(left.map((m) => m.contactId)).toEqual([existing]);
		expect(left[0]!.addedAt).toBe(1);
		expect(await cachedCount(t, topicId)).toBe(1);

		// A second undo of the same receipt is a no-op.
		expect((await t.mutation(api.topics.bulk.undoAddContacts, { topicId, added })).reverted).toBe(
			0
		);
		expect(await cachedCount(t, topicId)).toBe(1);
	});

	it('leaves a membership that was removed and re-added since', async () => {
		const t = convexTest(schema, modules);
		const { topicId, contacts } = await seed(t);
		const a = contacts[0]!;
		const { added } = await t.mutation(api.topics.bulk.addContacts, {
			topicId,
			contactIds: [a],
		});
		await t.mutation(api.topics.bulk.removeContacts, { topicId, contactIds: [a] });
		await t.mutation(api.topics.bulk.addContacts, { topicId, contactIds: [a] });

		const { reverted } = await t.mutation(api.topics.bulk.undoAddContacts, { topicId, added });
		expect(reverted).toBe(0);
		expect(await membersOf(t, topicId)).toHaveLength(1);
		expect(await cachedCount(t, topicId)).toBe(1);
	});

	it('puts back the global opt-out the add lifted', async () => {
		const t = convexTest(schema, modules);
		const { topicId, contacts } = await seed(t);
		const optedOut = contacts[0]!;
		const plain = contacts[1]!;
		await t.run(async (ctx) => ctx.db.patch(optedOut, { unsubscribedAt: 1234 }));

		const { added } = await t.mutation(api.topics.bulk.addContacts, {
			topicId,
			contactIds: [optedOut, plain],
		});
		expect(added.map((r) => r.liftedOptOutAt)).toEqual([1234, undefined]);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(optedOut))?.unsubscribedAt).toBeUndefined();
		});

		await t.mutation(api.topics.bulk.undoAddContacts, { topicId, added });
		await t.run(async (ctx) => {
			expect((await ctx.db.get(optedOut))?.unsubscribedAt).toBe(1234);
			expect((await ctx.db.get(plain))?.unsubscribedAt).toBeUndefined();
		});
	});

	it('receipts pending-DOI memberships too', async () => {
		const t = convexTest(schema, modules);
		const { topicId, contacts } = await seed(t, { requireDoubleOptIn: true });
		const { added } = await t.mutation(api.topics.bulk.addContacts, {
			topicId,
			contactIds: [contacts[0]!],
			siteUrl: 'https://owlat.example',
		});
		expect(added).toHaveLength(1);
		await t.mutation(api.topics.bulk.undoAddContacts, { topicId, added });
		expect(await membersOf(t, topicId)).toHaveLength(0);
		expect(await cachedCount(t, topicId)).toBe(0);
	});
});

describe('bulk remove receipt and undo', () => {
	it('receipts only the memberships the remove deleted, and the undo restores them as they were', async () => {
		const t = convexTest(schema, modules);
		const { topicId, contacts } = await seed(t);
		const [a, b, nonMember] = contacts as [Id<'contacts'>, Id<'contacts'>, Id<'contacts'>];
		await t.run(async (ctx) => {
			await ctx.db.insert('contactTopics', { contactId: a, topicId, addedAt: 111 });
			await ctx.db.insert('contactTopics', {
				contactId: b,
				topicId,
				addedAt: 222,
				pendingDoiConfirmation: true,
			});
			await ctx.db.patch(b, { doiStatus: 'pending' });
			await ctx.db.patch(topicId, { cachedMemberCount: 2 });
		});

		const { removed } = await t.mutation(api.topics.bulk.removeContacts, {
			topicId,
			contactIds: [a, b, nonMember, a],
		});
		expect(removed).toEqual([
			{ contactId: a, addedAt: 111 },
			{ contactId: b, addedAt: 222, pendingDoiConfirmation: true },
		]);
		expect(await cachedCount(t, topicId)).toBe(0);

		const { restored } = await t.mutation(api.topics.bulk.undoRemoveContacts, {
			topicId,
			removed,
		});
		expect(restored).toBe(2);
		const back = await membersOf(t, topicId);
		expect(
			back
				.map((m) => ({
					contactId: m.contactId,
					addedAt: m.addedAt,
					pending: m.pendingDoiConfirmation,
				}))
				.sort((x, y) => x.addedAt - y.addedAt)
		).toEqual([
			{ contactId: a, addedAt: 111, pending: undefined },
			{ contactId: b, addedAt: 222, pending: true },
		]);
		expect(await cachedCount(t, topicId)).toBe(2);
	});

	it('restores without the subscribe effects: no DOI request, no trigger, no lifted opt-out', async () => {
		const t = convexTest(schema, modules);
		const { topicId, contacts } = await seed(t, { requireDoubleOptIn: true });
		const a = contacts[0]!;
		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'topic_subscribed',
					triggerConfig: { topicId },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId }));
			await ctx.db.insert('contactTopics', { contactId: a, topicId, addedAt: 5 });
			await ctx.db.patch(a, { unsubscribedAt: 77 });
		});

		const { removed } = await t.mutation(api.topics.bulk.removeContacts, {
			topicId,
			contactIds: [a],
		});
		await t.mutation(api.topics.bulk.undoRemoveContacts, { topicId, removed });

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(a);
			expect(contact?.doiStatus).toBe('not_required');
			expect(contact?.doiConfirmationToken).toBeUndefined();
			expect(contact?.unsubscribedAt).toBe(77);
			expect(await ctx.db.query('automationRuns').collect()).toHaveLength(0);
		});
		expect(await membersOf(t, topicId)).toHaveLength(1);
	});

	it('skips a contact that is a member again or was deleted since', async () => {
		const t = convexTest(schema, modules);
		const { topicId, contacts } = await seed(t);
		const [rejoined, deleted] = contacts as [Id<'contacts'>, Id<'contacts'>];
		await t.run(async (ctx) => {
			await ctx.db.insert('contactTopics', { contactId: rejoined, topicId, addedAt: 1 });
			await ctx.db.insert('contactTopics', { contactId: deleted, topicId, addedAt: 2 });
			await ctx.db.patch(topicId, { cachedMemberCount: 2 });
		});
		const { removed } = await t.mutation(api.topics.bulk.removeContacts, {
			topicId,
			contactIds: [rejoined, deleted],
		});
		await t.mutation(api.topics.bulk.addContacts, { topicId, contactIds: [rejoined] });
		await t.run(async (ctx) => ctx.db.patch(deleted, { deletedAt: Date.now() }));

		const { restored } = await t.mutation(api.topics.bulk.undoRemoveContacts, {
			topicId,
			removed,
		});
		expect(restored).toBe(0);
		const back = await membersOf(t, topicId);
		expect(back.map((m) => m.contactId)).toEqual([rejoined]);
		expect(await cachedCount(t, topicId)).toBe(1);
	});

	it('drops the form-DOI deferral flag when the contact confirmed in between', async () => {
		const t = convexTest(schema, modules);
		const { topicId, contacts } = await seed(t);
		const a = contacts[0]!;
		const { restored } = await t.mutation(api.topics.bulk.undoRemoveContacts, {
			topicId,
			removed: [{ contactId: a, addedAt: 9, pendingDoiConfirmation: true }],
		});
		expect(restored).toBe(1);
		const [row] = await membersOf(t, topicId);
		// not_required is not "confirmed": the flag stays.
		expect(row?.pendingDoiConfirmation).toBe(true);

		await t.run(async (ctx) => {
			await ctx.db.delete(row!._id);
			await ctx.db.patch(a, { doiStatus: 'confirmed', doiConfirmedAt: 10 });
		});
		await t.mutation(api.topics.bulk.undoRemoveContacts, {
			topicId,
			removed: [{ contactId: a, addedAt: 9, pendingDoiConfirmation: true }],
		});
		const [again] = await membersOf(t, topicId);
		expect(again?.pendingDoiConfirmation).toBeUndefined();
	});
});
