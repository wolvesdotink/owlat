/**
 * Integration tests for the email-field invariant on form endpoint
 * create/update (forms/endpoints.ts).
 *
 * A form whose fields carry no email-type field is dead on arrival:
 * forms/submission.ts can never resolve a recipient address and rejects
 * every public POST with 'Email is required'. The dashboard field editor
 * can otherwise delete the email field whenever a second field exists, so
 * the server mirrors the client guard to hold the invariant for any caller
 * (SDK / direct Convex client), not just the UI.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// authedMutation calls getMutationContext; the handler then calls
		// requireOrgPermission. Stub both so the auth gate passes and we
		// exercise the email-field invariant.
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

const emailField = { key: 'email', label: 'Email', type: 'email' as const, required: true };
const textField = { key: 'firstName', label: 'First name', type: 'text' as const, required: false };

describe('forms.endpoints.create — email-field invariant', () => {
	it('accepts an explicit field list that includes an email field', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.forms.endpoints.create, {
			name: 'Signup',
			fields: [emailField, textField],
		});
		expect(id).toBeTruthy();
	});

	it('accepts the default (no fields supplied) — falls back to email-only', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.forms.endpoints.create, { name: 'Signup' });
		expect(id).toBeTruthy();
	});

	it('rejects an explicit field list with no email field', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.forms.endpoints.create, {
				name: 'Signup',
				fields: [textField],
			})
		).rejects.toThrow(/email field/i);
	});
});

describe('forms.endpoints.update — email-field invariant', () => {
	it('rejects a fields update that drops the email field', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.forms.endpoints.create, {
			name: 'Signup',
			fields: [emailField, textField],
		});

		await expect(
			t.mutation(api.forms.endpoints.update, {
				formEndpointId: id,
				fields: [textField],
			})
		).rejects.toThrow(/email field/i);
	});

	it('accepts a fields update that keeps the email field', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.forms.endpoints.create, {
			name: 'Signup',
			fields: [emailField],
		});

		const result = await t.mutation(api.forms.endpoints.update, {
			formEndpointId: id,
			fields: [emailField, textField],
		});
		expect(result).toBe(id);
	});

	it('allows a non-fields update (name only) without touching the field list', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.forms.endpoints.create, {
			name: 'Signup',
			fields: [emailField],
		});

		const result = await t.mutation(api.forms.endpoints.update, {
			formEndpointId: id,
			name: 'Renamed',
		});
		expect(result).toBe(id);
	});
});

describe('forms.endpoints.update — clearing optional settings', () => {
	async function createConfiguredForm(t: ReturnType<typeof convexTest>) {
		const topicId = await t.run(
			async (ctx) => await ctx.db.insert('topics', { name: 'News', createdAt: Date.now() })
		);
		const id = await t.mutation(api.forms.endpoints.create, {
			name: 'Signup',
			fields: [emailField],
			topicId,
			redirectUrl: 'https://owlat.example.com/thanks',
			honeypotFieldName: 'website',
		});
		return { id, topicId };
	}

	it('removes the topic, redirect URL and honeypot field when asked to clear them', async () => {
		const t = convexTest(schema, modules);
		const { id } = await createConfiguredForm(t);

		await t.mutation(api.forms.endpoints.update, {
			formEndpointId: id,
			topicId: null,
			redirectUrl: '',
			honeypotFieldName: '',
		});

		const form = await t.run(async (ctx) => await ctx.db.get(id));
		expect(form?.topicId).toBeUndefined();
		expect(form?.redirectUrl).toBeUndefined();
		expect(form?.honeypotFieldName).toBeUndefined();
	});

	it('leaves them alone when an update omits them', async () => {
		const t = convexTest(schema, modules);
		const { id, topicId } = await createConfiguredForm(t);

		await t.mutation(api.forms.endpoints.update, { formEndpointId: id, isActive: false });

		const form = await t.run(async (ctx) => await ctx.db.get(id));
		expect(form?.topicId).toBe(topicId);
		expect(form?.redirectUrl).toBe('https://owlat.example.com/thanks');
		expect(form?.honeypotFieldName).toBe('website');
	});
});

describe('forms.endpoints — forms feature floor', () => {
	it('refuses an update with forms off (formsMutation floor)', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.forms.endpoints.create, {
			name: 'Signup',
			fields: [emailField],
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { forms: false },
				createdAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.forms.endpoints.update, { formEndpointId: id, name: 'Renamed' })
		).rejects.toThrow(/"category":"forbidden".*"feature":"forms"/);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(id))?.name).toBe('Signup');
		});
	});
});
