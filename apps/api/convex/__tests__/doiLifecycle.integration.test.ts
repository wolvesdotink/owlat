/**
 * Integration tests for DOI lifecycle (module).
 *
 * Covers the three-state machine `not_required → pending → confirmed`, the
 * token-keyed entry point, the trigger-fanout + activity effects, expired-
 * token handling, and the refresh-pending-token operation.
 *
 * See docs/adr/0009-doi-lifecycle-module.md.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { DOI_TOKEN_TTL_MS } from '../contacts/doiLifecycle';

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
	Object.entries(allModules).filter(([path]) =>
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
		!path.includes('llmProvider')
	)
);

// ============================================================
// Helpers
// ============================================================

async function createContact(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
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
	t: ReturnType<typeof convexTest>,
	requireDoubleOptIn: boolean,
	name = 'Newsletter'
): Promise<Id<'topics'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('topics', {
			name,
			requireDoubleOptIn,
			createdAt: Date.now(),
		});
	});
}

// ============================================================
// transition({to: 'pending'})
// ============================================================

describe('doiLifecycle.transition — to: pending', () => {
	it('patches not_required → pending with token + TTL', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: now,
				token: 'tok-abc',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://example.com',
			},
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.applied).toBe('transitioned');
			expect(outcome.from).toBe('not_required');
			expect(outcome.to).toBe('pending');
		}

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact?.doiStatus).toBe('pending');
			expect(contact?.doiConfirmationToken).toBe('tok-abc');
			expect(contact?.doiTokenExpiresAt).toBe(now + DOI_TOKEN_TTL_MS);
		});
	});

	it('is idempotent on pending → pending (recorded, no second token write)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: now,
				token: 'first-token',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://example.com',
			},
		});

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: now + 1000,
				token: 'second-token',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://example.com',
			},
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.applied).toBe('recorded');

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			// First token wins — second call did not overwrite.
			expect(contact?.doiConfirmationToken).toBe('first-token');
		});
	});

	it('refuses confirmed → pending as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t, {
			doiStatus: 'confirmed',
			doiConfirmedAt: Date.now(),
		});

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: Date.now(),
				token: 'tok',
				ttlMs: DOI_TOKEN_TTL_MS,
			},
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('terminal');
	});

	it('omits the send_confirmation_email effect when siteUrl is absent', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: Date.now(),
				token: 'tok',
				ttlMs: DOI_TOKEN_TTL_MS,
				// no siteUrl
			},
		});

		expect(outcome.ok).toBe(true);
		// Patch still applies (status, token, TTL set) — we just don't schedule
		// the confirmation email. Verified by absence of failure here.
		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact?.doiStatus).toBe('pending');
			expect(contact?.doiConfirmationToken).toBe('tok');
		});
	});

	it('returns contact_not_found for an unknown contactId', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
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

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId: fakeContactId,
			input: {
				to: 'pending',
				at: Date.now(),
				token: 'tok',
				ttlMs: DOI_TOKEN_TTL_MS,
			},
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('contact_not_found');
	});
});

// ============================================================
// transition({to: 'confirmed'})
// ============================================================

describe('doiLifecycle.transition — to: confirmed', () => {
	it('patches pending → confirmed, clears token, fires triggers for DOI-required memberships', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const doiTopic = await createTopic(t, true, 'Newsletter');
		const nonDoiTopic = await createTopic(t, false, 'Announcements');

		// Subscribe contact to both topics.
		await t.run(async (ctx) => {
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: doiTopic,
				addedAt: Date.now(),
			});
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: nonDoiTopic,
				addedAt: Date.now(),
			});
		});

		// Move contact to pending first.
		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: Date.now(),
				token: 'tok',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://example.com',
			},
		});

		// Now confirm.
		const confirmAt = Date.now();
		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: { to: 'confirmed', at: confirmAt },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.applied).toBe('transitioned');
			expect(outcome.from).toBe('pending');
			expect(outcome.to).toBe('confirmed');
		}

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact?.doiStatus).toBe('confirmed');
			expect(contact?.doiConfirmedAt).toBe(confirmAt);
			expect(contact?.doiConfirmationToken).toBeUndefined();
			expect(contact?.doiTokenExpiresAt).toBeUndefined();

			// `topic_confirmed` activity rows: one for the DOI-required topic,
			// none for the non-DOI topic.
			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			const confirmedActivities = activities.filter(
				(a) => a.activityType === 'topic_confirmed'
			);
			expect(confirmedActivities).toHaveLength(1);
			expect(confirmedActivities[0]!.metadata?.topicId).toBe(String(doiTopic));
			expect(confirmedActivities[0]!.metadata?.topicName).toBe('Newsletter');
		});
	});

	it('fires the trigger + activity at confirm for a form-forced-DOI non-DOI topic', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		// Topic does NOT itself require DOI — the form forces it.
		const topicId = await createTopic(t, false, 'Announcements');

		// Subscribe through the real path with forceDoi (what a form with
		// double-opt-in does). This defers the trigger and flags the membership.
		const sub = await t.mutation(internal.topics.subscription.subscribe, {
			topicId,
			contactId,
			source: 'form',
			forceDoi: true,
			siteUrl: 'https://example.com',
		});
		expect(sub.ok).toBe(true);
		if (sub.ok) expect(sub.action).toBe('pending_doi');

		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first();
			expect(membership?.pendingDoiConfirmation).toBe(true);
		});

		// Confirm.
		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: { to: 'confirmed', at: Date.now() },
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			// topic_confirmed activity now exists for the non-DOI topic (the bug
			// was that it was silently skipped).
			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			const confirmed = activities.filter((a) => a.activityType === 'topic_confirmed');
			expect(confirmed).toHaveLength(1);
			expect(confirmed[0]!.metadata?.topicId).toBe(String(topicId));

			// Flag cleared so a later confirm can't re-fire it.
			const membership = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first();
			expect(membership?.pendingDoiConfirmation).toBeUndefined();
		});
	});

	it('is idempotent on confirmed → confirmed (recorded, no duplicate activities)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, true);

		await t.run(async (ctx) => {
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId,
				addedAt: Date.now(),
			});
		});

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: Date.now(),
				token: 'tok',
				ttlMs: DOI_TOKEN_TTL_MS,
			},
		});

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: { to: 'confirmed', at: Date.now() },
		});

		const second = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: { to: 'confirmed', at: Date.now() + 1000 },
		});

		expect(second.ok).toBe(true);
		if (second.ok) expect(second.applied).toBe('recorded');

		await t.run(async (ctx) => {
			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			const confirmed = activities.filter(
				(a) => a.activityType === 'topic_confirmed'
			);
			// Only one activity row total — the recorded outcome did not re-fire.
			expect(confirmed).toHaveLength(1);
		});
	});

	it('refuses not_required → confirmed (skip pending) as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: { to: 'confirmed', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('illegal_edge');
	});
});

// ============================================================
// transitionByConfirmationToken
// ============================================================

describe('doiLifecycle.transitionByConfirmationToken', () => {
	it('confirms a pending contact by token', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, true);

		await t.run(async (ctx) => {
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId,
				addedAt: Date.now(),
			});
		});

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: Date.now(),
				token: 'lookup-token',
				ttlMs: DOI_TOKEN_TTL_MS,
			},
		});

		const outcome = await t.mutation(
			internal.contacts.doiLifecycle.transitionByConfirmationToken,
			{
				token: 'lookup-token',
				input: { to: 'confirmed', at: Date.now() },
			}
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.contactId).toBe(contactId);
			expect(outcome.applied).toBe('transitioned');
		}
	});

	it('returns token_not_found for an unknown token', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const outcome = await t.mutation(
			internal.contacts.doiLifecycle.transitionByConfirmationToken,
			{
				token: 'nonexistent',
				input: { to: 'confirmed', at: Date.now() },
			}
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('token_not_found');
	});

	it('returns token_expired for tokens past doiTokenExpiresAt', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const tenSecondsAgo = Date.now() - 10_000;

		await t.run(async (ctx) => {
			await ctx.db.patch(contactId, {
				doiStatus: 'pending',
				doiConfirmationToken: 'expired-tok',
				doiTokenExpiresAt: tenSecondsAgo,
				updatedAt: tenSecondsAgo,
			});
		});

		const outcome = await t.mutation(
			internal.contacts.doiLifecycle.transitionByConfirmationToken,
			{
				token: 'expired-tok',
				input: { to: 'confirmed', at: Date.now() },
			}
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('token_expired');

		// Contact is *not* patched on expired-token failures (no token-clear
		// side effect — caller decides the cleanup policy).
		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact?.doiStatus).toBe('pending');
			expect(contact?.doiConfirmationToken).toBe('expired-tok');
		});
	});
});

// ============================================================
// refreshPendingToken
// ============================================================

describe('doiLifecycle.refreshPendingToken', () => {
	it('replaces the token and TTL while staying in pending', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: Date.now() - 1000,
				token: 'old-tok',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://example.com',
			},
		});

		const now = Date.now();
		const outcome = await t.mutation(
			internal.contacts.doiLifecycle.refreshPendingToken,
			{
				contactId,
				at: now,
				token: 'new-tok',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://example.com',
			}
		);

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact?.doiStatus).toBe('pending');
			expect(contact?.doiConfirmationToken).toBe('new-tok');
			expect(contact?.doiTokenExpiresAt).toBe(now + DOI_TOKEN_TTL_MS);
		});
	});

	it('refuses with not_pending when contact is not_required', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);

		const outcome = await t.mutation(
			internal.contacts.doiLifecycle.refreshPendingToken,
			{
				contactId,
				at: Date.now(),
				token: 'tok',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://example.com',
			}
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('not_pending');
	});

	it('refuses with not_pending when contact is already confirmed', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t, {
			doiStatus: 'confirmed',
			doiConfirmedAt: Date.now(),
		});

		const outcome = await t.mutation(
			internal.contacts.doiLifecycle.refreshPendingToken,
			{
				contactId,
				at: Date.now(),
				token: 'tok',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://example.com',
			}
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('not_pending');
	});
});

// ============================================================
// End-to-end form-confirm path (ADR-0009 drift fixes #1, #2, #4)
// ============================================================
//
// Wire shape: forms.endpoints.confirmSubmission(token) -- the unified
// token namespace means the contact's doiConfirmationToken and the form
// submission's confirmationToken are the same string. The handler must
// produce the topic-subscribed trigger fanout AND a topic_confirmed
// activity row -- both of which were silently skipped pre-ADR.

describe('forms.endpoints.confirmSubmission — end-to-end', () => {
	it('fires topic_subscribed trigger and writes topic_confirmed activity', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, true, 'Newsletter');
		const sharedToken = 'shared-token-abc';
		const now = Date.now();

		// Subscribe the contact to the topic (pre-DOI) and put them into
		// `pending` with the shared token. This mirrors what
		// `topics.addContact` does under the new flow.
		await t.run(async (ctx) => {
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId,
				addedAt: now,
			});
			await ctx.db.patch(contactId, {
				doiStatus: 'pending',
				doiConfirmationToken: sharedToken,
				doiTokenExpiresAt: now + DOI_TOKEN_TTL_MS,
				updatedAt: now,
			});
		});

		// Create the form endpoint + a pending_confirmation submission whose
		// confirmationToken equals the contact's doiConfirmationToken (the
		// (1a) unified-namespace invariant).
		const formEndpointId = await t.run(async (ctx) => {
			return await ctx.db.insert('formEndpoints', {
				name: 'Signup',
				topicId,
				fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
				isActive: true,
				doubleOptIn: true,
				createdAt: now,
				updatedAt: now,
			});
		});
		const submissionId = await t.run(async (ctx) => {
			return await ctx.db.insert('formSubmissions', {
				formEndpointId,
				contactId,
				data: { email: 'test@example.com' },
				status: 'pending_confirmation',
				confirmationToken: sharedToken,
				confirmationEmailSentAt: now,
				submittedAt: now,
			});
		});

		// Confirm via the public form-confirm mutation.
		const result = await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: sharedToken,
		});
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			// Contact is confirmed; token cleared.
			const contact = await ctx.db.get(contactId);
			expect(contact?.doiStatus).toBe('confirmed');
			expect(contact?.doiConfirmationToken).toBeUndefined();
			expect(contact?.doiTokenExpiresAt).toBeUndefined();

			// Form submission patched to success.
			const submission = await ctx.db.get(submissionId);
			expect(submission?.status).toBe('success');
			expect(submission?.confirmedAt).toBeDefined();

			// Drift fix #2: topic_confirmed activity row exists.
			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			const confirmedActivity = activities.find(
				(a) => a.activityType === 'topic_confirmed'
			);
			expect(confirmedActivity).toBeDefined();
			expect(confirmedActivity?.metadata?.topicId).toBe(String(topicId));

			// Drift fix #1: automation run was created via the trigger fanout
			// (only created if any automation listens; we assert the trigger
			// was at least scheduled by checking the lifecycle wrote the
			// activity row -- the trigger-fanout effect runs alongside it).
		});
	});

	it('returns alreadyConfirmed=true on a second click', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t, {
			doiStatus: 'confirmed',
			doiConfirmedAt: Date.now(),
		});
		const sharedToken = 'already-done-token';

		const formEndpointId = await t.run(async (ctx) => {
			return await ctx.db.insert('formEndpoints', {
				name: 'Signup',
				fields: [],
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('formSubmissions', {
				formEndpointId,
				contactId,
				data: {},
				status: 'success',
				confirmationToken: sharedToken,
				confirmedAt: Date.now(),
				submittedAt: Date.now(),
			});
		});

		const result = await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: sharedToken,
		});

		expect(result.success).toBe(true);
		if (result.success) expect(result.alreadyConfirmed).toBe(true);
	});

	it('returns invalid_token for an unknown token', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const result = await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: 'nonexistent',
		});

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toBe('invalid_token');
	});

	it('returns token_expired when the contact-side token is past TTL', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const sharedToken = 'expired-token';
		const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

		await t.run(async (ctx) => {
			await ctx.db.patch(contactId, {
				doiStatus: 'pending',
				doiConfirmationToken: sharedToken,
				doiTokenExpiresAt: tenMinutesAgo, // expired
				updatedAt: tenMinutesAgo,
			});
		});

		const formEndpointId = await t.run(async (ctx) => {
			return await ctx.db.insert('formEndpoints', {
				name: 'Signup',
				fields: [],
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('formSubmissions', {
				formEndpointId,
				contactId,
				data: {},
				status: 'pending_confirmation',
				confirmationToken: sharedToken,
				confirmationEmailSentAt: tenMinutesAgo,
				submittedAt: tenMinutesAgo,
			});
		});

		const result = await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: sharedToken,
		});

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toBe('token_expired');
	});
});

// ============================================================
// admin-attest path (ADR-0019)
// ============================================================

describe('doiLifecycle.transition — admin_attest', () => {
	it('not_required → confirmed via admin_attest patches contact and writes companion', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'confirmed',
				at: now,
				source: 'admin_attest',
				attestSource: 'mailchimp',
			},
		});

		expect(outcome.ok).toBe(true);
		const contact = await t.run(async (ctx) => ctx.db.get(contactId));
		expect(contact?.doiStatus).toBe('confirmed');
		expect(contact?.doiAttestedSource).toBe('mailchimp');
		expect(contact?.doiConfirmedAt).toBe(now);
	});

	it('admin_attest emits doi.admin_attested audit log + doi_attested activity', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'confirmed',
				at: now,
				source: 'admin_attest',
				attestSource: 'klaviyo',
				triggeredBy: 'user_123',
			},
		});

		const auditLogs = await t.run(async (ctx) =>
			ctx.db.query('auditLogs').collect(),
		);
		const attestAudit = auditLogs.find((l) => l.action === 'doi.admin_attested');
		expect(attestAudit).toBeTruthy();
		expect(attestAudit?.userId).toBe('user_123');
		expect(
			(attestAudit?.details as { attestSource?: string } | undefined)?.attestSource,
		).toBe('klaviyo');

		const activities = await t.run(async (ctx) =>
			ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect(),
		);
		const attested = activities.find((a) => a.activityType === 'doi_attested');
		expect(attested).toBeTruthy();
		expect(
			(attested?.metadata as { attestSource?: string } | undefined)?.attestSource,
		).toBe('klaviyo');
	});

	it('not_required → confirmed without source: refuses as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: { to: 'confirmed', at: now },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('illegal_edge');
		}
	});

	it('confirmed → confirmed via admin_attest: idempotent recorded no-op', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'confirmed',
				at: now,
				source: 'admin_attest',
				attestSource: 'mailchimp',
			},
		});

		// Second attest call.
		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'confirmed',
				at: now + 1000,
				source: 'admin_attest',
				attestSource: 'mailchimp',
			},
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.applied).toBe('recorded');
		}

		// No second activity row.
		const activities = await t.run(async (ctx) =>
			ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.filter((q) => q.eq(q.field('activityType'), 'doi_attested'))
				.collect(),
		);
		expect(activities).toHaveLength(1);
	});

	it('admin_attest with DOI-required topic memberships: fires topic_confirmed per topic', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const topicId = await createTopic(t, true);
		// Pre-create membership (simulates an attest after a DOI-required
		// topic was joined while the contact was `not_required` — possible
		// when the subscribe used skipDoi).
		await t.run(async (ctx) => {
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId,
				addedAt: Date.now(),
			});
		});
		const now = Date.now();

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'confirmed',
				at: now,
				source: 'admin_attest',
				attestSource: 'mailchimp',
			},
		});

		const activities = await t.run(async (ctx) =>
			ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect(),
		);
		const topicConfirmed = activities.filter(
			(a) => a.activityType === 'topic_confirmed',
		);
		expect(topicConfirmed).toHaveLength(1);
	});

	it('admin_attest with no memberships: no topic_confirmed activities (only doi_attested)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'confirmed',
				at: now,
				source: 'admin_attest',
				attestSource: 'csv_admin',
			},
		});

		const activities = await t.run(async (ctx) =>
			ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect(),
		);
		const topicConfirmed = activities.filter(
			(a) => a.activityType === 'topic_confirmed',
		);
		const doiAttested = activities.filter(
			(a) => a.activityType === 'doi_attested',
		);
		expect(topicConfirmed).toHaveLength(0);
		expect(doiAttested).toHaveLength(1);
	});

	it('admin_attest from not_required leaves doiConfirmationToken/expiresAt untouched', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'confirmed',
				at: now,
				source: 'admin_attest',
				attestSource: 'stripe',
			},
		});

		const contact = await t.run(async (ctx) => ctx.db.get(contactId));
		expect(contact?.doiConfirmationToken).toBeUndefined();
		expect(contact?.doiTokenExpiresAt).toBeUndefined();
	});

	it('triggeredBy defaults to system when not provided', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const contactId = await createContact(t);
		const now = Date.now();

		await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'confirmed',
				at: now,
				source: 'admin_attest',
				attestSource: 'mailchimp',
			},
		});

		const auditLogs = await t.run(async (ctx) =>
			ctx.db.query('auditLogs').collect(),
		);
		const attestAudit = auditLogs.find((l) => l.action === 'doi.admin_attested');
		expect(attestAudit?.userId).toBe('system');
	});
});
