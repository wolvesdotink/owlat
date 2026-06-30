/**
 * Contact-level DOI confirmation via the /confirm page functions.
 *
 * Regression guard for the bug where a contact added to a double-opt-in topic
 * via the public API (or any non-form path) received a /confirm?token= link
 * that the page could never resolve — getByConfirmationToken / confirmSubmission
 * only looked at formSubmissions, of which an API-added contact has none. Both
 * now fall back to the contact's doiConfirmationToken so the link works.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestContact } from './factories';

const modules = import.meta.glob('../**/*.*s');

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const TOKEN = 'contact-doi-token-abcdefghijklmnopqrstuvwxyz0123';

async function seedPendingContact(t: ReturnType<typeof convexTest>) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			defaultFromName: 'Acme Inc',
			createdAt: Date.now(),
		});
		await ctx.db.insert(
			'contacts',
			createTestContact({
				email: 'subscriber@example.com',
				doiStatus: 'pending',
				doiConfirmationToken: TOKEN,
				doiTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
			}),
		);
	});
}

describe('contact-level DOI confirmation via the /confirm page', () => {
	it('getByConfirmationToken resolves a contact-only DOI token', async () => {
		const t = setupTest();
		await seedPendingContact(t);

		const info = await t.query(api.forms.endpoints.getByConfirmationToken, { token: TOKEN });
		expect(info).not.toBeNull();
		expect(info?.email).toBe('subscriber@example.com');
		expect(info?.organizationName).toBe('Acme Inc');
		expect(info?.status).toBe('pending_confirmation');
	});

	it('confirmSubmission confirms a contact-only DOI token (pending → confirmed)', async () => {
		const t = setupTest();
		await seedPendingContact(t);

		const result = await t.mutation(api.forms.endpoints.confirmSubmission, { token: TOKEN });
		expect(result).toEqual({ success: true, alreadyConfirmed: false });

		const contact = await t.run(async (ctx) =>
			(await ctx.db.query('contacts').first()),
		);
		expect(contact?.doiStatus).toBe('confirmed');
	});

	it('returns invalid_token for a token that matches neither a form nor a contact', async () => {
		const t = setupTest();
		await seedPendingContact(t);

		expect(await t.query(api.forms.endpoints.getByConfirmationToken, { token: 'nope' })).toBeNull();
		expect(await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'nope' })).toEqual({
			success: false,
			error: 'invalid_token',
		});
	});
});
