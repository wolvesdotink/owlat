/**
 * The contacts REST API answers 409 for a duplicate by the thrown CATEGORY,
 * never by the wording of the error.
 *
 * The contact writers are replaced by ones that throw a chosen error, so each
 * case pins one direction: an `already_exists` Operation error with any wording
 * is a 409 with the fixed message, and an error of another kind is not one even
 * when its text says "already exists".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { modules } from './testModules';
import { createTestContact } from './factories';
import { throwAlreadyExists, throwInvalidState } from '../_utils/errors';
import type * as ContactEditModule from '../contacts/contactEdit';

const fault = vi.hoisted(() => ({ raise: null as null | (() => never) }));
vi.mock('../contacts/contactEdit', async (importOriginal) => {
	const original = await importOriginal<typeof ContactEditModule>();
	return {
		...original,
		createContactStrict: async (...args: Parameters<typeof original.createContactStrict>) => {
			if (fault.raise) fault.raise();
			return await original.createContactStrict(...args);
		},
		applyContactEdit: async (...args: Parameters<typeof original.applyContactEdit>) => {
			if (fault.raise) fault.raise();
			return await original.applyContactEdit(...args);
		},
	};
});

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	fault.raise = null;
	delete process.env['SITE_URL'];
	process.env['OWLAT_DEV_MODE'] = 'true';
});
afterEach(() => {
	process.env = { ...SAVED_ENV };
});

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const KEY = `lm_live_${'d'.repeat(40)}`;

async function seedKey(t: ReturnType<typeof setupTest>): Promise<void> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY));
	const keyHash = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	await t.run(async (ctx) => {
		await ctx.db.insert('apiKeys', {
			name: 'test-key',
			keyHash,
			keyPrefix: 'lm_live_',
			isActive: true,
			scopes: ['contacts:read', 'contacts:write'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function create(t: ReturnType<typeof setupTest>): Promise<Response> {
	return await t.fetch('/api/v1/contacts', {
		method: 'POST',
		headers,
		body: JSON.stringify({ email: 'new@example.com' }),
	});
}

async function update(t: ReturnType<typeof setupTest>): Promise<Response> {
	const contactId = await t.run((ctx) =>
		ctx.db.insert('contacts', createTestContact({ email: 'mover@example.com' }))
	);
	return await t.fetch(`/api/v1/contacts/${contactId}`, {
		method: 'PUT',
		headers,
		body: JSON.stringify({ email: 'moved@example.com' }),
	});
}

describe.each([
	['POST', create, 'Failed to create contact'],
	['PUT', update, 'Failed to update contact'],
] as const)('%s /api/v1/contacts duplicate classification', (_method, call, failedMessage) => {
	it('answers 409 for an already_exists error worded any way', async () => {
		const t = setupTest();
		await seedKey(t);
		fault.raise = () => throwAlreadyExists('Identity taken: reworded@example.com');

		const res = await call(t);

		expect(res.status).toBe(409);
		const raw = await res.text();
		expect(JSON.parse(raw).error).toEqual({
			category: 'already_exists',
			message: 'A contact with this email already exists',
		});
		expect(raw).not.toContain('reworded@example.com');
	});

	it('does not answer 409 for another failure whose text says "already exists"', async () => {
		const t = setupTest();
		await seedKey(t);
		fault.raise = () => throwInvalidState('The import already exists for this list');

		const res = await call(t);

		expect(res.status).toBe(400);
		expect((await res.json()).error).toEqual({
			category: 'invalid_input',
			message: failedMessage,
		});
	});

	it('does not answer 409 for a bare Error whose text says "already exists"', async () => {
		const t = setupTest();
		await seedKey(t);
		fault.raise = () => {
			throw new Error('A contact with this email already exists');
		};

		const res = await call(t);

		expect(res.status).toBe(400);
		expect((await res.json()).error.category).toBe('invalid_input');
	});
});
