import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { createTestContact, createTestTopic } from './factories';

/**
 * End-to-end tests for the public `/api/v1/*` REST API, driven through
 * `t.fetch(...)` so they exercise the real routing in `http.ts` plus the
 * `createAuthenticatedHandler` API-key auth wrapper.
 *
 * For each route we assert the scope-to-route binding the handler declares via
 * `requireScope(...)`:
 *   - 401 with no key / a malformed key / an unknown key
 *   - 403 when the key is valid but lacks the required scope
 *   - a success status with the correct scope
 *
 * Plus the cross-cutting behaviours documented on the handlers:
 *   - GET /contacts/{x} resolves by ID OR by email
 *   - a soft-deleted (GDPR-erased) contact reads as 404
 *   - malformed percent-encoding in the path → 400 invalid_input (not 500)
 *
 * Module glob copied from the integration-test template (agent/LLM modules
 * excluded so the harness doesn't try to load modules needing extra mocks).
 */
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider'),
	),
);

// Every v1 scope — used to seed an "all-access" key for success-path tests.
const ALL_SCOPES = [
	'contacts:read',
	'contacts:write',
	'events:write',
	'transactional:send',
	'topics:write',
];

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

// SHA-256 hex of the key string — must match auth/apiAuth.ts:hashApiKey.
async function hashKey(k: string): Promise<string> {
	const d = new TextEncoder().encode(k);
	const h = await crypto.subtle.digest('SHA-256', d);
	return Array.from(new Uint8Array(h))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// A format-valid key: /^lm_live_[a-zA-Z0-9]+$/ and >= 40 chars.
function makeKey(suffix = 'a'.repeat(40)): string {
	return 'lm_live_' + suffix;
}

/**
 * Seed an apiKeys row carrying `scopes` and return the raw key string to send
 * as `Authorization: Bearer <key>`. Each key uses a distinct suffix so multiple
 * keys can coexist in one test without hash collisions.
 */
async function seedKey(
	t: ReturnType<typeof convexTest>,
	scopes: string[],
	suffix?: string,
): Promise<string> {
	const key = makeKey(suffix);
	const keyHash = await hashKey(key);
	await t.run(async (ctx) => {
		await ctx.db.insert('apiKeys', {
			name: 'test-key',
			keyHash,
			keyPrefix: 'lm_live_',
			isActive: true,
			scopes,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
	return key;
}

function authHeaders(key: string): Record<string, string> {
	return {
		Authorization: `Bearer ${key}`,
		'Content-Type': 'application/json',
	};
}

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	// Some handlers read SITE_URL via lib/env getOptional — keep it unset so the
	// optional read returns undefined rather than throwing.
	delete process.env['SITE_URL'];
});
afterEach(() => {
	process.env = { ...SAVED_ENV };
});

// ─── Auth gate (shared across every route) ──────────────────────────────────

describe('v1 auth gate', () => {
	it('GET /api/v1/contacts → 401 with no Authorization header', async () => {
		const t = setupTest();
		const res = await t.fetch('/api/v1/contacts', { method: 'GET' });
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.category).toBe('unauthenticated');
	});

	it('GET /api/v1/contacts → 401 with a malformed (too-short) key', async () => {
		const t = setupTest();
		const res = await t.fetch('/api/v1/contacts', {
			method: 'GET',
			headers: { Authorization: 'Bearer lm_live_short' },
		});
		expect(res.status).toBe(401);
	});

	it('GET /api/v1/contacts → 401 with a well-formed but unknown key', async () => {
		const t = setupTest();
		const res = await t.fetch('/api/v1/contacts', {
			method: 'GET',
			headers: { Authorization: `Bearer ${makeKey()}` },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.message).toBe('Invalid API key');
	});

	it('GET /api/v1/contacts → 401 for an inactive key', async () => {
		const t = setupTest();
		const key = makeKey('b'.repeat(40));
		await t.run(async (ctx) => {
			await ctx.db.insert('apiKeys', {
				name: 'inactive',
				keyHash: await hashKey(key),
				keyPrefix: 'lm_live_',
				isActive: false,
				scopes: ['contacts:read'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const res = await t.fetch('/api/v1/contacts', {
			method: 'GET',
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(401);
	});
});

// ─── GET /api/v1/contacts (list) ─────────────────────────────────────────────

describe('GET /api/v1/contacts (listContacts → contacts:read)', () => {
	it('403 when the key lacks contacts:read', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.category).toBe('forbidden');
		expect(body.error.message).toContain('contacts:read');
	});

	it('200 with contacts:read, returning a paginated envelope', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({ email: 'list-me@example.com' }));
		});
		const res = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.pagination).toBeDefined();
		expect(body.pagination.isDone).toBe(true);
	});

	it('400 invalid_input for a non-positive limit', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const res = await t.fetch('/api/v1/contacts?limit=0', {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(400);
	});
});

// ─── POST /api/v1/contacts (create) ──────────────────────────────────────────

describe('POST /api/v1/contacts (createContact → contacts:write)', () => {
	it('403 when the key lacks contacts:write', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const res = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'new@example.com' }),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.message).toContain('contacts:write');
	});

	it('201 with contacts:write, returning the created contact', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'created@example.com', firstName: 'Cre', lastName: 'Ated' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.email).toBe('created@example.com');
		expect(body.data.firstName).toBe('Cre');
		expect(body.data.source).toBe('api');
		expect(typeof body.data.id).toBe('string');
	});

	it('400 invalid_input when email is missing', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ firstName: 'No Email' }),
		});
		expect(res.status).toBe(400);
	});

	it('400 invalid_input for malformed JSON body', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: '{not json',
		});
		expect(res.status).toBe(400);
	});

	it('409 already_exists when creating a duplicate email', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		// Create the first contact through the same API path so the identity rows
		// the strict-mode resolver checks against actually exist.
		const first = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'dupe@example.com' }),
		});
		expect(first.status).toBe(201);
		const res = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'dupe@example.com' }),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error.category).toBe('already_exists');
	});
});

// ─── GET /api/v1/contacts/{idOrEmail} (get) ──────────────────────────────────

describe('GET /api/v1/contacts/{idOrEmail} (getContact → contacts:read)', () => {
	it('403 when the key lacks contacts:read', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts/who@example.com', {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(403);
	});

	it('200 resolving a contact by email', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({ email: 'by-email@example.com' }));
		});
		const res = await t.fetch('/api/v1/contacts/by-email@example.com', {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.email).toBe('by-email@example.com');
	});

	it('200 resolving the same contact by its ID', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const id = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'by-id@example.com' })),
		);
		const res = await t.fetch(`/api/v1/contacts/${id}`, {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(id);
		expect(body.data.email).toBe('by-id@example.com');
	});

	it('404 not_found for an unknown email', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const res = await t.fetch('/api/v1/contacts/nobody@example.com', {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error.category).toBe('not_found');
	});

	it('404 for a soft-deleted (GDPR-erased) contact looked up by email', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'erased@example.com', deletedAt: Date.now() }),
			);
		});
		const res = await t.fetch('/api/v1/contacts/erased@example.com', {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(404);
	});

	it('400 invalid_input for malformed percent-encoding in the path (not 500)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		// A stray "%" that is not a valid percent-escape — safeDecodeURIComponent
		// returns null and the handler maps it to a 400.
		const res = await t.fetch('/api/v1/contacts/%E0%A4%A', {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.category).toBe('invalid_input');
	});
});

// ─── PUT /api/v1/contacts/{idOrEmail} (update) ───────────────────────────────

describe('PUT /api/v1/contacts/{idOrEmail} (updateContact → contacts:write)', () => {
	it('403 when the key lacks contacts:write', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const res = await t.fetch('/api/v1/contacts/x@example.com', {
			method: 'PUT',
			headers: authHeaders(key),
			body: JSON.stringify({ firstName: 'X' }),
		});
		expect(res.status).toBe(403);
	});

	it('200 updating a contact found by ID', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const id = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'upd@example.com', firstName: 'Old' })),
		);
		const res = await t.fetch(`/api/v1/contacts/${id}`, {
			method: 'PUT',
			headers: authHeaders(key),
			body: JSON.stringify({ firstName: 'New' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.firstName).toBe('New');
	});

	it('404 updating an unknown contact', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts/ghost@example.com', {
			method: 'PUT',
			headers: authHeaders(key),
			body: JSON.stringify({ firstName: 'Y' }),
		});
		expect(res.status).toBe(404);
	});
});

// ─── DELETE /api/v1/contacts/{idOrEmail} (delete) ────────────────────────────

describe('DELETE /api/v1/contacts/{idOrEmail} (deleteContact → contacts:write)', () => {
	it('403 when the key lacks contacts:write', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const res = await t.fetch('/api/v1/contacts/x@example.com', {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(403);
	});

	it('200 hard-deleting a contact by ID', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const id = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'del@example.com' })),
		);
		const res = await t.fetch(`/api/v1/contacts/${id}`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.deleted).toBe(true);
		// The row is genuinely gone (hard delete for API-key path).
		const gone = await t.run(async (ctx) => ctx.db.get(id));
		expect(gone).toBeNull();
	});

	it('404 deleting an unknown contact', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts/missing@example.com', {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(404);
	});
});

// ─── POST /api/v1/events ─────────────────────────────────────────────────────

describe('POST /api/v1/events (sendEvent → events:write)', () => {
	it('401 with no key', async () => {
		const t = setupTest();
		const res = await t.fetch('/api/v1/events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'e@example.com', eventName: 'signed_up' }),
		});
		expect(res.status).toBe(401);
	});

	it('403 when the key lacks events:write', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const res = await t.fetch('/api/v1/events', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'e@example.com', eventName: 'signed_up' }),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.message).toContain('events:write');
	});

	it('404 when the contact does not exist and createContactIfNotExists is not set', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['events:write']);
		const res = await t.fetch('/api/v1/events', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'unknown@example.com', eventName: 'signed_up' }),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error.category).toBe('not_found');
	});

	it('201 creating the contact when createContactIfNotExists is true', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['events:write']);
		const res = await t.fetch('/api/v1/events', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({
				email: 'auto@example.com',
				eventName: 'signed_up',
				createContactIfNotExists: true,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.eventName).toBe('signed_up');
		expect(body.data.contactCreated).toBe(true);
		expect(typeof body.data.eventId).toBe('string');
	});

	it('400 invalid_input for a malformed eventName', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['events:write']);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({ email: 'has@example.com' }));
		});
		const res = await t.fetch('/api/v1/events', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'has@example.com', eventName: '1starts-with-digit' }),
		});
		expect(res.status).toBe(400);
	});
});

// ─── POST /api/v1/transactional ──────────────────────────────────────────────

describe('POST /api/v1/transactional (sendTransactional → transactional:send)', () => {
	it('401 with no key', async () => {
		const t = setupTest();
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'to@example.com', slug: 'welcome' }),
		});
		expect(res.status).toBe(401);
	});

	it('403 when the key lacks transactional:send', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'to@example.com', slug: 'welcome' }),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.message).toContain('transactional:send');
	});

	it('400 invalid_input when neither transactionalId nor slug is provided', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'to@example.com' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.category).toBe('invalid_input');
	});

	it('404 not_found when the slug resolves to no template (scope passes, dispatch runs)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'to@example.com', slug: 'no-such-template' }),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error.category).toBe('not_found');
	});
});

// ─── POST /api/v1/topics/{id}/contacts (add) ─────────────────────────────────

describe('POST /api/v1/topics/{id}/contacts (addContactToTopic → topics:write)', () => {
	it('401 with no key', async () => {
		const t = setupTest();
		const id = await t.run(async (ctx) => ctx.db.insert('topics', createTestTopic()));
		const res = await t.fetch(`/api/v1/topics/${id}/contacts`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'sub@example.com' }),
		});
		expect(res.status).toBe(401);
	});

	it('403 when the key lacks topics:write', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const id = await t.run(async (ctx) => ctx.db.insert('topics', createTestTopic()));
		const res = await t.fetch(`/api/v1/topics/${id}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'sub@example.com' }),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.message).toContain('topics:write');
	});

	it('404 not_found when the topic does not exist', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		// A real, table-shaped topic ID that no longer resolves: create then delete
		// so `v.id('topics')` validation passes but the row is gone.
		const goneTopicId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('topics', createTestTopic());
			await ctx.db.delete(id);
			return id;
		});
		const res = await t.fetch(`/api/v1/topics/${goneTopicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'sub@example.com' }),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error.category).toBe('not_found');
	});

	it('400 invalid_input for a malformed topic ID', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const res = await t.fetch('/api/v1/topics/bad/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'sub@example.com' }),
		});
		expect(res.status).toBe(400);
	});

	it('201 adding an existing contact to a topic (DOI not required)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const { topicId } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false }),
			);
			await ctx.db.insert('contacts', createTestContact({ email: 'member@example.com' }));
			return { topicId };
		});
		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'member@example.com' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.success).toBe(true);
		expect(body.data.topicId).toBe(topicId);
		expect(body.data.doiStatus).toBe('not_required');
	});

	it('404 when adding a contact that does not exist (topic exists)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const topicId = await t.run(async (ctx) => ctx.db.insert('topics', createTestTopic()));
		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'ghost@example.com' }),
		});
		expect(res.status).toBe(404);
	});
});

// ─── DELETE /api/v1/topics/{id}/contacts/{x} (remove) ────────────────────────

describe('DELETE /api/v1/topics/{id}/contacts/{x} (removeContactFromTopic → topics:write)', () => {
	it('403 when the key lacks topics:write', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const topicId = await t.run(async (ctx) => ctx.db.insert('topics', createTestTopic()));
		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts/x@example.com`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(403);
	});

	it('404 not_found when the topic does not exist', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const goneTopicId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('topics', createTestTopic());
			await ctx.db.delete(id);
			return id;
		});
		const res = await t.fetch(`/api/v1/topics/${goneTopicId}/contacts/x@example.com`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(404);
	});

	// Regression: removeContactFromTopic used to always report `removed: false`
	// (it checked `m.topicId` against topic docs whose key is `_id`). Fixed to
	// match on `_id`; `removed` must be true when the contact was a member.
	it('200 removing a contact (removed:true when it was a member)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const { topicId } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false }),
			);
			await ctx.db.insert('contacts', createTestContact({ email: 'leaving@example.com' }));
			return { topicId };
		});
		// Subscribe through the real add endpoint so the membership row matches the
		// subscription module's actual shape, then delete it.
		const added = await t.fetch(`/api/v1/topics/${topicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'leaving@example.com' }),
		});
		expect(added.status).toBe(201);
		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts/leaving@example.com`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.success).toBe(true);
		expect(body.data.removed).toBe(true);
	});

	// Companion to the skipped case: the DELETE still succeeds (200) and the
	// membership row is genuinely gone, regardless of the buggy `removed` flag.
	it('200 and the membership is actually deleted', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const { topicId, contactId } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false }),
			);
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'leaving@example.com' }),
			);
			return { topicId, contactId };
		});
		const added = await t.fetch(`/api/v1/topics/${topicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'leaving@example.com' }),
		});
		expect(added.status).toBe(201);
		const membershipBefore = await t.run(async (ctx) =>
			ctx.db
				.query('contactTopics')
				.withIndex('by_contact_and_topic', (q) =>
					q.eq('contactId', contactId).eq('topicId', topicId),
				)
				.first(),
		);
		expect(membershipBefore).not.toBeNull();

		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts/leaving@example.com`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.success).toBe(true);

		const membershipAfter = await t.run(async (ctx) =>
			ctx.db
				.query('contactTopics')
				.withIndex('by_contact_and_topic', (q) =>
					q.eq('contactId', contactId).eq('topicId', topicId),
				)
				.first(),
		);
		expect(membershipAfter).toBeNull();
	});

	it('200 with removed:false when the contact was not in the topic', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const { topicId } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false }),
			);
			await ctx.db.insert('contacts', createTestContact({ email: 'notamember@example.com' }));
			return { topicId };
		});
		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts/notamember@example.com`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.removed).toBe(false);
	});

	it('400 invalid_input for malformed percent-encoding in the contact segment', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const topicId = await t.run(async (ctx) => ctx.db.insert('topics', createTestTopic()));
		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts/%E0%A4%A`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.category).toBe('invalid_input');
	});
});

// ─── A single all-scope key works across every route ─────────────────────────

describe('an all-scope key satisfies every route', () => {
	it('passes the scope gate on read, write, events, and topics routes', async () => {
		const t = setupTest();
		const key = await seedKey(t, ALL_SCOPES);
		const { topicId } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert('topics', createTestTopic());
			await ctx.db.insert('contacts', createTestContact({ email: 'omni@example.com' }));
			return { topicId };
		});

		// contacts:read
		const list = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(list.status).toBe(200);

		// contacts:write (create a fresh contact)
		const create = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'omni-new@example.com' }),
		});
		expect(create.status).toBe(201);

		// topics:write
		const addToTopic = await t.fetch(`/api/v1/topics/${topicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'omni@example.com' }),
		});
		expect(addToTopic.status).toBe(201);
	});
});
