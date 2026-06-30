/**
 * Integration tests for Form submission (module).
 *
 * Covers the two entry points (submit / markConfirmedByToken), the
 * five action classifications, and the drift-bug closures named in
 * docs/adr/0015-form-submission-module.md — especially the
 * existing-contact-joins-new-topic regression that the pre-deepening
 * path silently dropped.
 *
 * Pure unit tests for the `classifyAction` and `validateFields` helpers
 * live at the top.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { classifyAction, validateFields } from '../forms/submission';

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

// ─── Pure unit tests ────────────────────────────────────────────────────────

describe('classifyAction (pure)', () => {
	it("created + no topic → 'success'", () => {
		expect(classifyAction('created', undefined)).toBe('success');
	});

	it("matched + no topic → 'duplicate'", () => {
		expect(classifyAction('matched', undefined)).toBe('duplicate');
	});

	it("updated + no topic → 'duplicate'", () => {
		expect(classifyAction('updated', undefined)).toBe('duplicate');
	});

	it("topic expected but subscribe failed → 'invalid' (not 'success')", () => {
		// subscribeResult is undefined on a failed subscribe; topicExpected
		// distinguishes that from the no-topic path so a failed signup is not
		// recorded as a successful submission.
		expect(classifyAction('created', undefined, true)).toBe('invalid');
		expect(classifyAction('matched', undefined, true)).toBe('invalid');
	});

	it("created + subscribe 'subscribed' → 'success'", () => {
		expect(
			classifyAction('created', {
				ok: true,
				action: 'subscribed',
				membershipId: 'fake' as Id<'contactTopics'>,
			}),
		).toBe('success');
	});

	it("created + subscribe 'pending_doi' → 'pending_confirmation'", () => {
		expect(
			classifyAction('created', {
				ok: true,
				action: 'pending_doi',
				membershipId: 'fake' as Id<'contactTopics'>,
				doiToken: 'tok',
			}),
		).toBe('pending_confirmation');
	});

	it("matched + subscribe 'already_member' → 'duplicate'", () => {
		expect(
			classifyAction('matched', {
				ok: true,
				action: 'already_member',
				membershipId: 'fake' as Id<'contactTopics'>,
			}),
		).toBe('duplicate');
	});

	it("matched + subscribe 'subscribed' → 'success' (existing contact joins new topic)", () => {
		// The regression bug: pre-deepening this case wrote `duplicate` and
		// silently dropped the membership. Under the module, an existing
		// contact joining a new topic classifies as `success`.
		expect(
			classifyAction('matched', {
				ok: true,
				action: 'subscribed',
				membershipId: 'fake' as Id<'contactTopics'>,
			}),
		).toBe('success');
	});

	it("matched + subscribe 'pending_doi' → 'pending_confirmation'", () => {
		expect(
			classifyAction('matched', {
				ok: true,
				action: 'pending_doi',
				membershipId: 'fake' as Id<'contactTopics'>,
				doiToken: 'tok',
			}),
		).toBe('pending_confirmation');
	});
});

describe('validateFields (pure)', () => {
	const emailField = {
		key: 'email',
		label: 'Email',
		type: 'email' as const,
		required: true,
	};

	it('extracts a valid email lowercased and trimmed', () => {
		const result = validateFields([emailField], { email: '  USER@Example.COM  ' });
		expect(result.email).toBe('user@example.com');
		expect(result.errors).toEqual([]);
	});

	it('reports an error when required email is missing', () => {
		const result = validateFields([emailField], {});
		expect(result.email).toBeNull();
		expect(result.errors).toContain('Email is required');
	});

	it('reports an error when email format is invalid', () => {
		const result = validateFields([emailField], { email: 'not-an-email' });
		expect(result.email).toBeNull();
		expect(result.errors).toContain('Email must be a valid email address');
	});

	it('reports an error for required non-email field that is empty', () => {
		const result = validateFields(
			[
				emailField,
				{ key: 'name', label: 'Name', type: 'text', required: true },
			],
			{ email: 'user@example.com', name: '' },
		);
		expect(result.errors).toContain('Name is required');
	});

	it('falls back to "Email is required" if no email field accepted a value', () => {
		const result = validateFields(
			[{ key: 'name', label: 'Name', type: 'text', required: true }],
			{ name: 'Ada' },
		);
		expect(result.email).toBeNull();
		expect(result.errors).toContain('Email is required');
	});
});

// ─── Integration test helpers ───────────────────────────────────────────────

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

async function createForm(
	t: TestConvex<typeof schema>,
	args: {
		topicId?: Id<'topics'>;
		honeypotFieldName?: string;
		isActive?: boolean;
		redirectUrl?: string;
		fields?: Array<{
			key: string;
			label: string;
			type: 'email' | 'text' | 'checkbox';
			required: boolean;
		}>;
	} = {},
): Promise<Id<'formEndpoints'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('formEndpoints', {
			name: 'Test form',
			topicId: args.topicId,
			fields: args.fields ?? [
				{
					key: 'email',
					label: 'Email',
					type: 'email' as const,
					required: true,
				},
			],
			honeypotFieldName: args.honeypotFieldName,
			isActive: args.isActive ?? true,
			redirectUrl: args.redirectUrl,
			submissionCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function getSubmission(
	t: TestConvex<typeof schema>,
	submissionId: Id<'formSubmissions'>,
) {
	return await t.run(async (ctx) => await ctx.db.get(submissionId));
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

async function getContactByEmail(t: TestConvex<typeof schema>, email: string) {
	return await t.run(async (ctx) => {
		return await ctx.db
			.query('contacts')
			.withIndex('by_email', (q) => q.eq('email', email))
			.first();
	});
}

// ─── submit ─────────────────────────────────────────────────────────────────

describe('submission.submit', () => {
	it("writes 'spam' and skips contact resolution when honeypot is set", async () => {
		const t = convexTest(schema, modules);
		const formEndpointId = await createForm(t, {
			honeypotFieldName: 'website',
		});

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'user@example.com', website: 'spam' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('spam');
			expect(outcome.contactId).toBeUndefined();

			const submission = await getSubmission(t, outcome.submissionId);
			expect(submission?.status).toBe('spam');
			expect(submission?.contactId).toBeUndefined();
		}

		// No contact was created.
		expect(await getContactByEmail(t, 'user@example.com')).toBeNull();
	});

	it("writes 'invalid' when required email is missing", async () => {
		const t = convexTest(schema, modules);
		const formEndpointId = await createForm(t);

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: {},
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('invalid');
			expect(outcome.errorMessage).toContain('Email is required');
			expect(outcome.contactId).toBeUndefined();
		}

		expect(await getContactByEmail(t, '')).toBeNull();
	});

	it("writes 'invalid' when the email format is bad", async () => {
		const t = convexTest(schema, modules);
		const formEndpointId = await createForm(t);

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'not-an-email' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('invalid');
			const submission = await getSubmission(t, outcome.submissionId);
			expect(submission?.errorMessage).toContain('valid email');
		}
	});

	it("writes 'success' for a new contact when the form has no topic", async () => {
		const t = convexTest(schema, modules);
		const formEndpointId = await createForm(t);

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'new@example.com' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('success');
			expect(outcome.contactId).toBeDefined();
		}

		const contact = await getContactByEmail(t, 'new@example.com');
		expect(contact).not.toBeNull();
		expect(contact?.source).toBe('form');
	});

	it("writes 'duplicate' when an existing contact submits a form with no topic", async () => {
		const t = convexTest(schema, modules);
		const formEndpointId = await createForm(t);

		// Seed an existing contact via the resolution module.
		await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'returning@example.com',
			source: 'api',
			mode: 'upsert',
		});

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'returning@example.com' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('duplicate');
			expect(outcome.contactId).toBeDefined();
		}
	});

	it("writes 'success' + membership when a new contact joins a non-DOI topic", async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);
		const formEndpointId = await createForm(t, { topicId });

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'subscriber@example.com', firstName: 'Ada' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('success');
			expect(outcome.contactId).toBeDefined();

			const membership = await getMembership(t, outcome.contactId!, topicId);
			expect(membership).not.toBeNull();
		}

		const contact = await getContactByEmail(t, 'subscriber@example.com');
		expect(contact?.firstName).toBe('Ada');
	});

	it("writes 'pending_confirmation' + records the DOI token for a DOI-required topic", async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, true);
		const formEndpointId = await createForm(t, { topicId });

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'doi@example.com' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('pending_confirmation');
			expect(outcome.confirmationRequired).toBe(true);

			const submission = await getSubmission(t, outcome.submissionId);
			expect(submission?.status).toBe('pending_confirmation');
			expect(submission?.confirmationToken).toBeDefined();
			expect(submission?.confirmationEmailSentAt).toBeDefined();

			// The submission's confirmationToken must equal the contact's
			// doiConfirmationToken (unified token namespace, ADR-0009).
			const contact = await getContactByEmail(t, 'doi@example.com');
			expect(contact?.doiStatus).toBe('pending');
			expect(contact?.doiConfirmationToken).toBe(submission?.confirmationToken);
		}
	});

	it("REGRESSION: existing contact joining a new topic now actually gets added", async () => {
		// The pre-deepening form path skipped `subscribe` whenever the
		// contact already existed — writing `duplicate` and silently dropping
		// the membership. Under the Form submission module, an existing
		// contact submitting a form for a new topic ends up on the topic.
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);
		const formEndpointId = await createForm(t, { topicId });

		// Seed an existing contact NOT on the topic.
		const { contactId } = await t.mutation(
			internal.contacts.resolution.resolve,
			{
				channel: 'email',
				identifier: 'returning@example.com',
				source: 'api',
				mode: 'upsert',
			},
		);

		// Confirm no membership before submission.
		expect(await getMembership(t, contactId, topicId)).toBeNull();

		// Submit the form.
		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'returning@example.com' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			// The action is 'success' — the contact was added.
			expect(outcome.action).toBe('success');
			// Membership now exists.
			expect(await getMembership(t, contactId, topicId)).not.toBeNull();
		}
	});

	it("writes 'duplicate' when an existing contact is already a member of the topic", async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);
		const formEndpointId = await createForm(t, { topicId });

		// Seed contact + membership.
		const { contactId } = await t.mutation(
			internal.contacts.resolution.resolve,
			{
				channel: 'email',
				identifier: 'member@example.com',
				source: 'api',
				mode: 'upsert',
			},
		);
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId,
			contactId,
			source: 'admin',
		});

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'member@example.com' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.action).toBe('duplicate');
		}
	});

	it("returns 'form_not_found' for an unknown form id", async () => {
		const t = convexTest(schema, modules);

		const fakeFormId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('formEndpoints', {
				name: 'temp',
				fields: [],
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId: fakeFormId,
			submissionData: { email: 'user@example.com' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('form_not_found');
		}
	});

	it("returns 'form_inactive' for an inactive form", async () => {
		const t = convexTest(schema, modules);
		const formEndpointId = await createForm(t, { isActive: false });

		const outcome = await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'user@example.com' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('form_inactive');
		}
	});

	it('increments formEndpoints.submissionCount on every write', async () => {
		const t = convexTest(schema, modules);
		const formEndpointId = await createForm(t);

		await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'a@example.com' },
		});
		await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'b@example.com' },
		});
		// spam path also increments.
		await t.mutation(internal.forms.submission.submit, {
			formEndpointId,
			submissionData: { email: 'c@example.com', _hp_field: 'spam' },
		});

		const form = await t.run(
			async (ctx) => await ctx.db.get(formEndpointId),
		);
		expect(form?.submissionCount).toBe(3);
	});
});

// ─── markConfirmedByToken ──────────────────────────────────────────────────

describe('submission.markConfirmedByToken', () => {
	it('patches a pending_confirmation row to success', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, true);
		const formEndpointId = await createForm(t, { topicId });

		// Submit to land a pending_confirmation row + the contact's DOI token.
		const submitOutcome = await t.mutation(
			internal.forms.submission.submit,
			{
				formEndpointId,
				submissionData: { email: 'confirm@example.com' },
			},
		);
		if (!submitOutcome.ok)
			throw new Error('submit failed: ' + submitOutcome.reason);
		const submission = await getSubmission(t, submitOutcome.submissionId);
		const token = submission?.confirmationToken;
		if (!token) throw new Error('expected confirmationToken on row');

		const outcome = await t.mutation(
			internal.forms.submission.markConfirmedByToken,
			{ token },
		);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.submissionId).toBe(submitOutcome.submissionId);
		}
		const after = await getSubmission(t, submitOutcome.submissionId);
		expect(after?.status).toBe('success');
		expect(after?.confirmedAt).toBeDefined();
	});

	it("returns 'no_submission_for_token' for an unknown token", async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(
			internal.forms.submission.markConfirmedByToken,
			{ token: 'no-such-token' },
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('no_submission_for_token');
		}
	});

	it("returns 'already_confirmed' for an already-success row (idempotent)", async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, true);
		const formEndpointId = await createForm(t, { topicId });

		const submitOutcome = await t.mutation(
			internal.forms.submission.submit,
			{
				formEndpointId,
				submissionData: { email: 'idem@example.com' },
			},
		);
		if (!submitOutcome.ok)
			throw new Error('submit failed: ' + submitOutcome.reason);
		const submission = await getSubmission(t, submitOutcome.submissionId);
		const token = submission?.confirmationToken;
		if (!token) throw new Error('expected confirmationToken on row');

		// First confirm.
		const first = await t.mutation(
			internal.forms.submission.markConfirmedByToken,
			{ token },
		);
		expect(first.ok).toBe(true);

		// Second confirm — idempotent.
		const second = await t.mutation(
			internal.forms.submission.markConfirmedByToken,
			{ token },
		);
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.reason).toBe('already_confirmed');
		}
	});

	it("returns 'invalid_state' for a non-pending row (e.g. spam)", async () => {
		const t = convexTest(schema, modules);
		const formEndpointId = await createForm(t, {
			honeypotFieldName: 'website',
		});

		// Plant a spam row that somehow has a confirmationToken — schema permits it.
		const submissionId = await t.run(async (ctx) => {
			return await ctx.db.insert('formSubmissions', {
				formEndpointId,
				data: { email: 'spam@example.com' },
				status: 'spam' as const,
				confirmationToken: 'planted-token',
				submittedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(
			internal.forms.submission.markConfirmedByToken,
			{ token: 'planted-token' },
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('invalid_state');
		}
		expect(submissionId).toBeDefined();
	});
});
