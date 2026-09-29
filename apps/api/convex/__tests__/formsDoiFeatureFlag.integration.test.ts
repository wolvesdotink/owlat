/**
 * The double-opt-in confirmation of a form submission follows the `forms`
 * flag, as the public submit endpoint does. While the flag is off, a token that
 * a form submission minted neither resolves nor confirms, on the forms landing
 * page functions or the contact-level `/confirm/doi` routes. A contact-level
 * token that no form minted is unaffected.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { DOI_TOKEN_TTL_MS } from '../contacts/doiLifecycle';
import { expectScheduledFailure } from './helpers/scheduledFailures';

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	expectScheduledFailure('confirmationEmail:sendConfirmationEmail');
});

type T = ReturnType<typeof convexTest>;

function harness(): T {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function setFormsFlag(t: T, enabled: boolean): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		const settings = await ctx.db.query('instanceSettings').first();
		if (settings) {
			await ctx.db.patch(settings._id, {
				featureFlags: { ...settings.featureFlags, forms: enabled },
				updatedAt: now,
			});
		} else {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { forms: enabled },
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

/** A contact pending DOI under `token`, optionally with the form submission that minted it. */
async function seedPending(
	t: T,
	token: string,
	withSubmission: boolean
): Promise<{ contactId: Id<'contacts'>; submissionId: Id<'formSubmissions'> | null }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const contactId = await ctx.db.insert('contacts', {
			email: `${token}@example.com`,
			source: 'form',
			searchableText: `${token}@example.com`,
			doiStatus: 'pending',
			doiConfirmationToken: token,
			doiTokenExpiresAt: now + DOI_TOKEN_TTL_MS,
			createdAt: now,
			updatedAt: now,
		});
		if (!withSubmission) return { contactId, submissionId: null };
		const topicId = await ctx.db.insert('topics', {
			name: 'Newsletter',
			requireDoubleOptIn: true,
			createdAt: now,
		});
		const formEndpointId = await ctx.db.insert('formEndpoints', {
			name: 'Signup',
			topicId,
			fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
			isActive: true,
			doubleOptIn: true,
			createdAt: now,
			updatedAt: now,
		});
		const submissionId = await ctx.db.insert('formSubmissions', {
			formEndpointId,
			contactId,
			data: { email: `${token}@example.com` },
			status: 'pending_confirmation',
			confirmationToken: token,
			confirmationEmailSentAt: now,
			submittedAt: now,
		});
		return { contactId, submissionId };
	});
}

async function doiStatus(t: T, contactId: Id<'contacts'>) {
	return await t.run(async (ctx) => (await ctx.db.get(contactId))?.doiStatus);
}

describe('form submission DOI confirmation follows the forms flag', () => {
	it('neither resolves nor confirms a form-minted token while forms is off', async () => {
		const t = harness();
		const { contactId, submissionId } = await seedPending(t, 'form-token-1', true);
		await setFormsFlag(t, false);

		expect(
			await t.query(api.forms.endpoints.getByConfirmationToken, { token: 'form-token-1' })
		).toBeNull();
		expect(
			await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'form-token-1' })
		).toEqual({ success: false, error: 'invalid_token' });

		const verify = await t.fetch('/confirm/doi/verify?token=form-token-1', { method: 'GET' });
		expect(verify.status).toBe(404);
		const confirm = await t.fetch('/confirm/doi?token=form-token-1', { method: 'POST' });
		expect(confirm.status).toBe(400);

		expect(await doiStatus(t, contactId)).toBe('pending');
		const submission = await t.run(async (ctx) => ctx.db.get(submissionId!));
		expect(submission?.status).toBe('pending_confirmation');
	});

	it('confirms the same token once forms is back on', async () => {
		const t = harness();
		const { contactId } = await seedPending(t, 'form-token-2', true);
		await setFormsFlag(t, false);
		await setFormsFlag(t, true);

		expect(
			await t.query(api.forms.endpoints.getByConfirmationToken, { token: 'form-token-2' })
		).not.toBeNull();
		const result = await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: 'form-token-2',
		});
		expect(result.success).toBe(true);
		expect(await doiStatus(t, contactId)).toBe('confirmed');
	});

	it('leaves a contact-level token unaffected while forms is off', async () => {
		const t = harness();
		const { contactId } = await seedPending(t, 'contact-token-1', false);
		await setFormsFlag(t, false);

		expect(
			await t.query(api.forms.endpoints.getByConfirmationToken, { token: 'contact-token-1' })
		).not.toBeNull();
		const confirm = await t.fetch('/confirm/doi?token=contact-token-1', { method: 'POST' });
		expect(confirm.status).toBe(200);
		expect(await doiStatus(t, contactId)).toBe('confirmed');
	});
});
