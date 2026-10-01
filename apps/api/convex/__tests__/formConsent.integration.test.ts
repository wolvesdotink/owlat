/**
 * Integration tests for the consent rule form signups follow (ADR-0009,
 * ADR-0013 and ADR-0015, 2026-10 amendments).
 *
 * Three independent failure scenarios, each driven through the real form
 * intake and confirmation functions:
 *   - a form that collects contacts without a topic honours its DOI toggle;
 *   - one confirmation finalizes every pending signup that shares its token;
 *   - a global opt-out holds until the recipient confirms afresh, whatever
 *     an earlier confirmation said, while trusted sources keep their override.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { classifyAction } from '../forms/submission';
import { DOI_TOKEN_TTL_MS } from '../contacts/doiLifecycle';
import { resolveContact } from '../contacts/resolution';
import { expectScheduledFailure } from './helpers/scheduledFailures';
import { createTestAutomation, createTestAutomationStep } from './factories';

// No MTA runs under test, so the confirmation email's send fails when its job
// fires. These tests check that it was scheduled, not that it was delivered.
beforeEach(() => {
	expectScheduledFailure('confirmationEmail:sendConfirmationEmail');
	vi.stubEnv('SITE_URL', 'https://app.example.com');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

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
			!path.includes('llmProvider')
	)
);

type T = TestConvex<typeof schema>;

function setupTest(): T {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createTopic(t: T, requireDoubleOptIn: boolean, name = 'Newsletter') {
	return await t.run((ctx) =>
		ctx.db.insert('topics', { name, requireDoubleOptIn, createdAt: Date.now() })
	);
}

async function createForm(
	t: T,
	args: { topicId?: Id<'topics'>; doubleOptIn?: boolean; name?: string } = {}
): Promise<Id<'formEndpoints'>> {
	return await t.run((ctx) =>
		ctx.db.insert('formEndpoints', {
			name: args.name ?? 'Signup',
			topicId: args.topicId,
			fields: [{ key: 'email', label: 'Email', type: 'email' as const, required: true }],
			isActive: true,
			doubleOptIn: args.doubleOptIn,
			submissionCount: 0,
			successfulSubmissionCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
}

async function submit(t: T, formEndpointId: Id<'formEndpoints'>, email: string) {
	const outcome = await t.mutation(internal.forms.submission.submit, {
		formEndpointId,
		submissionData: { email },
	});
	if (!outcome.ok) throw new Error(`submit failed: ${outcome.reason}`);
	const row = await t.run((ctx) => ctx.db.get(outcome.submissionId));
	if (!row) throw new Error('submission row missing');
	return { outcome, row };
}

/** Seed through Contact resolution so the form's upsert matches the contact. */
async function seedContact(t: T, email: string, overrides: Record<string, unknown> = {}) {
	return await t.run(async (ctx) => {
		const { contactId } = await resolveContact(ctx, {
			channel: 'email',
			identifier: email,
			source: 'api',
			mode: 'upsert',
		});
		if (Object.keys(overrides).length > 0) await ctx.db.patch(contactId, overrides);
		return contactId;
	});
}

/** A contact that confirmed in an earlier episode, then opted out globally. */
async function seedConfirmedThenOptedOut(t: T, email: string, topicId: Id<'topics'>) {
	const confirmedAt = Date.now() - 60_000;
	const contactId = await seedContact(t, email, {
		doiStatus: 'confirmed',
		doiConfirmedAt: confirmedAt,
	});
	await t.mutation(internal.topics.subscription.subscribe, { topicId, contactId, source: 'admin' });
	await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
		contactId,
		source: 'public_email_link',
	});
	const contact = await t.run((ctx) => ctx.db.get(contactId));
	expect(contact?.unsubscribedAt).toBeTypeOf('number');
	expect(contact?.doiStatus).toBe('confirmed');
	return { contactId, confirmedAt };
}

async function seedTopicAutomation(t: T, topicId: Id<'topics'>) {
	await t.run(async (ctx) => {
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({
				status: 'active',
				triggerType: 'topic_subscribed',
				triggerConfig: { topicId },
			})
		);
		await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({ automationId, stepIndex: 0 })
		);
	});
}

async function automationRunCount(t: T, contactId: Id<'contacts'>) {
	return await t.run(
		async (ctx) =>
			(await ctx.db.query('automationRuns').collect()).filter((r) => r.contactId === contactId)
				.length
	);
}

async function topicConfirmedCount(t: T, contactId: Id<'contacts'>) {
	return await t.run(
		async (ctx) =>
			(
				await ctx.db
					.query('contactActivities')
					.withIndex('by_contact', (q) => q.eq('contactId', contactId))
					.collect()
			).filter((a) => a.activityType === 'topic_confirmed').length
	);
}

async function confirmationEmailsFor(t: T, token: string) {
	return await t.run(
		async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job) =>
					job.name.includes('sendConfirmationEmail') &&
					(job.args[0] as { confirmationToken?: string }).confirmationToken === token
			).length
	);
}

async function getForm(t: T, id: Id<'formEndpoints'>) {
	return await t.run((ctx) => ctx.db.get(id));
}

async function getContact(t: T, id: Id<'contacts'>) {
	return await t.run((ctx) => ctx.db.get(id));
}

// ─── Contacts-only forms honour double opt-in ───────────────────────────────

describe('form DOI policy without a topic', () => {
	it('classifies a requested confirmation on the no-topic path as pending', () => {
		expect(classifyAction('created', undefined, false, true)).toBe('pending_confirmation');
		expect(classifyAction('matched', undefined, false, true)).toBe('pending_confirmation');
		expect(classifyAction('created', undefined, false, false)).toBe('success');
	});

	// Form DOI on/off × topic absent / non-DOI / DOI, for a new address.
	it.each([
		{ formDoi: false, topic: 'none', expected: 'success' },
		{ formDoi: true, topic: 'none', expected: 'pending_confirmation' },
		{ formDoi: false, topic: 'plain', expected: 'success' },
		{ formDoi: true, topic: 'plain', expected: 'pending_confirmation' },
		{ formDoi: false, topic: 'doi', expected: 'pending_confirmation' },
		{ formDoi: true, topic: 'doi', expected: 'pending_confirmation' },
	] as const)(
		'form DOI $formDoi × topic $topic → $expected',
		async ({ formDoi, topic, expected }) => {
			const t = setupTest();
			const topicId = topic === 'none' ? undefined : await createTopic(t, topic === 'doi');
			const formId = await createForm(t, { topicId, doubleOptIn: formDoi });

			const { outcome, row } = await submit(t, formId, 'new@example.com');

			expect(outcome.action).toBe(expected);
			expect(outcome.confirmationRequired).toBe(expected === 'pending_confirmation');
			const contact = await getContact(t, outcome.contactId!);
			if (expected === 'pending_confirmation') {
				expect(contact?.doiStatus).toBe('pending');
				expect(row.confirmationToken).toBe(contact?.doiConfirmationToken);
				expect(await confirmationEmailsFor(t, row.confirmationToken!)).toBe(1);
			} else {
				expect(contact?.doiStatus).toBe('not_required');
				expect(row.confirmationToken).toBeUndefined();
			}
		}
	);

	it('confirming a contacts-only signup finalizes it and counts it once', async () => {
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true });
		const { outcome, row } = await submit(t, formId, 'contacts-only@example.com');
		expect((await getForm(t, formId))?.successfulSubmissionCount).toBe(0);

		const first = await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: row.confirmationToken!,
		});
		expect(first).toEqual({ success: true, alreadyConfirmed: false });
		const second = await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: row.confirmationToken!,
		});
		expect(second).toEqual({ success: true, alreadyConfirmed: true });

		expect((await t.run((ctx) => ctx.db.get(outcome.submissionId)))?.status).toBe('success');
		expect((await getForm(t, formId))?.successfulSubmissionCount).toBe(1);
		expect((await getContact(t, outcome.contactId!))?.doiStatus).toBe('confirmed');
	});

	it('an already-pending contact shares its live token without a second email', async () => {
		const t = setupTest();
		const doiTopic = await createTopic(t, true);
		const topicForm = await createForm(t, { topicId: doiTopic });
		const contactsOnlyForm = await createForm(t, { doubleOptIn: true, name: 'Contacts only' });

		const first = await submit(t, topicForm, 'pending@example.com');
		const second = await submit(t, contactsOnlyForm, 'pending@example.com');

		expect(second.outcome.action).toBe('pending_confirmation');
		expect(second.row.confirmationToken).toBe(first.row.confirmationToken);
		expect(await confirmationEmailsFor(t, first.row.confirmationToken!)).toBe(1);
	});

	it('existing contacts: a confirmed one is a duplicate, a not_required one is asked to confirm', async () => {
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true });
		await seedContact(t, 'confirmed@example.com', {
			doiStatus: 'confirmed',
			doiConfirmedAt: Date.now(),
		});
		await seedContact(t, 'imported@example.com');

		const confirmed = await submit(t, formId, 'confirmed@example.com');
		expect(confirmed.outcome.action).toBe('duplicate');
		expect(confirmed.row.confirmationToken).toBeUndefined();

		const imported = await submit(t, formId, 'imported@example.com');
		expect(imported.outcome.action).toBe('pending_confirmation');
		expect((await getContact(t, imported.outcome.contactId!))?.doiStatus).toBe('pending');
	});

	it('a contacts-only form without DOI keeps an existing contact a duplicate', async () => {
		const t = setupTest();
		const formId = await createForm(t);
		await seedContact(t, 'returning@example.com');

		const { outcome, row } = await submit(t, formId, 'returning@example.com');

		expect(outcome.action).toBe('duplicate');
		expect(row.confirmationToken).toBeUndefined();
	});
});

// ─── One confirmation, many signups ─────────────────────────────────────────

describe('confirmation fanout across signups sharing a token', () => {
	async function twoPendingSignups(t: T) {
		const topicA = await createTopic(t, true, 'News');
		const topicB = await createTopic(t, true, 'Events');
		const formA = await createForm(t, { topicId: topicA, name: 'A' });
		const formB = await createForm(t, { topicId: topicB, name: 'B' });
		const a = await submit(t, formA, 'two@example.com');
		const b = await submit(t, formB, 'two@example.com');
		expect(a.row.status).toBe('pending_confirmation');
		expect(b.row.status).toBe('pending_confirmation');
		expect(b.row.confirmationToken).toBe(a.row.confirmationToken);
		return { formA, formB, a, b, token: a.row.confirmationToken!, contactId: a.outcome.contactId! };
	}

	async function statuses(t: T, ids: Id<'formSubmissions'>[]) {
		return await t.run(async (ctx) =>
			Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.status))
		);
	}

	it('the form-confirm route finalizes both and counts each form once, idempotently', async () => {
		const t = setupTest();
		const { formA, formB, a, b, token } = await twoPendingSignups(t);

		expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token })).toEqual({
			success: true,
			alreadyConfirmed: false,
		});
		expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token })).toEqual({
			success: true,
			alreadyConfirmed: true,
		});

		expect(await statuses(t, [a.outcome.submissionId, b.outcome.submissionId])).toEqual([
			'success',
			'success',
		]);
		expect((await getForm(t, formA))?.successfulSubmissionCount).toBe(1);
		expect((await getForm(t, formB))?.successfulSubmissionCount).toBe(1);
	});

	it('the contact-only /confirm/doi route finalizes them too', async () => {
		const t = setupTest();
		const { formA, formB, a, b, token } = await twoPendingSignups(t);

		const result = await t.mutation(internal.topics.topics.confirmDoi, { token });
		expect(result.success).toBe(true);

		expect(await statuses(t, [a.outcome.submissionId, b.outcome.submissionId])).toEqual([
			'success',
			'success',
		]);
		expect((await getForm(t, formA))?.successfulSubmissionCount).toBe(1);
		expect((await getForm(t, formB))?.successfulSubmissionCount).toBe(1);

		// The form link afterwards reads as already confirmed and counts nothing.
		expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token })).toEqual({
			success: true,
			alreadyConfirmed: true,
		});
		expect((await getForm(t, formA))?.successfulSubmissionCount).toBe(1);
	});

	it('an expired token finalizes nothing', async () => {
		const t = setupTest();
		const { a, b, token, contactId } = await twoPendingSignups(t);
		await t.run((ctx) => ctx.db.patch(contactId, { doiTokenExpiresAt: Date.now() - 1 }));

		const result = await t.mutation(api.forms.endpoints.confirmSubmission, { token });

		expect(result).toEqual({ success: false, error: 'token_expired' });
		expect(await statuses(t, [a.outcome.submissionId, b.outcome.submissionId])).toEqual([
			'pending_confirmation',
			'pending_confirmation',
		]);
	});

	it('pages a large fanout and leaves unrelated rows untouched', async () => {
		vi.useFakeTimers();
		try {
			const t = setupTest();
			const formA = await createForm(t, { name: 'A' });
			const formB = await createForm(t, { name: 'B' });
			const contactId = await seedContact(t, 'many@example.com');
			const strangerId = await seedContact(t, 'stranger@example.com');
			const token = 'shared-token-for-many-signups-000';
			const { strangerRow, invalidRow } = await t.run(async (ctx) => {
				for (let i = 0; i < 130; i++) {
					await ctx.db.insert('formSubmissions', {
						formEndpointId: i % 2 === 0 ? formA : formB,
						contactId,
						data: { email: 'many@example.com' },
						status: 'pending_confirmation',
						confirmationToken: token,
						submittedAt: Date.now(),
					});
				}
				return {
					strangerRow: await ctx.db.insert('formSubmissions', {
						formEndpointId: formA,
						contactId: strangerId,
						data: { email: 'stranger@example.com' },
						status: 'pending_confirmation',
						confirmationToken: token,
						submittedAt: Date.now(),
					}),
					invalidRow: await ctx.db.insert('formSubmissions', {
						formEndpointId: formA,
						contactId,
						data: { email: 'many@example.com' },
						status: 'invalid',
						confirmationToken: token,
						submittedAt: Date.now(),
					}),
				};
			});

			const first = await t.mutation(internal.forms.submission.markConfirmedByToken, {
				token,
				contactId,
			});
			expect(first.ok && first.continued).toBe(true);
			await t.finishAllScheduledFunctions(vi.runAllTimers);

			const rows = await t.run((ctx) => ctx.db.query('formSubmissions').collect());
			const mine = rows.filter((r) => r.contactId === contactId && r._id !== invalidRow);
			expect(mine.every((r) => r.status === 'success')).toBe(true);
			expect(rows.find((r) => r._id === strangerRow)?.status).toBe('pending_confirmation');
			expect(rows.find((r) => r._id === invalidRow)?.status).toBe('invalid');
			expect((await getForm(t, formA))?.successfulSubmissionCount).toBe(65);
			expect((await getForm(t, formB))?.successfulSubmissionCount).toBe(65);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── A global opt-out holds until a fresh confirmation ──────────────────────

describe('form signups after a global opt-out', () => {
	// The three ways a form reaches DOI: the topic requires it, the form forces
	// it, or neither (the opt-out alone does).
	it.each([
		{ variant: 'topic DOI', topicDoi: true, formDoi: false },
		{ variant: 'form-forced DOI', topicDoi: false, formDoi: true },
		{ variant: 'no DOI configured', topicDoi: false, formDoi: false },
	])(
		'$variant: waits for a fresh confirmation, which lifts the opt-out once',
		async ({ topicDoi, formDoi }) => {
			const t = setupTest();
			const topicId = await createTopic(t, topicDoi);
			const formId = await createForm(t, { topicId, doubleOptIn: formDoi });
			const { contactId, confirmedAt } = await seedConfirmedThenOptedOut(
				t,
				'returning@example.com',
				topicId
			);
			await seedTopicAutomation(t, topicId);
			const runsBefore = await automationRunCount(t, contactId);

			const { outcome, row } = await submit(t, formId, 'returning@example.com');

			expect(outcome.action).toBe('pending_confirmation');
			const pending = await getContact(t, contactId);
			expect(pending?.unsubscribedAt).toBeTypeOf('number');
			expect(pending?.doiStatus).toBe('pending');
			// The earlier confirmation stays on the record until a new one lands.
			expect(pending?.doiConfirmedAt).toBe(confirmedAt);
			expect(row.confirmationToken).toBe(pending?.doiConfirmationToken);
			expect(await confirmationEmailsFor(t, row.confirmationToken!)).toBe(1);
			expect(await automationRunCount(t, contactId)).toBe(runsBefore);
			const audit = await t.run(async (ctx) =>
				(await ctx.db.query('auditLogs').collect()).find(
					(l) => l.action === 'doi.reconfirmation_requested' && l.resourceId === contactId
				)
			);
			expect(audit?.details).toMatchObject({ previousConfirmedAt: confirmedAt });

			const token = row.confirmationToken!;
			expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token })).toEqual({
				success: true,
				alreadyConfirmed: false,
			});
			await t.mutation(api.forms.endpoints.confirmSubmission, { token });

			const confirmed = await getContact(t, contactId);
			expect(confirmed?.unsubscribedAt).toBeUndefined();
			expect(confirmed?.doiStatus).toBe('confirmed');
			expect(await automationRunCount(t, contactId)).toBe(runsBefore + 1);
			expect(await topicConfirmedCount(t, contactId)).toBe(1);
			expect((await getForm(t, formId))?.successfulSubmissionCount).toBe(1);
		}
	);

	it('a contacts-only form also waits for a fresh confirmation', async () => {
		const t = setupTest();
		const topicId = await createTopic(t, false);
		const formId = await createForm(t);
		const { contactId } = await seedConfirmedThenOptedOut(t, 'back@example.com', topicId);

		const { outcome, row } = await submit(t, formId, 'back@example.com');

		expect(outcome.action).toBe('pending_confirmation');
		expect((await getContact(t, contactId))?.unsubscribedAt).toBeTypeOf('number');

		await t.mutation(api.forms.endpoints.confirmSubmission, { token: row.confirmationToken! });
		expect((await getContact(t, contactId))?.unsubscribedAt).toBeUndefined();
	});

	it('a confirmation link minted before a later opt-out no longer works', async () => {
		const t = setupTest();
		const topicId = await createTopic(t, true);
		const formId = await createForm(t, { topicId });
		const { contactId } = await seedConfirmedThenOptedOut(t, 'twice@example.com', topicId);
		await seedTopicAutomation(t, topicId);

		const firstSignup = await submit(t, formId, 'twice@example.com');
		const staleToken = firstSignup.row.confirmationToken!;
		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId,
			source: 'public_email_link',
		});
		const runsBefore = await automationRunCount(t, contactId);

		expect(await t.query(api.forms.endpoints.getByConfirmationToken, { token: staleToken })).toBe(
			null
		);
		expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token: staleToken })).toEqual({
			success: false,
			error: 'invalid_token',
		});
		expect(
			(await t.mutation(internal.topics.topics.confirmDoi, { token: staleToken })).success
		).toBe(false);
		const stillOut = await getContact(t, contactId);
		expect(stillOut?.unsubscribedAt).toBeTypeOf('number');
		expect(stillOut?.doiConfirmationToken).toBeUndefined();
		expect(await automationRunCount(t, contactId)).toBe(runsBefore);

		// A new signup starts a new episode with a fresh link, which works once.
		const secondSignup = await submit(t, formId, 'twice@example.com');
		const freshToken = secondSignup.row.confirmationToken!;
		expect(freshToken).not.toBe(staleToken);
		expect(await confirmationEmailsFor(t, freshToken)).toBe(1);
		await t.mutation(api.forms.endpoints.confirmSubmission, { token: freshToken });

		expect((await getContact(t, contactId))?.unsubscribedAt).toBeUndefined();
		expect(await automationRunCount(t, contactId)).toBe(runsBefore + 1);
		expect(await topicConfirmedCount(t, contactId)).toBe(1);
		expect((await t.run((ctx) => ctx.db.get(firstSignup.outcome.submissionId)))?.status).toBe(
			'pending_confirmation'
		);
	});

	it('the preference centre (a recipient-held link) still lifts the opt-out at once', async () => {
		const t = setupTest();
		const topicId = await createTopic(t, true);
		const { contactId } = await seedConfirmedThenOptedOut(t, 'prefs@example.com', topicId);

		await t.mutation(internal.delivery.preferencesQueries.updateContactPreferences, {
			contactId,
			topicUpdates: [{ topicId, subscribed: true }],
		});

		const contact = await getContact(t, contactId);
		expect(contact?.unsubscribedAt).toBeUndefined();
		expect(contact?.doiStatus).toBe('confirmed');
	});

	it.each([{ source: 'admin' as const }, { source: 'import' as const }])(
		'a trusted $source subscribe keeps its override',
		async ({ source }) => {
			const t = setupTest();
			const topicId = await createTopic(t, false);
			const { contactId } = await seedConfirmedThenOptedOut(t, 'override@example.com', topicId);

			const { outcomes } = await t.mutation(internal.topics.subscription.subscribeMany, {
				topicId,
				contactIds: [contactId],
				source,
			});

			expect(outcomes[0]).toMatchObject({ ok: true, action: 'subscribed' });
			expect((await getContact(t, contactId))?.unsubscribedAt).toBeUndefined();
		}
	);
});

// ─── A finished signup's history survives an unsubscribe (#1062) ───────────

describe('a confirmed signup after the contact unsubscribes', () => {
	it.each([
		{ source: 'public_email_link' as const, global: true },
		{ source: 'preferences_page' as const, global: false },
	])(
		'$source: keeps confirmedAt, so the confirm page still reads as already confirmed',
		async ({ source, global }) => {
			const t = setupTest();
			const topicId = await createTopic(t, true);
			const formId = await createForm(t, { topicId });
			const { outcome, row } = await submit(t, formId, 'history@example.com');
			const token = row.confirmationToken!;
			await t.mutation(api.forms.endpoints.confirmSubmission, { token });
			const confirmedAt = (await t.run((ctx) => ctx.db.get(outcome.submissionId)))?.confirmedAt;
			expect(confirmedAt).toBeTypeOf('number');

			await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
				contactId: outcome.contactId!,
				source,
				...(global ? {} : { topicIds: [topicId] }),
			});

			expect((await t.run((ctx) => ctx.db.get(outcome.submissionId)))?.confirmedAt).toBe(
				confirmedAt
			);
			// confirm.vue shows "already confirmed" for `status: 'success'` with
			// `confirmedAt` set.
			expect(await t.query(api.forms.endpoints.getByConfirmationToken, { token })).toMatchObject({
				status: 'success',
				confirmedAt,
			});
			expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token })).toEqual({
				success: true,
				alreadyConfirmed: true,
			});
		}
	);
});

// ─── DOI lifecycle: consent-episode edges ───────────────────────────────────

describe('DOI lifecycle consent episodes', () => {
	it('refuses to reopen a confirmed contact that holds no opt-out', async () => {
		const t = setupTest();
		const contactId = await seedContact(t, 'steady@example.com', {
			doiStatus: 'confirmed',
			doiConfirmedAt: Date.now(),
		});

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: Date.now(),
				token: 'reopen-without-opt-out',
				ttlMs: DOI_TOKEN_TTL_MS,
				reopen: true,
			},
		});

		expect(outcome).toMatchObject({ ok: false, reason: 'terminal' });
		expect((await getContact(t, contactId))?.doiStatus).toBe('confirmed');
	});

	it('mints a fresh token for a pending contact whose token lapsed', async () => {
		const t = setupTest();
		const contactId = await seedContact(t, 'lapsed@example.com', {
			doiStatus: 'pending',
			doiConfirmationToken: 'lapsed-token',
			doiTokenExpiresAt: Date.now() - 1,
		});

		const outcome = await t.mutation(internal.contacts.doiLifecycle.transition, {
			contactId,
			input: {
				to: 'pending',
				at: Date.now(),
				token: 'fresh-token',
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: 'https://app.example.com',
			},
		});

		expect(outcome).toMatchObject({ ok: true, applied: 'transitioned' });
		expect((await getContact(t, contactId))?.doiConfirmationToken).toBe('fresh-token');
		expect(await confirmationEmailsFor(t, 'fresh-token')).toBe(1);
	});

	it('endConsentEpisode clears the token, keeps the status and moves the episode on', async () => {
		const t = setupTest();
		const contactId = await seedContact(t, 'withdraw@example.com', {
			doiStatus: 'pending',
			doiConfirmationToken: 'to-withdraw',
			doiTokenExpiresAt: Date.now() + DOI_TOKEN_TTL_MS,
		});

		expect(
			await t.mutation(internal.contacts.doiLifecycle.endConsentEpisode, {
				contactId,
				at: Date.now(),
			})
		).toEqual({ withdrawn: true });

		const contact = await getContact(t, contactId);
		expect(contact?.doiStatus).toBe('pending');
		expect(contact?.doiConfirmationToken).toBeUndefined();
		expect(contact?.doiTokenExpiresAt).toBeUndefined();
		expect(contact?.doiConsentEpisode).toBe(1);

		// Without a token to withdraw, the episode still moves on.
		expect(
			await t.mutation(internal.contacts.doiLifecycle.endConsentEpisode, {
				contactId,
				at: Date.now(),
			})
		).toEqual({ withdrawn: false });
		expect((await getContact(t, contactId))?.doiConsentEpisode).toBe(2);
	});
});
