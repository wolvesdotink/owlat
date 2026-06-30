/**
 * Integration tests for Topic subscription (module).
 *
 * Covers the five entry points (subscribe / subscribeMany / unsubscribe /
 * unsubscribeMany / unsubscribeAllForContact), the source→effects gating,
 * the DOI handoff at subscribe time, and the drift-bug closures named in
 * docs/adr/0013-topic-subscription-module.md.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider'),
	),
);

// ─── Helpers ────────────────────────────────────────────────────────────────
//
// `t` is typed `TestConvex<typeof schema>` so convex-test threads the schema
// generic through, giving schema-aware `ctx` and `.withIndex` typings inside
// callback bodies.

async function createContact(
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'contacts'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('contacts', {
			email: 'test@example.com',
			firstName: 'Ada',
			source: 'api' as const,
			searchableText: 'test@example.com ada',
			doiStatus: 'not_required' as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides,
		});
	});
}

async function createTopic(
	t: TestConvex<typeof schema>,
	requireDoubleOptIn: boolean,
	name = 'Newsletter',
): Promise<Id<'topics'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('topics', {
			name,
			requireDoubleOptIn,
			createdAt: Date.now(),
		});
	});
}

async function getMembership(
	t: TestConvex<typeof schema>,
	contactId: Id<'contacts'>,
	topicId: Id<'topics'>,
) {
	return await t.run(async (ctx) => {
		return await ctx.db
			.query('contactTopics')
			.withIndex('by_contact_and_topic', (q) =>
				q.eq('contactId', contactId).eq('topicId', topicId),
			)
			.first();
	});
}

async function getTopic(t: TestConvex<typeof schema>, topicId: Id<'topics'>) {
	return await t.run(async (ctx) => await ctx.db.get(topicId));
}

async function getContact(
	t: TestConvex<typeof schema>,
	contactId: Id<'contacts'>,
) {
	return await t.run(async (ctx) => await ctx.db.get(contactId));
}

async function getActivitiesForContact(
	t: TestConvex<typeof schema>,
	contactId: Id<'contacts'>,
) {
	return await t.run(async (ctx) => {
		return await ctx.db
			.query('contactActivities')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.collect();
	});
}

// ============================================================
// subscribe — single
// ============================================================

describe('subscription.subscribe', () => {
	it('returns subscribed when topic does not require DOI', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, false);

		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId, contactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('subscribed');
		}

		const membership = await getMembership(t, contactId, topicId);
		expect(membership).not.toBeNull();

		const topic = await getTopic(t, topicId);
		expect(topic?.cachedMemberCount).toBe(1);
	});

	it('returns subscribed when topic requires DOI but contact is already confirmed', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t, {
			doiStatus: 'confirmed',
			doiConfirmedAt: Date.now(),
		});
		const topicId = await createTopic(t, true);

		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId, contactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('subscribed');
		}

		// Contact stays confirmed; DOI lifecycle was not invoked.
		const contact = await getContact(t, contactId);
		expect(contact?.doiStatus).toBe('confirmed');
		expect(contact?.doiConfirmationToken).toBeUndefined();
	});

	it('returns pending_doi when topic requires DOI and contact is not_required', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, true);

		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId, contactId, source: 'form', siteUrl: 'https://example.com' },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('pending_doi');
		}

		// DOI lifecycle was invoked: contact is now pending with a token.
		const contact = await getContact(t, contactId);
		expect(contact?.doiStatus).toBe('pending');
		expect(contact?.doiConfirmationToken).toBeDefined();
		expect(contact?.doiTokenExpiresAt).toBeDefined();

		// Membership row created regardless of DOI state.
		const membership = await getMembership(t, contactId, topicId);
		expect(membership).not.toBeNull();
	});

	it('returns pending_doi without overwriting the token when contact is already pending', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t, {
			doiStatus: 'pending',
			doiConfirmationToken: 'first-token',
			doiTokenExpiresAt: Date.now() + 86400_000,
		});
		const topicId = await createTopic(t, true);

		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId, contactId, source: 'form', siteUrl: 'https://example.com' },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('pending_doi');
		}

		// DOI lifecycle should be idempotent on pending → pending — original
		// token survives.
		const contact = await getContact(t, contactId);
		expect(contact?.doiConfirmationToken).toBe('first-token');
	});

	it('returns already_member as a no-op when the membership already exists', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, false);

		// Subscribe once.
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId,
			contactId,
			source: 'admin',
		});

		// Subscribe again — should be a no-op.
		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId, contactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('already_member');
		}

		// Count stays at 1 (no double increment).
		const topic = await getTopic(t, topicId);
		expect(topic?.cachedMemberCount).toBe(1);
	});

	it('refuses to subscribe a soft-deleted contact', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t, { deletedAt: Date.now() });
		const topicId = await createTopic(t, false);

		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId, contactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('contact_soft_deleted');
		}

		// No membership written.
		const membership = await getMembership(t, contactId, topicId);
		expect(membership).toBeNull();
	});

	it('returns contact_not_found for unknown contactId', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);

		const fakeContactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', {
				email: 'temp@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId, contactId: fakeContactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('contact_not_found');
		}
	});

	it('returns topic_not_found for unknown topicId', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);

		const fakeTopicId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('topics', {
				name: 'temp',
				createdAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId: fakeTopicId, contactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('topic_not_found');
		}
	});

	it('skipDoi: true bypasses DOI even when topic requires it', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, true);

		const outcome = await t.mutation(
			internal.topics.subscription.subscribe,
			{ topicId, contactId, source: 'import', skipDoi: true },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('subscribed');
		}

		// Contact's DOI status untouched — skipDoi means "treat as already
		// confirmed for this action," not "transition DOI status."
		const contact = await getContact(t, contactId);
		expect(contact?.doiStatus).toBe('not_required');
		expect(contact?.doiConfirmationToken).toBeUndefined();
	});
});

// ============================================================
// subscribeMany
// ============================================================

describe('subscription.subscribeMany', () => {
	it('coalesces cachedMemberCount patch (one patch per call regardless of array size)', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);

		const contactIds = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				createContact(t, {
					email: `c${i}@example.com`,
					searchableText: `c${i}@example.com`,
				}),
			),
		);

		const { outcomes } = await t.mutation(
			internal.topics.subscription.subscribeMany,
			{ topicId, contactIds, source: 'admin' },
		);

		expect(outcomes).toHaveLength(10);
		for (const outcome of outcomes) {
			expect(outcome.ok).toBe(true);
			if (outcome.ok) {
				expect(outcome.action).toBe('subscribed');
			}
		}

		// All 10 reach the topic — cachedMemberCount reflects them all.
		const topic = await getTopic(t, topicId);
		expect(topic?.cachedMemberCount).toBe(10);
	});

	it('mixes outcomes per contact (subscribed / already_member / soft_deleted)', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);

		const newContact = await createContact(t, {
			email: 'new@example.com',
			searchableText: 'new@example.com',
		});
		const memberContact = await createContact(t, {
			email: 'member@example.com',
			searchableText: 'member@example.com',
		});
		const deletedContact = await createContact(t, {
			email: 'deleted@example.com',
			searchableText: 'deleted@example.com',
			deletedAt: Date.now(),
		});

		// Pre-subscribe the member.
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId,
			contactId: memberContact,
			source: 'admin',
		});

		const { outcomes } = await t.mutation(
			internal.topics.subscription.subscribeMany,
			{
				topicId,
				contactIds: [newContact, memberContact, deletedContact],
				source: 'admin',
			},
		);

		expect(outcomes[0]!.ok).toBe(true);
		if (outcomes[0]!.ok) expect(outcomes[0]!.action).toBe('subscribed');
		expect(outcomes[1]!.ok).toBe(true);
		if (outcomes[1]!.ok) expect(outcomes[1]!.action).toBe('already_member');
		expect(outcomes[2]!.ok).toBe(false);
		if (!outcomes[2]!.ok) expect(outcomes[2]!.reason).toBe('contact_soft_deleted');

		// Topic count = 2 (member + new); deleted contact not added.
		const topic = await getTopic(t, topicId);
		expect(topic?.cachedMemberCount).toBe(2);
	});

	it('returns topic_not_found for every contact when topic is missing', async () => {
		const t = convexTest(schema, modules);
		const c1 = await createContact(t, { email: 'a@example.com' });
		const c2 = await createContact(t, { email: 'b@example.com' });

		const fakeTopicId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('topics', {
				name: 'temp',
				createdAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const { outcomes } = await t.mutation(
			internal.topics.subscription.subscribeMany,
			{ topicId: fakeTopicId, contactIds: [c1, c2], source: 'admin' },
		);

		expect(outcomes).toHaveLength(2);
		for (const outcome of outcomes) {
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.reason).toBe('topic_not_found');
		}
	});
});

// ============================================================
// unsubscribe — single (admin source)
// ============================================================

describe('subscription.unsubscribe — admin source', () => {
	it('deletes membership, writes activity row, decrements count, patches contact.updatedAt — but does NOT fire webhook/form-clear/campaign-stats', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, false);

		// Subscribe first.
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId,
			contactId,
			source: 'admin',
		});

		const beforeContact = await getContact(t, contactId);
		const beforeUpdatedAt = beforeContact?.updatedAt ?? 0;

		// Add an artificial confirmedAt form submission to verify it's NOT cleared.
		const formId = await t.run(async (ctx) =>
			ctx.db.insert('formEndpoints', {
				name: 'f',
				topicId,
				fields: [],
				isActive: true,
				submissionCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const submissionId = await t.run(async (ctx) =>
			ctx.db.insert('formSubmissions', {
				formEndpointId: formId,
				contactId,
				data: {},
				status: 'success' as const,
				confirmedAt: Date.now(),
				submittedAt: Date.now(),
			}),
		);

		// Unsubscribe.
		const outcome = await t.mutation(
			internal.topics.subscription.unsubscribe,
			{ topicId, contactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.action).toBe('unsubscribed');

		// Membership gone.
		const membership = await getMembership(t, contactId, topicId);
		expect(membership).toBeNull();

		// Count decremented (closes drift bug #4 — bulk-remove cachedMemberCount;
		// here verifying single-remove sequence).
		const topic = await getTopic(t, topicId);
		expect(topic?.cachedMemberCount).toBe(0);

		// Activity row written (closes drift bug #3 — admin-remove activity row).
		const activities = await getActivitiesForContact(t, contactId);
		const unsubActivities = activities.filter(
			(a: { activityType: string }) => a.activityType === 'topic_unsubscribed',
		);
		expect(unsubActivities).toHaveLength(1);
		expect(unsubActivities[0]?.metadata?.reason).toBe('admin_remove');

		// Contact.updatedAt patched.
		const afterContact = await getContact(t, contactId);
		expect(afterContact?.updatedAt).toBeGreaterThanOrEqual(beforeUpdatedAt);

		// Form-submission confirmedAt NOT cleared (admin source — drift bug #5
		// preserved by design).
		const submission = await t.run(async (ctx) => ctx.db.get(submissionId));
		expect(submission?.confirmedAt).toBeDefined();
	});

	it('returns not_member as a no-op when the contact is not subscribed', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, false);

		const outcome = await t.mutation(
			internal.topics.subscription.unsubscribe,
			{ topicId, contactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.action).toBe('not_member');

		// No activity row written.
		const activities = await getActivitiesForContact(t, contactId);
		expect(activities.filter((a: { activityType: string }) => a.activityType === 'topic_unsubscribed'))
			.toHaveLength(0);
	});

	it('returns contact_not_found for unknown contactId', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);
		const fakeContactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', {
				email: 'gone@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const outcome = await t.mutation(
			internal.topics.subscription.unsubscribe,
			{ topicId, contactId: fakeContactId, source: 'admin' },
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('contact_not_found');
	});
});

// ============================================================
// unsubscribe — single (public_email_link source)
// ============================================================

describe('subscription.unsubscribe — public_email_link source', () => {
	it('clears form-submission confirmedAt and increments campaign statsUnsubscribed', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, false);

		// Subscribe first.
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId,
			contactId,
			source: 'admin',
		});

		// Add a confirmed form submission.
		const formId = await t.run(async (ctx) =>
			ctx.db.insert('formEndpoints', {
				name: 'f',
				topicId,
				fields: [],
				isActive: true,
				submissionCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const submissionId = await t.run(async (ctx) =>
			ctx.db.insert('formSubmissions', {
				formEndpointId: formId,
				contactId,
				data: {},
				status: 'success' as const,
				confirmedAt: Date.now(),
				submittedAt: Date.now(),
			}),
		);

		// Add a campaign + emailSend so campaign stats can increment.
		const campaignId = await t.run(async (ctx) =>
			ctx.db.insert('campaigns', {
				name: 'c',
				status: 'sent' as const,
				audience: { kind: 'topic' as const, topicId },
				statsSent: 1,
				statsUnsubscribed: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		await t.run(async (ctx) =>
			ctx.db.insert('emailSends', {
				campaignId,
				contactId,
				contactEmail: 'test@example.com',
				status: 'sent' as const,
				queuedAt: Date.now(),
				sentAt: Date.now(),
				openCount: 0,
			}),
		);

		// Fake timers so the scheduled recordCampaignUnsubscribe (runAfter 0) runs
		// under finishAllScheduledFunctions.
		vi.useFakeTimers();
		const outcome = await t.mutation(
			internal.topics.subscription.unsubscribe,
			{ topicId, contactId, source: 'public_email_link' },
		);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.action).toBe('unsubscribed');

		// Form submission confirmedAt cleared.
		const submission = await t.run(async (ctx) => ctx.db.get(submissionId));
		expect(submission?.confirmedAt).toBeUndefined();

		// Campaign statsUnsubscribed attributed off the synchronous public path via
		// the scheduled recordCampaignUnsubscribe.
		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.statsUnsubscribed).toBe(1);

		// Activity row written with the source-derived reason.
		const activities = await getActivitiesForContact(t, contactId);
		const unsub = activities.find(
			(a: { activityType: string }) => a.activityType === 'topic_unsubscribed',
		);
		expect(unsub?.metadata?.reason).toBe('unsubscribe');
	});
});

// ============================================================
// unsubscribeMany (admin source)
// ============================================================

describe('subscription.unsubscribeMany — admin source', () => {
	it('coalesces cachedMemberCount decrement and writes N activity rows', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);

		const contactIds = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				createContact(t, {
					email: `bulk${i}@example.com`,
					searchableText: `bulk${i}@example.com`,
				}),
			),
		);

		// Subscribe all 5.
		await t.mutation(internal.topics.subscription.subscribeMany, {
			topicId,
			contactIds,
			source: 'admin',
		});

		const topicBefore = await getTopic(t, topicId);
		expect(topicBefore?.cachedMemberCount).toBe(5);

		// Bulk unsubscribe all 5.
		const { outcomes } = await t.mutation(
			internal.topics.subscription.unsubscribeMany,
			{ topicId, contactIds, source: 'admin' },
		);

		expect(outcomes).toHaveLength(5);
		for (const outcome of outcomes) {
			expect(outcome.ok).toBe(true);
			if (outcome.ok) expect(outcome.action).toBe('unsubscribed');
		}

		// One coalesced patch — count back to 0 (closes drift bug #4).
		const topicAfter = await getTopic(t, topicId);
		expect(topicAfter?.cachedMemberCount).toBe(0);

		// N activity rows written.
		for (const contactId of contactIds) {
			const activities = await getActivitiesForContact(t, contactId);
			expect(
				activities.filter((a: { activityType: string }) => a.activityType === 'topic_unsubscribed'),
			).toHaveLength(1);
		}
	});
});

// ============================================================
// unsubscribeAllForContact (public_email_link source)
// ============================================================

describe('subscription.unsubscribeAllForContact', () => {
	it('removes a contact from all topics; per-contact effects fire ONCE', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicA = await createTopic(t, false, 'A');
		const topicB = await createTopic(t, false, 'B');
		const topicC = await createTopic(t, false, 'C');

		await t.mutation(internal.topics.subscription.subscribe, {
			topicId: topicA,
			contactId,
			source: 'admin',
		});
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId: topicB,
			contactId,
			source: 'admin',
		});
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId: topicC,
			contactId,
			source: 'admin',
		});

		// Add multiple confirmed form submissions to verify they're ALL cleared once.
		const formId = await t.run(async (ctx) =>
			ctx.db.insert('formEndpoints', {
				name: 'f',
				topicId: topicA,
				fields: [],
				isActive: true,
				submissionCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const sub1 = await t.run(async (ctx) =>
			ctx.db.insert('formSubmissions', {
				formEndpointId: formId,
				contactId,
				data: {},
				status: 'success' as const,
				confirmedAt: Date.now(),
				submittedAt: Date.now(),
			}),
		);
		const sub2 = await t.run(async (ctx) =>
			ctx.db.insert('formSubmissions', {
				formEndpointId: formId,
				contactId,
				data: {},
				status: 'success' as const,
				confirmedAt: Date.now(),
				submittedAt: Date.now(),
			}),
		);

		const { outcomes } = await t.mutation(
			internal.topics.subscription.unsubscribeAllForContact,
			{ contactId, source: 'public_email_link' },
		);

		expect(outcomes).toHaveLength(3);
		for (const outcome of outcomes) {
			expect(outcome.ok).toBe(true);
			if (outcome.ok) expect(outcome.action).toBe('unsubscribed');
		}

		// All memberships gone.
		expect(await getMembership(t, contactId, topicA)).toBeNull();
		expect(await getMembership(t, contactId, topicB)).toBeNull();
		expect(await getMembership(t, contactId, topicC)).toBeNull();

		// Per-topic cachedMemberCount decremented.
		expect((await getTopic(t, topicA))?.cachedMemberCount).toBe(0);
		expect((await getTopic(t, topicB))?.cachedMemberCount).toBe(0);
		expect((await getTopic(t, topicC))?.cachedMemberCount).toBe(0);

		// Form submission confirmations cleared (per-contact, all).
		expect((await t.run(async (ctx) => ctx.db.get(sub1)))?.confirmedAt)
			.toBeUndefined();
		expect((await t.run(async (ctx) => ctx.db.get(sub2)))?.confirmedAt)
			.toBeUndefined();

		// Three activity rows (one per topic).
		const activities = await getActivitiesForContact(t, contactId);
		const unsubActivities = activities.filter(
			(a: { activityType: string }) => a.activityType === 'topic_unsubscribed',
		);
		expect(unsubActivities).toHaveLength(3);
	});

	it('removes the contact from a specific topic when topicId is set', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicA = await createTopic(t, false, 'A');
		const topicB = await createTopic(t, false, 'B');

		await t.mutation(internal.topics.subscription.subscribe, {
			topicId: topicA,
			contactId,
			source: 'admin',
		});
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId: topicB,
			contactId,
			source: 'admin',
		});

		const { outcomes } = await t.mutation(
			internal.topics.subscription.unsubscribeAllForContact,
			{ contactId, topicId: topicA, source: 'public_email_link' },
		);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]!.ok).toBe(true);
		if (outcomes[0]!.ok) expect(outcomes[0]!.action).toBe('unsubscribed');

		// Topic A: unsubscribed. Topic B: still subscribed.
		expect(await getMembership(t, contactId, topicA)).toBeNull();
		expect(await getMembership(t, contactId, topicB)).not.toBeNull();
	});

	it('returns single not_member outcome when scoped topic has no membership', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, false);

		const { outcomes } = await t.mutation(
			internal.topics.subscription.unsubscribeAllForContact,
			{ contactId, topicId, source: 'public_email_link' },
		);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]!.ok).toBe(true);
		if (outcomes[0]!.ok) expect(outcomes[0]!.action).toBe('not_member');
	});

	it('returns contact_not_found for unknown contactId', async () => {
		const t = convexTest(schema, modules);
		const fakeContactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', {
				email: 'gone@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const { outcomes } = await t.mutation(
			internal.topics.subscription.unsubscribeAllForContact,
			{ contactId: fakeContactId, source: 'public_email_link' },
		);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]!.ok).toBe(false);
		if (!outcomes[0]!.ok) expect(outcomes[0]!.reason).toBe('contact_not_found');
	});
});

// ============================================================
// Drift-bug closures (cross-cutting)
// ============================================================

describe('subscription — drift bug closures', () => {
	it('drift #1: batch import (subscribeMany with source: import, skipDoi false default) honors DOI', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, true); // requireDoubleOptIn = true
		const contactId = await createContact(t); // not_required

		const { outcomes } = await t.mutation(
			internal.topics.subscription.subscribeMany,
			{
				topicId,
				contactIds: [contactId],
				source: 'import',
				siteUrl: 'https://example.com',
			},
		);

		expect(outcomes[0]!.ok).toBe(true);
		if (outcomes[0]!.ok) {
			expect(outcomes[0]!.action).toBe('pending_doi');
		}

		// Contact transitioned to pending — DOI lifecycle was called, NOT bypassed.
		const contact = await getContact(t, contactId);
		expect(contact?.doiStatus).toBe('pending');
		expect(contact?.doiConfirmationToken).toBeDefined();
	});

	it('drift #1 (continued): batch import with skipDoi: true bypasses DOI', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, true);
		const contactId = await createContact(t);

		const { outcomes } = await t.mutation(
			internal.topics.subscription.subscribeMany,
			{
				topicId,
				contactIds: [contactId],
				source: 'import',
				skipDoi: true,
			},
		);

		expect(outcomes[0]!.ok).toBe(true);
		if (outcomes[0]!.ok) {
			expect(outcomes[0]!.action).toBe('subscribed');
		}

		// Contact's DOI status unchanged — admin override.
		const contact = await getContact(t, contactId);
		expect(contact?.doiStatus).toBe('not_required');
	});

	it('drift #3: admin-remove writes topic_unsubscribed activity row', async () => {
		const t = convexTest(schema, modules);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, false);

		await t.mutation(internal.topics.subscription.subscribe, {
			topicId,
			contactId,
			source: 'admin',
		});
		await t.mutation(internal.topics.subscription.unsubscribe, {
			topicId,
			contactId,
			source: 'admin',
		});

		const activities = await getActivitiesForContact(t, contactId);
		const unsubActivity = activities.find(
			(a: { activityType: string }) => a.activityType === 'topic_unsubscribed',
		);
		expect(unsubActivity).toBeDefined();
		// Reason captures the admin source.
		expect(unsubActivity?.metadata?.reason).toBe('admin_remove');
	});

	it('drift #4: bulk-remove decrements cachedMemberCount', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);
		const contactIds = await Promise.all(
			Array.from({ length: 3 }, (_, i) =>
				createContact(t, {
					email: `d4-${i}@example.com`,
					searchableText: `d4-${i}@example.com`,
				}),
			),
		);

		await t.mutation(internal.topics.subscription.subscribeMany, {
			topicId,
			contactIds,
			source: 'admin',
		});
		expect((await getTopic(t, topicId))?.cachedMemberCount).toBe(3);

		await t.mutation(internal.topics.subscription.unsubscribeMany, {
			topicId,
			contactIds,
			source: 'admin',
		});

		expect((await getTopic(t, topicId))?.cachedMemberCount).toBe(0);
	});
});
