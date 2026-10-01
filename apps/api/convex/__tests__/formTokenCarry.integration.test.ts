/**
 * Integration tests for carrying pending form submissions over to a
 * replacement confirmation token (#1054).
 *
 * A contact's DOI token is replaced on two paths: the admin resend
 * (`doiLifecycle.refreshPendingToken`) and a new signup after the token lapsed
 * (`reducePending`). The signups that waited on the outgoing token must
 * complete when the contact confirms with the new one, and the outgoing link
 * must stay dead. A token a global opt-out withdrew is never carried, and a
 * carry still paging when a global opt-out ends the consent episode stops there.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { DOI_TOKEN_TTL_MS } from '../contacts/doiLifecycle';
import { confirmationWitnesses } from '../forms/pendingConfirmations';
import { STRING_LIMITS } from '../lib/inputGuards';
import { resolveContact } from '../contacts/resolution';
import { expectScheduledFailure } from './helpers/scheduledFailures';

// No MTA runs under test, so the confirmation email's send fails when its job
// fires. These tests check the submission rows, not the delivery.
beforeEach(() => {
	expectScheduledFailure('confirmationEmail:sendConfirmationEmail');
	vi.stubEnv('SITE_URL', 'https://app.example.com');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
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

async function createTopic(t: T, name: string) {
	return await t.run((ctx) =>
		ctx.db.insert('topics', { name, requireDoubleOptIn: true, createdAt: Date.now() })
	);
}

async function createForm(
	t: T,
	args: { topicId?: Id<'topics'>; doubleOptIn?: boolean; name: string }
): Promise<Id<'formEndpoints'>> {
	return await t.run((ctx) =>
		ctx.db.insert('formEndpoints', {
			name: args.name,
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

async function seedPendingRows(
	t: T,
	args: {
		count: number;
		forms: Id<'formEndpoints'>[];
		contactId: Id<'contacts'>;
		token: string;
		status?: 'pending_confirmation' | 'invalid';
	}
): Promise<Id<'formSubmissions'>[]> {
	return await t.run(async (ctx) => {
		const ids: Id<'formSubmissions'>[] = [];
		for (let i = 0; i < args.count; i++) {
			ids.push(
				await ctx.db.insert('formSubmissions', {
					formEndpointId: args.forms[i % args.forms.length]!,
					contactId: args.contactId,
					data: { email: 'rows@example.com' },
					status: args.status ?? 'pending_confirmation',
					confirmationToken: args.token,
					submittedAt: Date.now(),
				})
			);
		}
		return ids;
	});
}

async function rowsById(t: T, ids: Id<'formSubmissions'>[]) {
	return await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
}

async function successCount(t: T, id: Id<'formEndpoints'>) {
	return (await t.run((ctx) => ctx.db.get(id)))?.successfulSubmissionCount;
}

async function getContact(t: T, id: Id<'contacts'>) {
	return await t.run((ctx) => ctx.db.get(id));
}

async function resend(t: T, contactId: Id<'contacts'>, token: string) {
	return await t.mutation(internal.contacts.doiLifecycle.refreshPendingToken, {
		contactId,
		at: Date.now(),
		token,
		ttlMs: DOI_TOKEN_TTL_MS,
		siteUrl: 'https://app.example.com',
	});
}

async function expectDeadLink(t: T, token: string) {
	expect(await t.query(api.forms.endpoints.getByConfirmationToken, { token })).toBeNull();
	expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token })).toEqual({
		success: false,
		error: 'invalid_token',
	});
}

// ─── Admin resend ───────────────────────────────────────────────────────────

describe('a resend carries the pending signups to the new token', () => {
	it('confirming the new link finalizes the signups made before the resend', async () => {
		const t = setupTest();
		const formA = await createForm(t, { topicId: await createTopic(t, 'News'), name: 'A' });
		const formB = await createForm(t, { doubleOptIn: true, name: 'B' });
		const a = await submit(t, formA, 'resend@example.com');
		const b = await submit(t, formB, 'resend@example.com');
		const oldToken = a.row.confirmationToken!;
		expect(b.row.confirmationToken).toBe(oldToken);
		const contactId = a.outcome.contactId!;

		expect(await resend(t, contactId, 'resent-token')).toMatchObject({ ok: true });

		const [rowA, rowB] = await rowsById(t, [a.outcome.submissionId, b.outcome.submissionId]);
		expect(rowA?.confirmationToken).toBe('resent-token');
		expect(rowB?.confirmationToken).toBe('resent-token');
		expect(rowA?.status).toBe('pending_confirmation');

		expect(
			await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'resent-token' })
		).toEqual({ success: true, alreadyConfirmed: false });

		const after = await rowsById(t, [a.outcome.submissionId, b.outcome.submissionId]);
		expect(after.map((r) => r?.status)).toEqual(['success', 'success']);
		expect(after.every((r) => typeof r?.confirmedAt === 'number')).toBe(true);
		expect(await successCount(t, formA)).toBe(1);
		expect(await successCount(t, formB)).toBe(1);
		expect((await getContact(t, contactId))?.doiStatus).toBe('confirmed');

		// The replaced link stays dead, before and after the confirmation.
		await expectDeadLink(t, oldToken);
	});

	it('the replaced link is dead as soon as the resend lands', async () => {
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const { outcome, row } = await submit(t, formId, 'dead@example.com');

		await resend(t, outcome.contactId!, 'resent-token');

		await expectDeadLink(t, row.confirmationToken!);
		expect((await rowsById(t, [outcome.submissionId]))[0]?.status).toBe('pending_confirmation');
		expect(await successCount(t, formId)).toBe(0);
	});

	it('pages a large carry and leaves other contacts and other statuses alone', async () => {
		vi.useFakeTimers();
		const t = setupTest();
		const formA = await createForm(t, { name: 'A' });
		const formB = await createForm(t, { name: 'B' });
		const oldToken = 'outgoing-token-shared-by-many-rows';
		const contactId = await seedContact(t, 'many@example.com', {
			doiStatus: 'pending',
			doiConfirmationToken: oldToken,
			doiTokenExpiresAt: Date.now() + DOI_TOKEN_TTL_MS,
		});
		const strangerId = await seedContact(t, 'stranger@example.com');
		const mine = await seedPendingRows(t, {
			count: 230,
			forms: [formA, formB],
			contactId,
			token: oldToken,
		});
		const [strangerRow] = await seedPendingRows(t, {
			count: 1,
			forms: [formA],
			contactId: strangerId,
			token: oldToken,
		});
		const [invalidRow] = await seedPendingRows(t, {
			count: 1,
			forms: [formA],
			contactId,
			token: oldToken,
			status: 'invalid',
		});

		await resend(t, contactId, 'resent-token');
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const carried = await rowsById(t, mine);
		expect(carried.every((r) => r?.confirmationToken === 'resent-token')).toBe(true);
		expect(carried.every((r) => r?.status === 'pending_confirmation')).toBe(true);
		const [stranger, invalid] = await rowsById(t, [strangerRow!, invalidRow!]);
		expect(stranger).toMatchObject({ confirmationToken: oldToken, status: 'pending_confirmation' });
		expect(invalid).toMatchObject({ confirmationToken: oldToken, status: 'invalid' });

		await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'resent-token' });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect((await rowsById(t, mine)).every((r) => r?.status === 'success')).toBe(true);
		expect(await successCount(t, formA)).toBe(115);
		expect(await successCount(t, formB)).toBe(115);
		expect((await rowsById(t, [strangerRow!]))[0]?.status).toBe('pending_confirmation');
	});
});

// ─── Lapsed token replaced by a new signup ──────────────────────────────────

describe('a new signup after the token lapsed carries the earlier signups', () => {
	it('confirming finalizes the earlier submissions and the new one', async () => {
		const t = setupTest();
		const formA = await createForm(t, { topicId: await createTopic(t, 'News'), name: 'A' });
		const formB = await createForm(t, { doubleOptIn: true, name: 'B' });
		const first = await submit(t, formA, 'lapsed@example.com');
		const contactId = first.outcome.contactId!;
		const lapsedToken = first.row.confirmationToken!;
		await t.run((ctx) => ctx.db.patch(contactId, { doiTokenExpiresAt: Date.now() - 1 }));

		const second = await submit(t, formB, 'lapsed@example.com');
		const freshToken = second.row.confirmationToken!;
		expect(freshToken).not.toBe(lapsedToken);
		expect((await rowsById(t, [first.outcome.submissionId]))[0]?.confirmationToken).toBe(
			freshToken
		);

		expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token: freshToken })).toEqual({
			success: true,
			alreadyConfirmed: false,
		});

		const rows = await rowsById(t, [first.outcome.submissionId, second.outcome.submissionId]);
		expect(rows.map((r) => r?.status)).toEqual(['success', 'success']);
		expect(await successCount(t, formA)).toBe(1);
		expect(await successCount(t, formB)).toBe(1);
		await expectDeadLink(t, lapsedToken);
	});

	it('the contact-only /confirm/doi route finalizes the carried rows too', async () => {
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const first = await submit(t, formId, 'doi-route@example.com');
		const contactId = first.outcome.contactId!;
		await t.run((ctx) => ctx.db.patch(contactId, { doiTokenExpiresAt: Date.now() - 1 }));
		const second = await submit(t, formId, 'doi-route@example.com');

		const result = await t.mutation(internal.topics.topics.confirmDoi, {
			token: second.row.confirmationToken!,
		});

		expect(result.success).toBe(true);
		const rows = await rowsById(t, [first.outcome.submissionId, second.outcome.submissionId]);
		expect(rows.map((r) => r?.status)).toEqual(['success', 'success']);
		expect(await successCount(t, formId)).toBe(2);
	});

	it('pages a large carry on the signup path', async () => {
		vi.useFakeTimers();
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const lapsedToken = 'lapsed-token-shared-by-many-rows';
		const contactId = await seedContact(t, 'rows@example.com', {
			doiStatus: 'pending',
			doiConfirmationToken: lapsedToken,
			doiTokenExpiresAt: Date.now() - 1,
		});
		const earlier = await seedPendingRows(t, {
			count: 150,
			forms: [formId],
			contactId,
			token: lapsedToken,
		});

		const latest = await submit(t, formId, 'rows@example.com');
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const freshToken = latest.row.confirmationToken!;
		expect((await rowsById(t, earlier)).every((r) => r?.confirmationToken === freshToken)).toBe(
			true
		);

		await t.mutation(api.forms.endpoints.confirmSubmission, { token: freshToken });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect((await rowsById(t, earlier)).every((r) => r?.status === 'success')).toBe(true);
		expect(await successCount(t, formId)).toBe(151);
	});
});

// ─── What is never carried ──────────────────────────────────────────────────

describe('rows that stay where they are', () => {
	it('a token a global opt-out withdrew is not carried to the next episode', async () => {
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const first = await submit(t, formId, 'withdrawn@example.com');
		const contactId = first.outcome.contactId!;
		const withdrawnToken = first.row.confirmationToken!;
		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId,
			source: 'public_email_link',
		});
		expect((await getContact(t, contactId))?.doiConfirmationToken).toBeUndefined();

		const second = await submit(t, formId, 'withdrawn@example.com');
		await resend(t, contactId, 'resent-after-opt-out');
		await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'resent-after-opt-out' });

		const [stale, fresh] = await rowsById(t, [
			first.outcome.submissionId,
			second.outcome.submissionId,
		]);
		expect(stale).toMatchObject({
			status: 'pending_confirmation',
			confirmationToken: withdrawnToken,
		});
		expect(fresh?.status).toBe('success');
		expect(await successCount(t, formId)).toBe(1);
	});

	it('a token issued before the contact opted out is not carried', async () => {
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const now = Date.now();
		// Opted out before opt-outs withdrew tokens: the old token is still held.
		const contactId = await seedContact(t, 'legacy@example.com', {
			doiStatus: 'pending',
			doiConfirmationToken: 'pre-opt-out-token',
			doiTokenExpiresAt: now - 1,
			unsubscribedAt: now - 1000,
		});
		const [row] = await seedPendingRows(t, {
			count: 1,
			forms: [formId],
			contactId,
			token: 'pre-opt-out-token',
		});

		const signup = await submit(t, formId, 'legacy@example.com');
		await resend(t, contactId, 'resent-after-signup');

		expect(signup.row.confirmationToken).not.toBe('pre-opt-out-token');
		expect((await rowsById(t, [row!]))[0]?.confirmationToken).toBe('pre-opt-out-token');
		expect((await rowsById(t, [signup.outcome.submissionId]))[0]?.confirmationToken).toBe(
			'resent-after-signup'
		);
	});

	it('a resend for a contact that holds no token carries nothing', async () => {
		const t = setupTest();
		const formId = await createForm(t, { name: 'A' });
		const contactId = await seedContact(t, 'tokenless@example.com', { doiStatus: 'pending' });
		const [row] = await seedPendingRows(t, {
			count: 1,
			forms: [formId],
			contactId,
			token: 'some-old-token',
		});

		await resend(t, contactId, 'resent-token');

		expect((await rowsById(t, [row!]))[0]?.confirmationToken).toBe('some-old-token');
	});
});

// ─── A carry still running when the token moves on ──────────────────────────

describe('a carry continuation follows the contact', () => {
	async function seedHalfCarried(t: T) {
		const formId = await createForm(t, { name: 'A' });
		const contactId = await seedContact(t, 'race@example.com', {
			doiStatus: 'pending',
			doiConfirmationToken: 'second-token',
			doiTokenExpiresAt: Date.now() + DOI_TOKEN_TTL_MS,
		});
		const left = await seedPendingRows(t, {
			count: 3,
			forms: [formId],
			contactId,
			token: 'first-token',
		});
		return { formId, contactId, left };
	}

	it('moves the rest to the token the contact holds now', async () => {
		const t = setupTest();
		const { contactId, left } = await seedHalfCarried(t);
		await t.run((ctx) => ctx.db.patch(contactId, { doiConfirmationToken: 'third-token' }));

		await t.mutation(internal.forms.pendingConfirmations.carryPendingSubmissions, {
			contactId,
			fromToken: 'first-token',
			toToken: 'second-token',
			episode: 0,
		});

		expect((await rowsById(t, left)).every((r) => r?.confirmationToken === 'third-token')).toBe(
			true
		);
	});

	async function confirmContact(t: T, contactId: Id<'contacts'>, confirmedAt: number) {
		await t.run((ctx) =>
			ctx.db.patch(contactId, {
				doiStatus: 'confirmed',
				doiConfirmedAt: confirmedAt,
				doiConfirmationToken: undefined,
				doiTokenExpiresAt: undefined,
			})
		);
	}

	it('finalizes the rest under the token the confirmation consumed', async () => {
		const t = setupTest();
		const { formId, contactId, left } = await seedHalfCarried(t);
		const confirmedAt = Date.now() - 1000;
		// A later resend replaced `second-token`, and the contact confirmed that
		// one; the row its confirmation finalized records the consumed token.
		await t.run((ctx) =>
			ctx.db.insert('formSubmissions', {
				formEndpointId: formId,
				contactId,
				data: { email: 'race@example.com' },
				status: 'success',
				confirmationToken: 'third-token',
				confirmedAt,
				submittedAt: Date.now(),
			})
		);
		await confirmContact(t, contactId, confirmedAt);

		await t.mutation(internal.forms.pendingConfirmations.carryPendingSubmissions, {
			contactId,
			fromToken: 'first-token',
			toToken: 'second-token',
			episode: 0,
		});

		const rows = await rowsById(t, left);
		expect(rows.every((r) => r?.status === 'success' && r.confirmedAt === confirmedAt)).toBe(true);
		expect(rows.every((r) => r?.confirmationToken === 'third-token')).toBe(true);
		expect(await successCount(t, formId)).toBe(3);
	});

	it('finalizes the rest without a token when no row records the consumed one', async () => {
		const t = setupTest();
		const { formId, contactId, left } = await seedHalfCarried(t);
		await confirmContact(t, contactId, Date.now() - 1000);

		await t.mutation(internal.forms.pendingConfirmations.carryPendingSubmissions, {
			contactId,
			fromToken: 'first-token',
			toToken: 'second-token',
			episode: 0,
		});

		const rows = await rowsById(t, left);
		expect(rows.every((r) => r?.status === 'success')).toBe(true);
		expect(rows.every((r) => r?.confirmationToken === undefined)).toBe(true);
		expect(await successCount(t, formId)).toBe(3);
		await expectDeadLink(t, 'second-token');
	});

	it('stops when an opt-out withdrew the token in between', async () => {
		const t = setupTest();
		const { contactId, left } = await seedHalfCarried(t);
		await t.run((ctx) =>
			ctx.db.patch(contactId, {
				doiConfirmationToken: undefined,
				doiTokenExpiresAt: undefined,
				unsubscribedAt: Date.now(),
			})
		);

		await t.mutation(internal.forms.pendingConfirmations.carryPendingSubmissions, {
			contactId,
			fromToken: 'first-token',
			toToken: 'second-token',
			episode: 0,
		});

		const rows = await rowsById(t, left);
		expect(rows.every((r) => r?.confirmationToken === 'first-token')).toBe(true);
		expect(rows.every((r) => r?.status === 'pending_confirmation')).toBe(true);
	});
});

// ─── A carry that outlives its consent episode ──────────────────────────────

describe('a carry continuation stops at the end of its consent episode', () => {
	// 150 rows wait on the first token; a resend moves the first page of 100 in
	// its own transaction and queues the other 50. A global opt-out and a fresh
	// signup land before the queued page runs.
	async function carryInterruptedByOptOutAndSignup(t: T) {
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const email = 'episode@example.com';
		const contactId = await seedContact(t, email, {
			doiStatus: 'pending',
			doiConfirmationToken: 'first-token',
			doiTokenExpiresAt: Date.now() + DOI_TOKEN_TTL_MS,
		});
		const rows = await seedPendingRows(t, {
			count: 150,
			forms: [formId],
			contactId,
			token: 'first-token',
		});

		await resend(t, contactId, 'resent-token');
		const afterResend = await rowsById(t, rows);
		expect(afterResend.filter((r) => r?.confirmationToken === 'resent-token')).toHaveLength(100);
		const queued = rows.filter((_, i) => afterResend[i]?.confirmationToken === 'first-token');
		expect(queued).toHaveLength(50);

		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId,
			source: 'public_email_link',
		});
		const signup = await submit(t, formId, email);
		const freshToken = signup.row.confirmationToken!;
		expect(freshToken).not.toBe('resent-token');
		return { formId, queued, signup, freshToken };
	}

	it('leaves the queued rows pending when it runs before the new signup is confirmed', async () => {
		vi.useFakeTimers();
		const t = setupTest();
		const { formId, queued, signup, freshToken } = await carryInterruptedByOptOutAndSignup(t);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await t.mutation(api.forms.endpoints.confirmSubmission, { token: freshToken });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const left = await rowsById(t, queued);
		expect(left.every((r) => r?.status === 'pending_confirmation')).toBe(true);
		expect(left.every((r) => r?.confirmationToken === 'first-token')).toBe(true);
		expect((await rowsById(t, [signup.outcome.submissionId]))[0]?.status).toBe('success');
		expect(await successCount(t, formId)).toBe(1);
	});

	it('leaves the queued rows pending when it runs after the new signup is confirmed', async () => {
		vi.useFakeTimers();
		const t = setupTest();
		const { formId, queued, signup, freshToken } = await carryInterruptedByOptOutAndSignup(t);

		await t.mutation(api.forms.endpoints.confirmSubmission, { token: freshToken });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const left = await rowsById(t, queued);
		expect(left.every((r) => r?.status === 'pending_confirmation')).toBe(true);
		expect(left.every((r) => r?.confirmationToken === 'first-token')).toBe(true);
		expect((await rowsById(t, [signup.outcome.submissionId]))[0]?.status).toBe('success');
		expect(await successCount(t, formId)).toBe(1);
	});

	it('stops when the opt-out came after the token was already confirmed', async () => {
		vi.useFakeTimers();
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const email = 'confirmed-then-out@example.com';
		const contactId = await seedContact(t, email, {
			doiStatus: 'pending',
			doiConfirmationToken: 'first-token',
			doiTokenExpiresAt: Date.now() + DOI_TOKEN_TTL_MS,
		});
		const rows = await seedPendingRows(t, {
			count: 150,
			forms: [formId],
			contactId,
			token: 'first-token',
		});
		await resend(t, contactId, 'resent-token');
		await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'resent-token' });
		// The opt-out finds no token to withdraw, and still ends the episode.
		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId,
			source: 'public_email_link',
		});
		const signup = await submit(t, formId, email);
		await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: signup.row.confirmationToken!,
		});

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const after = await rowsById(t, rows);
		expect(after.filter((r) => r?.status === 'success')).toHaveLength(100);
		expect(after.filter((r) => r?.status === 'pending_confirmation')).toHaveLength(50);
		expect(await successCount(t, formId)).toBe(101);
	});
});

// ─── Two replacements before the follow-up runs ─────────────────────────────

describe('a carry continuation after a second resend', () => {
	async function seedForTwoResends(t: T) {
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const contactId = await seedContact(t, 'twice@example.com', {
			doiStatus: 'pending',
			doiConfirmationToken: 'first-token',
			doiTokenExpiresAt: Date.now() + DOI_TOKEN_TTL_MS,
		});
		const rows = await seedPendingRows(t, {
			count: 150,
			forms: [formId],
			contactId,
			token: 'first-token',
		});
		return { formId, contactId, rows };
	}

	async function expectAllConfirmedUnderNewestToken(
		t: T,
		formId: Id<'formEndpoints'>,
		rows: Id<'formSubmissions'>[]
	) {
		const after = await rowsById(t, rows);
		expect(after.every((r) => r?.status === 'success')).toBe(true);
		expect(after.every((r) => r?.confirmationToken === 'third-token')).toBe(true);
		expect(await successCount(t, formId)).toBe(150);
		await expectDeadLink(t, 'second-token');
		await expectDeadLink(t, 'first-token');
	}

	it('confirms the queued rows under the newest token when it was confirmed first', async () => {
		vi.useFakeTimers();
		const t = setupTest();
		const { formId, contactId, rows } = await seedForTwoResends(t);

		await resend(t, contactId, 'second-token');
		await resend(t, contactId, 'third-token');
		await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'third-token' });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await expectAllConfirmedUnderNewestToken(t, formId, rows);
	});

	it('confirms every row under the newest token when the follow-up ran between the resends', async () => {
		vi.useFakeTimers();
		const t = setupTest();
		const { formId, contactId, rows } = await seedForTwoResends(t);

		await resend(t, contactId, 'second-token');
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await resend(t, contactId, 'third-token');
		await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'third-token' });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await expectAllConfirmedUnderNewestToken(t, formId, rows);
	});
});

// ─── A contact with a long submission history ───────────────────────────────

describe('a carry finalizing for a contact with a long history', () => {
	// Convex's per-transaction read limit. convex-test does not enforce it, so
	// the lookup's index range is read under this budget explicitly.
	const READ_LIMIT_BYTES = 16 * 1024 * 1024;

	it('finds the consumed token with one indexed read and finalizes every row', async () => {
		vi.useFakeTimers();
		const t = setupTest();
		const formId = await createForm(t, { doubleOptIn: true, name: 'A' });
		const contactId = await seedContact(t, 'history@example.com', {
			doiStatus: 'pending',
			doiConfirmationToken: 'first-token',
			doiTokenExpiresAt: Date.now() + DOI_TOKEN_TTL_MS,
		});
		// Earlier submissions, each at the largest field value a form accepts:
		// more than the read limit in total, ahead of every later row.
		const bigValue = 'x'.repeat(STRING_LIMITS.FORM_FIELD_VALUE);
		await t.run(async (ctx) => {
			for (let i = 0; i < 2000; i++) {
				await ctx.db.insert('formSubmissions', {
					formEndpointId: formId,
					contactId,
					data: { email: 'history@example.com', note: bigValue },
					status: 'duplicate',
					submittedAt: Date.now(),
				});
			}
		});
		const rows = await seedPendingRows(t, {
			count: 150,
			forms: [formId],
			contactId,
			token: 'first-token',
		});

		await resend(t, contactId, 'second-token');
		await resend(t, contactId, 'third-token');
		await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'third-token' });

		const confirmedAt = (await getContact(t, contactId))?.doiConfirmedAt;
		expect(confirmedAt).toBeDefined();
		const lookup = await t.run((ctx) =>
			confirmationWitnesses(ctx, contactId, confirmedAt!).paginate({
				numItems: 1,
				cursor: null,
				maximumBytesRead: READ_LIMIT_BYTES,
			})
		);
		expect(lookup.page[0]?.confirmationToken).toBe('third-token');

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const after = await rowsById(t, rows);
		expect(after.every((r) => r?.status === 'success')).toBe(true);
		expect(after.every((r) => r?.confirmationToken === 'third-token')).toBe(true);
		expect(await successCount(t, formId)).toBe(150);
	});
});
