import { convexTest } from 'convex-test';
import { describe, it, expect, expectTypeOf, beforeEach, afterEach, vi } from 'vitest';
import schema from '../schema';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { createTestContact, createTestTopic, createTestTransactionalEmail } from './factories';
import {
	apiErrorResponseSchema,
	PUBLIC_OPERATIONS,
	publicOperation,
	reasonsAt,
	successBodySchema,
	type PublicOperationId,
	type TransactionalRefusalReason,
	DELIVERY_STATUS_REASONS,
	type DeliveryFixAudience,
	type DeliveryStatusLevel,
	type DeliveryStatusReason,
	type SendingDomainStatusValue,
} from '@owlat/public-contract/schemas';
import { httpRouter } from 'convex/server';
import { registerPublicApiRoutes } from '../publicApi/v1Http';
import * as contactsApi from '../contacts/api';
import { sendEvent } from '../publicApi/events';
import { sendTransactional } from '../transactional/api';
import type { DispatchRejectionReason } from '../transactional/dispatch';
import { getTransactionalSend } from '../transactional/sendStatusHttp';
import { addContactToTopic, removeContactFromTopic } from '../topics/apiHttp';
import { healthCheck } from '../auth/apiAuthHttp';
import { getStatus } from '../publicApi/statusHttp';
import { DELIVERY_HEALTH_REASONS, type DeliveryHealthFixAudience } from '../delivery/healthCopy';
import type { DeliveryHealthLevel, DomainStatus } from '../delivery/health';
import { openWorkspaceDeletionFence } from './helpers/workspaceDeletionFence';
import type * as ContactEditModule from '../contacts/contactEdit';
import type * as MembershipShellsModule from '../topics/membershipShells';

// A backend fault the route did not cause: when `fault.raise` is set, the
// contact writer and the topic-membership writer throw it instead of running.
const fault = vi.hoisted(() => ({ raise: null as null | (() => never) }));
vi.mock('../contacts/contactEdit', async (importOriginal) => {
	const original = await importOriginal<typeof ContactEditModule>();
	return {
		...original,
		createContactStrict: async (...args: Parameters<typeof original.createContactStrict>) => {
			if (fault.raise) fault.raise();
			return await original.createContactStrict(...args);
		},
	};
});
vi.mock('../topics/membershipShells', async (importOriginal) => {
	const original = await importOriginal<typeof MembershipShellsModule>();
	return {
		...original,
		addContactImpl: async (...args: Parameters<typeof original.addContactImpl>) => {
			if (fault.raise) fault.raise();
			return await original.addContactImpl(...args);
		},
	};
});

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
			!p.includes('files/processing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

// Every v1 scope — used to seed an "all-access" key for success-path tests.
const ALL_SCOPES = [
	'contacts:read',
	'contacts:write',
	'events:write',
	'transactional:send',
	'topics:write',
	'status:read',
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
	suffix?: string
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

/**
 * Check a response against the public contract: the operation's documented
 * success status and body, envelope included, with no undocumented field.
 */
async function expectContractSuccess(operationId: PublicOperationId, res: Response) {
	const operation = publicOperation(operationId);
	expect(res.status).toBe(operation.success.status);
	const body: unknown = await res.clone().json();
	expect(successBodySchema(operation).safeParse(body).error?.issues).toBeUndefined();
}

/**
 * Check a refusal against the public contract: its body carries `reason`, and
 * the operation documents that reason at the status the response has.
 */
function expectDocumentedReason(
	operationId: PublicOperationId,
	res: Response,
	body: { error: { data?: { reason?: unknown } } },
	reason: string
) {
	expect(body.error.data?.reason).toBe(reason);
	expect(reasonsAt(publicOperation(operationId), res.status)).toContain(reason);
}

/**
 * A JSON array nested a few thousand levels deep, still well inside the body
 * size cap: deep enough to overflow a recursive walk of the body.
 */
const DEEPLY_NESTED_JSON = `${'['.repeat(6000)}0${']'.repeat(6000)}`;

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	fault.raise = null;
	// Some handlers read SITE_URL via lib/env getOptional — keep it unset so the
	// optional read returns undefined rather than throwing.
	delete process.env['SITE_URL'];
	// Local integration deployment: opt into dev mode so cors.allowedOrigins() and
	// auth.resolveTrustedOrigins() use the loopback defaults instead of the
	// production fail-closed throw (which now requires SITE_URL/ALLOWED_ORIGINS).
	process.env['OWLAT_DEV_MODE'] = 'true';
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

	it.each([
		['no Authorization header', undefined, 'missing_credentials'],
		['a header that is not a bearer token', 'Basic a b', 'missing_credentials'],
		['a malformed key', 'Bearer lm_live_short', 'malformed_key'],
		['a well-formed but unknown key', `Bearer ${makeKey()}`, 'invalid_key'],
	])('401 names the reason for %s', async (_label, authorization, reason) => {
		const t = setupTest();
		const res = await t.fetch('/api/v1/contacts', {
			method: 'GET',
			headers: authorization === undefined ? {} : { Authorization: authorization },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.category).toBe('unauthenticated');
		expectDocumentedReason('listContacts', res, body, reason);
	});

	it('answers an unknown, a revoked and an expired key alike', async () => {
		const t = setupTest();
		const revoked = makeKey('r'.repeat(40));
		const expired = makeKey('e'.repeat(40));
		await t.run(async (ctx) => {
			for (const [key, fields] of [
				[revoked, { isActive: false }],
				[expired, { isActive: true, expiresAt: Date.now() - 1000 }],
			] as const) {
				await ctx.db.insert('apiKeys', {
					name: 'unusable',
					keyHash: await hashKey(key),
					keyPrefix: 'lm_live_',
					scopes: ['contacts:read'],
					createdAt: Date.now(),
					updatedAt: Date.now(),
					...fields,
				});
			}
		});
		const answers = [];
		for (const key of [makeKey(), revoked, expired]) {
			const res = await t.fetch('/api/v1/contacts', {
				method: 'GET',
				headers: { Authorization: `Bearer ${key}` },
			});
			answers.push({ status: res.status, body: await res.json() });
		}
		expect(answers[0]).toEqual({
			status: 401,
			body: {
				error: {
					category: 'unauthenticated',
					message: 'Invalid API key',
					data: { reason: 'invalid_key' },
				},
			},
		});
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[2]).toEqual(answers[0]);
	});

	it('429 names the failed-key throttle apart from the per-key limit', async () => {
		const t = setupTest();
		let res: Response | undefined;
		// The throttle's burst is well under 60 failures; the loop stops at the first 429.
		for (let attempt = 0; attempt < 60; attempt++) {
			res = await t.fetch('/api/v1/contacts', {
				method: 'GET',
				headers: { Authorization: `Bearer ${makeKey()}` },
			});
			if (res.status !== 401) break;
		}
		expect(res?.status).toBe(429);
		const body = await res!.json();
		expect(body.error).toEqual({
			category: 'rate_limited',
			message:
				'Too many failed API key attempts from this address. Wait for the Retry-After interval before trying again.',
			data: { reason: 'too_many_failed_attempts' },
		});
		expectDocumentedReason('listContacts', res!, body, 'too_many_failed_attempts');
		expect(Number(res!.headers.get('Retry-After'))).toBeGreaterThan(0);
		expect(res!.headers.get('X-RateLimit-Limit')).toBeNull();
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
		await expectContractSuccess('listContacts', res);
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
		await expectContractSuccess('createContact', res);
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
		const body = await res.json();
		expect(body.error).toEqual({
			category: 'invalid_input',
			message: 'Email is required',
			data: { field: 'email' },
		});
	});

	it('400 invalid_input naming the field for a malformed email', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'not-an-email' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toEqual({
			category: 'invalid_input',
			message: 'Invalid email format',
			data: { field: 'email' },
		});
	});

	it.each(['', '"__proto__":0,'])(
		'201 ignoring a deeply nested unknown field (prefix %j)',
		async (prefix) => {
			const t = setupTest();
			const key = await seedKey(t, ['contacts:write']);
			const res = await t.fetch('/api/v1/contacts', {
				method: 'POST',
				headers: authHeaders(key),
				body: `{${prefix}"email":"deep@example.com","extra":${DEEPLY_NESTED_JSON}}`,
			});
			await expectContractSuccess('createContact', res);
		}
	);

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

	it('locks the error envelope — the raw internal message (which embeds the email) never reaches the caller', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		// `createForTeam` throws `A contact with this email already exists: <email>`,
		// so the address is the sentinel that the raw internal message carries. The
		// handler must classify it and return ONLY the fixed string, never echoing
		// the address (or any other raw `error.message`) back to the API caller.
		const sentinel = 'leak-canary-7z9@sentinel.example';
		const first = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: sentinel }),
		});
		expect(first.status).toBe(201);
		const res = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: sentinel }),
		});
		expect(res.status).toBe(409);
		const raw = await res.text();
		// The fixed, non-revealing string ships…
		expect(JSON.parse(raw).error.message).toBe('A contact with this email already exists');
		// …and the sentinel from the raw internal error is nowhere in the body.
		expect(raw).not.toContain(sentinel);
		expect(raw).not.toContain('leak-canary');
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
		await expectContractSuccess('getContact', res);
		const body = await res.json();
		expect(body.data.email).toBe('by-email@example.com');
	});

	it('200 resolving the same contact by its ID', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:read']);
		const id = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'by-id@example.com' }))
		);
		const res = await t.fetch(`/api/v1/contacts/${id}`, {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		await expectContractSuccess('getContact', res);
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
				createTestContact({ email: 'erased@example.com', deletedAt: Date.now() })
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
			ctx.db.insert('contacts', createTestContact({ email: 'upd@example.com', firstName: 'Old' }))
		);
		const res = await t.fetch(`/api/v1/contacts/${id}`, {
			method: 'PUT',
			headers: authHeaders(key),
			body: JSON.stringify({ firstName: 'New' }),
		});
		expect(res.status).toBe(200);
		await expectContractSuccess('updateContact', res);
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

	it('locks the error envelope on a duplicate-email update — no raw internal message leaks', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		// Re-pointing one contact at another live contact's address makes
		// `updateForTeam` throw `A contact with this email already exists: <email>`.
		// The target address is the sentinel; the handler must reply with the fixed
		// string only.
		const sentinel = 'update-canary-4k2@sentinel.example';
		const taken = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: sentinel }),
		});
		expect(taken.status).toBe(201);
		const moverId = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'mover@example.com' }))
		);
		const res = await t.fetch(`/api/v1/contacts/${moverId}`, {
			method: 'PUT',
			headers: authHeaders(key),
			body: JSON.stringify({ email: sentinel }),
		});
		expect(res.status).toBe(409);
		const raw = await res.text();
		expect(JSON.parse(raw).error.message).toBe('A contact with this email already exists');
		expect(raw).not.toContain(sentinel);
		expect(raw).not.toContain('update-canary');
	});

	it('400 invalid_input for malformed percent-encoding in the path (not 500)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts/%E0%A4%A', {
			method: 'PUT',
			headers: authHeaders(key),
			body: JSON.stringify({ firstName: 'X' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.category).toBe('invalid_input');
		expect(body.error.message).toBe('Invalid contact ID or email format');
	});

	it('400 invalid_input naming the field when firstName is over the length cap', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const id = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'long@example.com' }))
		);
		const res = await t.fetch(`/api/v1/contacts/${id}`, {
			method: 'PUT',
			headers: authHeaders(key),
			body: JSON.stringify({ firstName: 'a'.repeat(201) }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.category).toBe('invalid_input');
		expect(body.error.message).toBe('firstName must be at most 200 characters');
		expect(body.error.data).toEqual({ field: 'firstName' });
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
			ctx.db.insert('contacts', createTestContact({ email: 'del@example.com' }))
		);
		const res = await t.fetch(`/api/v1/contacts/${id}`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		await expectContractSuccess('deleteContact', res);
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

	it('400 invalid_input for malformed percent-encoding in the path (not 500)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['contacts:write']);
		const res = await t.fetch('/api/v1/contacts/%E0%A4%A', {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.category).toBe('invalid_input');
		expect(body.error.message).toBe('Invalid contact ID or email format');
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
		await expectContractSuccess('sendEvent', res);
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
		const body = await res.json();
		expect(body.error.data).toEqual({ field: 'eventName' });
	});

	it('400 invalid_input for a nested eventProperties value', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['events:write']);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({ email: 'nest@example.com' }));
		});
		const res = await t.fetch('/api/v1/events', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({
				email: 'nest@example.com',
				eventName: 'signed_up',
				eventProperties: { plan: { tier: 'pro' } },
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.category).toBe('invalid_input');
	});

	it.each([
		['a non-ASCII character', 'café'],
		['a leading $', '$source'],
		['more than 1024 characters', 'k'.repeat(1025)],
	])(
		'400 invalid_input for an eventProperties key with %s, which Convex cannot store (not 500)',
		async (_label, propertyName) => {
			const t = setupTest();
			const key = await seedKey(t, ['events:write']);
			const res = await t.fetch('/api/v1/events', {
				method: 'POST',
				headers: authHeaders(key),
				body: JSON.stringify({
					email: 'keys@example.com',
					eventName: 'signed_up',
					createContactIfNotExists: true,
					eventProperties: { [propertyName]: 'x' },
				}),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error.category).toBe('invalid_input');
		}
	);

	it('400 invalid_input for a deeply nested eventProperties value (not 500)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['events:write']);
		const res = await t.fetch('/api/v1/events', {
			method: 'POST',
			headers: authHeaders(key),
			body: `{"email":"deep@example.com","eventName":"signed_up","eventProperties":{"bad":${DEEPLY_NESTED_JSON}}}`,
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toMatchObject({
			category: 'invalid_input',
			message: 'eventProperties must be an object of string, number, boolean or null values',
		});
	});

	it('400 invalid_input for a nested eventProperties value held under a __proto__ key', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['events:write']);
		// Raw JSON: JSON.stringify of an object literal cannot produce an own __proto__ key.
		const res = await t.fetch('/api/v1/events', {
			method: 'POST',
			headers: authHeaders(key),
			body: '{"email":"absent@example.com","eventName":"signed_up","eventProperties":{"__proto__":[1]}}',
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toMatchObject({
			category: 'invalid_input',
			message: 'eventProperties must be an object of string, number, boolean or null values',
		});
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

	it('400 invalid_input for a nested dataVariables value (not 500)', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({
				email: 'to@example.com',
				slug: 'welcome',
				dataVariables: { order: { id: 1 } },
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toEqual({
			category: 'invalid_input',
			message: 'dataVariables must be an object of string, number, boolean or null values',
			data: { field: 'dataVariables.order' },
		});
	});

	it.each([
		[{ email: 'not-an-email', slug: 'welcome' }, 'Invalid email format', 'email'],
		[
			{ email: 'to@example.com', slug: 'welcome', attachments: [{ filename: 'a.txt' }] },
			'attachments[0] must have exactly one of "content" (base64) or "url"',
			'attachments.0',
		],
		[
			{
				email: 'to@example.com',
				slug: 'welcome',
				attachments: [
					{ filename: 'a.txt', content: 'YQ==' },
					{ filename: 'b.txt', content: '%%' },
				],
			},
			'attachments[1].content is not valid base64',
			'attachments.1.content',
		],
	])('400 invalid_input naming the field: %j', async (request, message, field) => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify(request),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toEqual({ category: 'invalid_input', message, data: { field } });
	});

	it('400 invalid_input for a nested dataVariables value held under a __proto__ key', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		// Raw JSON: JSON.stringify of an object literal cannot produce an own __proto__ key.
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: '{"email":"to@example.com","slug":"no-such-template","dataVariables":{"__proto__":{"nested":true}}}',
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toMatchObject({
			category: 'invalid_input',
			message: 'dataVariables must be an object of string, number, boolean or null values',
			data: { field: 'dataVariables.__proto__' },
		});
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
		expectDocumentedReason('sendTransactional', res, body, 'template_not_found');
	});

	it.each([
		['a malformed transactionalId', async () => 'not-a-template-id'],
		['an id of another kind of record', null],
	])('404 not_found for %s (not 500)', async (_label, idOf) => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		const transactionalId = idOf
			? await idOf()
			: await t.run(async (ctx) => await ctx.db.insert('contacts', createTestContact()));
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'to@example.com', transactionalId }),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error.category).toBe('not_found');
	});

	it('403 forbidden while sending is suspended, naming the stored reason and since when', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		const changedAt = Date.UTC(2026, 10, 20, 9, 0, 0);
		const reason =
			'Auto-suspended: Gmail reports a spam rate of 0.42% for mail.example.com on 2026-11-19';
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				contactCount: 0,
				createdAt: changedAt,
				abuseStatus: 'suspended',
				abuseStatusReason: reason,
				abuseStatusChangedAt: changedAt,
			});
		});
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'to@example.com', slug: 'welcome' }),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.category).toBe('forbidden');
		expect(body.error.data).toEqual({
			reason: 'abuse_blocked',
			status: 'suspended',
			since: '2026-11-20T09:00:00.000Z',
			detail: reason,
		});
		expect(body.error.message).toBe(
			`Sending is suspended on this Owlat instance. A platform admin of this instance can lift it in the operator console. Reason: ${reason}`
		);
	});

	it('403 forbidden while the transactional feature is off', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				contactCount: 0,
				createdAt: Date.now(),
				featureFlags: { transactional: false },
			});
		});
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'to@example.com', slug: 'no-such-template' }),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.category).toBe('forbidden');
		expectDocumentedReason('sendTransactional', res, body, 'feature_disabled');
	});
});

// ─── GET /api/v1/transactional/{sendId} ──────────────────────────────────────

const SENT_AT = Date.UTC(2026, 10, 1, 9, 0, 0);

/** A send created through the transactional API, with stored data variables. */
async function seedApiSend(
	t: ReturnType<typeof convexTest>,
	fields: Record<string, unknown> = {}
): Promise<{ sendId: string; templateId: string; slug: string }> {
	return await t.run(async (ctx) => {
		const template = createTestTransactionalEmail({ slug: 'order-confirmation' });
		const templateId = await ctx.db.insert('transactionalEmails', template);
		const sendId = await ctx.db.insert('transactionalSends', {
			kind: 'transactional',
			transactionalEmailId: templateId,
			email: 'ada@example.com',
			language: 'en',
			dataVariables: { resetToken: 'secret-token-123' },
			status: 'queued',
			queuedAt: SENT_AT,
			...fields,
		} as never);
		return { sendId, templateId, slug: 'order-confirmation' };
	});
}

describe('GET /api/v1/transactional/{sendId} (getTransactionalSend → transactional:send)', () => {
	it('401 with no key', async () => {
		const t = setupTest();
		const { sendId } = await seedApiSend(t);
		const res = await t.fetch(`/api/v1/transactional/${sendId}`, { method: 'GET' });
		expect(res.status).toBe(401);
	});

	it('403 when the key lacks transactional:send', async () => {
		const t = setupTest();
		const { sendId } = await seedApiSend(t);
		const key = await seedKey(t, ['contacts:read']);
		const res = await t.fetch(`/api/v1/transactional/${sendId}`, {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.message).toContain('transactional:send');
	});

	it('200 with the status of the named send and none of its data variables', async () => {
		const t = setupTest();
		await seedApiSend(t, { email: 'other@example.com' });
		const { sendId, templateId } = await seedApiSend(t, {
			status: 'delivered',
			sentAt: SENT_AT + 1000,
			deliveredAt: SENT_AT + 2000,
		});
		const key = await seedKey(t, ['transactional:send']);
		const res = await t.fetch(`/api/v1/transactional/${sendId}`, {
			method: 'GET',
			headers: authHeaders(key),
		});
		await expectContractSuccess('getTransactionalSend', res);
		const text = await res.text();
		expect(text).not.toContain('secret-token-123');
		expect(text).not.toContain('dataVariables');
		expect(JSON.parse(text).data).toEqual({
			sendId,
			status: 'delivered',
			email: 'ada@example.com',
			templateId,
			slug: 'order-confirmation',
			language: 'en',
			queuedAt: new Date(SENT_AT).toISOString(),
			sentAt: new Date(SENT_AT + 1000).toISOString(),
			deliveredAt: new Date(SENT_AT + 2000).toISOString(),
			openedAt: null,
			clickedAt: null,
			bouncedAt: null,
			complainedAt: null,
			failedAt: null,
			bounceType: null,
			errorCode: null,
			errorMessage: null,
		});
	});

	it('names the error of a failed send', async () => {
		const t = setupTest();
		const { sendId } = await seedApiSend(t, {
			status: 'failed',
			failedAt: SENT_AT + 5000,
			errorCode: 'MTA_UNREACHABLE',
			errorMessage: 'The mail server could not be reached before the delivery deadline passed',
		});
		const key = await seedKey(t, ['transactional:send']);
		const res = await t.fetch(`/api/v1/transactional/${sendId}`, {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toMatchObject({
			status: 'failed',
			failedAt: new Date(SENT_AT + 5000).toISOString(),
			errorCode: 'MTA_UNREACHABLE',
			errorMessage: 'The mail server could not be reached before the delivery deadline passed',
		});
	});

	it('names the bounce type of a bounced send', async () => {
		const t = setupTest();
		const { sendId } = await seedApiSend(t, {
			status: 'bounced',
			bouncedAt: SENT_AT + 3000,
			bounceType: 'hard',
		});
		const key = await seedKey(t, ['transactional:send']);
		const res = await t.fetch(`/api/v1/transactional/${sendId}`, {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect((await res.json()).data).toMatchObject({ status: 'bounced', bounceType: 'hard' });
	});

	it.each([
		['an unknown send id', 'unknown'],
		['a malformed id', 'malformed'],
		['an id of another kind of record', 'contact'],
		['a send no API call created', 'automation'],
		['an erased send', 'erased'],
	])('404 not_found for %s', async (_label, kind) => {
		const t = setupTest();
		const key = await seedKey(t, ['transactional:send']);
		let id: string;
		if (kind === 'malformed') id = 'not-a-send-id';
		else if (kind === 'contact') {
			id = await t.run(async (ctx) => await ctx.db.insert('contacts', createTestContact()));
		} else if (kind === 'automation') {
			id = (await seedApiSend(t, { kind: 'automation', transactionalEmailId: undefined })).sendId;
		} else if (kind === 'erased') {
			id = (await seedApiSend(t, { deletedAt: SENT_AT, deletedBy: 'gdpr' })).sendId;
		} else {
			const { sendId } = await seedApiSend(t);
			await t.run(async (ctx) => await ctx.db.delete(sendId as never));
			id = sendId;
		}
		const res = await t.fetch(`/api/v1/transactional/${id}`, {
			method: 'GET',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(404);
		const body: unknown = await res.json();
		expect(apiErrorResponseSchema.safeParse(body).error?.issues).toBeUndefined();
		expect(body).toMatchObject({ error: { category: 'not_found' } });
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
			const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			await ctx.db.insert('contacts', createTestContact({ email: 'member@example.com' }));
			return { topicId };
		});
		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'member@example.com' }),
		});
		expect(res.status).toBe(201);
		await expectContractSuccess('addContactToTopic', res);
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
			const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
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
		await expectContractSuccess('removeContactFromTopic', res);
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
			const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'leaving@example.com' })
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
					q.eq('contactId', contactId).eq('topicId', topicId)
				)
				.first()
		);
		expect(membershipBefore).not.toBeNull();

		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts/leaving@example.com`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		await expectContractSuccess('removeContactFromTopic', res);
		const body = await res.json();
		expect(body.data.success).toBe(true);

		const membershipAfter = await t.run(async (ctx) =>
			ctx.db
				.query('contactTopics')
				.withIndex('by_contact_and_topic', (q) =>
					q.eq('contactId', contactId).eq('topicId', topicId)
				)
				.first()
		);
		expect(membershipAfter).toBeNull();
	});

	it('200 with removed:false when the contact was not in the topic', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['topics:write']);
		const { topicId } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			await ctx.db.insert('contacts', createTestContact({ email: 'notamember@example.com' }));
			return { topicId };
		});
		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts/notamember@example.com`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});
		expect(res.status).toBe(200);
		await expectContractSuccess('removeContactFromTopic', res);
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

// ─── A failure behind a write route keeps its category ───────────────────────

const FENCE_MESSAGE =
	'This workspace is being deleted. Changes are not accepted until the deletion has finished.';

describe('a write route answers a backend failure by its category, not as invalid_input', () => {
	async function seedWriteFixtures(t: ReturnType<typeof setupTest>) {
		const key = await seedKey(t, ALL_SCOPES);
		const { topicId, contactId } = await t.run(async (ctx) => ({
			topicId: await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false })),
			contactId: await ctx.db.insert('contacts', createTestContact({ email: 'held@example.com' })),
		}));
		return { key, topicId, contactId };
	}

	type Fixtures = Awaited<ReturnType<typeof seedWriteFixtures>>;
	const writeRoutes: Array<[string, (f: Fixtures) => [string, RequestInit]]> = [
		[
			'POST /contacts',
			(f) => [
				'/api/v1/contacts',
				{ method: 'POST', headers: authHeaders(f.key), body: '{"email":"fresh@example.com"}' },
			],
		],
		[
			'PUT /contacts/{id}',
			(f) => [
				`/api/v1/contacts/${f.contactId}`,
				{ method: 'PUT', headers: authHeaders(f.key), body: '{"firstName":"Renamed"}' },
			],
		],
		[
			'DELETE /contacts/{id}',
			(f) => [`/api/v1/contacts/${f.contactId}`, { method: 'DELETE', headers: authHeaders(f.key) }],
		],
		[
			'POST /events',
			(f) => [
				'/api/v1/events',
				{
					method: 'POST',
					headers: authHeaders(f.key),
					body: '{"email":"fresh@example.com","eventName":"signed_up","createContactIfNotExists":true}',
				},
			],
		],
		[
			'POST /topics/{id}/contacts',
			(f) => [
				`/api/v1/topics/${f.topicId}/contacts`,
				{ method: 'POST', headers: authHeaders(f.key), body: `{"contactId":"${f.contactId}"}` },
			],
		],
	];

	it.each(writeRoutes)(
		'%s keeps the invalid_state (422) of a write refused by the deletion fence',
		async (_name, request) => {
			const t = setupTest();
			const fixtures = await seedWriteFixtures(t);
			await t.run((ctx) => openWorkspaceDeletionFence(ctx));

			const res = await t.fetch(...request(fixtures));

			expect(res.status).toBe(422);
			const body: unknown = await res.json();
			expect(apiErrorResponseSchema.safeParse(body).error?.issues).toBeUndefined();
			expect(body).toMatchObject({
				error: {
					category: 'invalid_state',
					message: FENCE_MESSAGE,
					data: { reason: 'workspace_deletion_in_progress' },
				},
			});
		}
	);

	it('DELETE /topics/{id}/contacts/{x} keeps the invalid_state (422) of a write refused by the deletion fence', async () => {
		const t = setupTest();
		const { key, topicId, contactId } = await seedWriteFixtures(t);
		const added = await t.fetch(`/api/v1/topics/${topicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ contactId }),
		});
		expect(added.status).toBe(201);
		await t.run((ctx) => openWorkspaceDeletionFence(ctx));

		const res = await t.fetch(`/api/v1/topics/${topicId}/contacts/${contactId}`, {
			method: 'DELETE',
			headers: authHeaders(key),
		});

		expect(res.status).toBe(422);
		expect((await res.json()).error.category).toBe('invalid_state');
	});

	it.each([
		[
			'POST /events',
			'Failed to send event',
			(f: Fixtures): [string, RequestInit] => [
				'/api/v1/events',
				{
					method: 'POST',
					headers: authHeaders(f.key),
					body: '{"email":"fresh@example.com","eventName":"signed_up","createContactIfNotExists":true}',
				},
			],
		],
		[
			'POST /topics/{id}/contacts',
			'Failed to add contact to topic',
			(f: Fixtures): [string, RequestInit] => [
				`/api/v1/topics/${f.topicId}/contacts`,
				{ method: 'POST', headers: authHeaders(f.key), body: `{"contactId":"${f.contactId}"}` },
			],
		],
	])(
		'%s answers 500 internal, with a fixed message, for a throw that carries no category',
		async (_name, message, request) => {
			const t = setupTest();
			const fixtures = await seedWriteFixtures(t);
			fault.raise = () => {
				throw new Error('storage node unreachable: shard-canary-41');
			};

			const res = await t.fetch(...request(fixtures));

			expect(res.status).toBe(500);
			const raw = await res.text();
			const body: unknown = JSON.parse(raw);
			expect(apiErrorResponseSchema.safeParse(body).error?.issues).toBeUndefined();
			expect(body).toEqual({ error: { category: 'internal', message } });
			expect(raw).not.toContain('shard-canary');
		}
	);
});

// ─── GET /api/v1/status ──────────────────────────────────────────────────────

describe('GET /api/v1/status (getStatus → status:read)', () => {
	const SUSPENDED_AT = Date.UTC(2026, 10, 20, 9, 0, 0);
	const SUSPENSION_REASON =
		'Auto-suspended: Gmail reports a spam rate of 0.42% for mail.example.com on 2026-11-19';

	/**
	 * A deployment that sends through the built-in MTA from one verified
	 * domain: the roll-up reads healthy until a test adds a problem.
	 */
	async function seedInstance(
		t: ReturnType<typeof convexTest>,
		opts: {
			extraDomains?: { domain: string; status: 'pending' | 'failed'; syncError?: string }[];
			settings?: Record<string, unknown>;
			reputation?: { sent: number; bounced: number; complaints: number };
		} = {}
	) {
		for (const name of ['RESEND_API_KEY', 'AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID']) {
			delete process.env[name];
		}
		process.env['EMAIL_PROVIDER'] = 'mta';
		process.env['MTA_API_URL'] = 'http://mta:3100';
		process.env['MTA_API_KEY'] = 'mta-secret-key-canary';
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				mtaHealth: { status: 'ok', observedAt: Date.now() },
				defaultFromEmail: 'hello@mail.example.com',
				...opts.settings,
				createdAt: Date.now(),
			});
			for (const { domain, status, syncError } of [
				{ domain: 'mail.example.com', status: 'verified' as const, syncError: undefined },
				...(opts.extraDomains ?? []),
			]) {
				await ctx.db.insert('domains', {
					domain,
					status,
					dnsRecords: { spf: { type: 'TXT', host: domain, value: 'v=spf1 dns-record-canary' } },
					...(syncError ? { returnPathHostSyncError: syncError } : {}),
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
			if (opts.reputation) {
				const { sent, bounced, complaints } = opts.reputation;
				await ctx.db.insert('sendingReputation', {
					scope: 'org',
					periodStart: Date.now() - (Date.now() % 86_400_000),
					shardKey: 0,
					totalSent: sent,
					totalDelivered: sent - bounced,
					totalBounced: bounced,
					totalHardBounced: bounced,
					totalComplaints: complaints,
					lastCalculatedAt: Date.now(),
				});
			}
		});
	}

	async function readStatus(t: ReturnType<typeof convexTest>, scopes = ['status:read']) {
		const key = await seedKey(t, scopes);
		const res = await t.fetch('/api/v1/status', { method: 'GET', headers: authHeaders(key) });
		await expectContractSuccess('getStatus', res);
		return (await res.json()).data;
	}

	it('401 with no key', async () => {
		const t = setupTest();
		await seedInstance(t);
		const res = await t.fetch('/api/v1/status', { method: 'GET' });
		expect(res.status).toBe(401);
		expectDocumentedReason('getStatus', res, await res.json(), 'missing_credentials');
	});

	it('403 for a key that can only send', async () => {
		const t = setupTest();
		await seedInstance(t);
		const key = await seedKey(t, ['transactional:send']);
		const res = await t.fetch('/api/v1/status', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.data).toEqual({ reason: 'missing_scope', scope: 'status:read' });
		expectDocumentedReason('getStatus', res, body, 'missing_scope');
	});

	it('reports a healthy instance with its domains, no rates yet and nothing held', async () => {
		const t = setupTest();
		await seedInstance(t);
		expect(await readStatus(t)).toEqual({
			level: 'ok',
			reasonCode: 'healthy',
			explanation: 'Sending is healthy and no check blocks or warns right now.',
			fix: null,
			domains: [{ domain: 'mail.example.com', status: 'verified' }],
			rates: null,
			sendingHold: null,
		});
	});

	it('names a failed domain, what it means and where it is fixed', async () => {
		const t = setupTest();
		await seedInstance(t, { extraDomains: [{ domain: 'news.example.com', status: 'failed' }] });
		const status = await readStatus(t);
		expect(status).toMatchObject({
			level: 'error',
			reasonCode: 'domain_failed',
			fix: { route: '/dashboard/admin/delivery/domains', who: 'workspace_admin' },
		});
		expect(status.explanation).toContain('A sending domain failed setup or DNS verification');
		expect(status.domains).toEqual([
			{ domain: 'mail.example.com', status: 'verified' },
			{ domain: 'news.example.com', status: 'failed' },
		]);
	});

	it('flags the 30-day bounce and complaint rates that are over their limits', async () => {
		const t = setupTest();
		await seedInstance(t, { reputation: { sent: 1000, bounced: 60, complaints: 2 } });
		const status = await readStatus(t);
		expect(status.rates).toEqual({
			windowDays: 30,
			sent: 1000,
			bounce: { ratePct: 6, limitPct: 2, isOver: true },
			complaint: { ratePct: 0.2, limitPct: 0.1, isOver: true },
		});
		expect(status.level).not.toBe('ok');
		expect(status.reasonCode).toMatch(/^reputation_/);
	});

	it('leaves rates under their limits unflagged', async () => {
		const t = setupTest();
		await seedInstance(t, { reputation: { sent: 1000, bounced: 10, complaints: 0 } });
		expect((await readStatus(t)).rates).toMatchObject({
			bounce: { ratePct: 1, isOver: false },
			complaint: { ratePct: 0, isOver: false },
		});
	});

	it("returns a suspension's status, stored reason and since-when in the transactional 403's shape", async () => {
		const t = setupTest();
		await seedInstance(t, {
			settings: {
				abuseStatus: 'suspended',
				abuseStatusReason: SUSPENSION_REASON,
				abuseStatusChangedAt: SUSPENDED_AT,
				abuseStatusChangedBy: 'system',
			},
		});
		const status = await readStatus(t, ['status:read', 'transactional:send']);
		expect(status).toMatchObject({
			level: 'error',
			reasonCode: 'sending_suspended',
			fix: { route: '/dashboard/admin/operator', who: 'platform_admin' },
			sendingHold: {
				status: 'suspended',
				since: '2026-11-20T09:00:00.000Z',
				detail: SUSPENSION_REASON,
			},
		});

		const key = await seedKey(t, ['transactional:send'], 'send'.repeat(10));
		const refused = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'to@example.com', slug: 'welcome' }),
		});
		const { reason, ...hold } = (await refused.json()).error.data;
		expect(reason).toBe('abuse_blocked');
		expect(status.sendingHold).toEqual(hold);
	});

	it('keeps no stale reason once sending is allowed again', async () => {
		const t = setupTest();
		await seedInstance(t, {
			settings: {
				abuseStatus: 'clean',
				abuseStatusReason: SUSPENSION_REASON,
				abuseStatusChangedAt: SUSPENDED_AT,
			},
		});
		expect((await readStatus(t)).sendingHold).toBeNull();
	});

	it('carries nothing a member cannot see: no DNS records, sync errors or provider settings', async () => {
		const t = setupTest();
		await seedInstance(t, {
			extraDomains: [
				{ domain: 'news.example.com', status: 'pending', syncError: 'mta-sync-error-canary' },
			],
		});
		// The deployment serves one organization, so there is no other workspace
		// whose rows could leak; what is left to rule out is admin-only data.
		const key = await seedKey(t, ['status:read']);
		const res = await t.fetch('/api/v1/status', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(200);
		const text = await res.text();
		for (const canary of ['dns-record-canary', 'mta-sync-error-canary', 'mta-secret-key-canary']) {
			expect(text).not.toContain(canary);
		}
		expect(text).not.toContain('dnsRecords');
		expect(text).not.toContain('http://mta:3100');
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
		await expectContractSuccess('listContacts', list);

		// contacts:write (create a fresh contact)
		const create = await t.fetch('/api/v1/contacts', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'omni-new@example.com' }),
		});
		await expectContractSuccess('createContact', create);

		// topics:write
		const addToTopic = await t.fetch(`/api/v1/topics/${topicId}/contacts`, {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'omni@example.com' }),
		});
		await expectContractSuccess('addContactToTopic', addToTopic);
	});
});

// ─── The public contract ────────────────────────────────────────────────────

/** The handler each contract operation routes to. */
const HANDLERS: Record<PublicOperationId, unknown> = {
	getHealth: healthCheck,
	listContacts: contactsApi.listContacts,
	createContact: contactsApi.createContact,
	getContact: contactsApi.getContact,
	updateContact: contactsApi.updateContact,
	deleteContact: contactsApi.deleteContact,
	sendEvent,
	sendTransactional,
	getTransactionalSend,
	addContactToTopic,
	removeContactFromTopic,
	getStatus,
};

/** A concrete path for a contract path template: each `{param}` gets a sample value. */
const concretePath = (template: string) => template.replace(/\{\w+\}/g, 'k57sample000000000');

describe('the public contract (@owlat/public-contract)', () => {
	const router = httpRouter();
	registerPublicApiRoutes(router);

	it('routes every documented operation to its handler', () => {
		for (const operation of PUBLIC_OPERATIONS) {
			const match = router.lookup(concretePath(operation.path), operation.method);
			expect(match?.[0], operation.operationId).toBe(HANDLERS[operation.operationId]);
		}
	});

	it('documents every route other than the CORS preflights', () => {
		for (const [path, method] of router.getRoutes()) {
			if (method === 'OPTIONS') continue;
			const documented = PUBLIC_OPERATIONS.some(
				(operation) =>
					operation.method === method &&
					router.lookup(concretePath(operation.path), operation.method)?.[2] === path
			);
			expect(documented, `${method} ${path}`).toBe(true);
		}
	});

	it('enforces the scope each keyed operation documents, with the documented error body', async () => {
		const t = setupTest();
		const keyed = PUBLIC_OPERATIONS.filter((operation) => operation.scope !== null);
		for (const [index, operation] of keyed.entries()) {
			const key = await seedKey(
				t,
				ALL_SCOPES.filter((scope) => scope !== operation.scope),
				`scope${index}${'a'.repeat(40)}`
			);
			const res = await t.fetch(concretePath(operation.path), {
				method: operation.method,
				headers: authHeaders(key),
				...(operation.request ? { body: JSON.stringify({ email: 'ada@example.com' }) } : {}),
			});
			expect(res.status, operation.operationId).toBe(403);
			const body = await res.json();
			expect(apiErrorResponseSchema.safeParse(body).error?.issues).toBeUndefined();
			expect(body.error.data, operation.operationId).toEqual({
				reason: 'missing_scope',
				scope: operation.scope,
			});
			expectDocumentedReason(operation.operationId, res, body, 'missing_scope');
		}
	});

	it('declares exactly the refusals the send route answers with', () => {
		// The route's refusal table is keyed by DispatchRejectionReason, so this
		// also keeps it in step with the contract's list.
		expectTypeOf<DispatchRejectionReason>().toEqualTypeOf<TransactionalRefusalReason>();
	});

	it('declares exactly the reason codes the delivery-health roll-up names', () => {
		// The status route returns the roll-up's code as is, so a reason added to
		// the roll-up must be added to the contract's enum, and the other way round.
		expect([...DELIVERY_STATUS_REASONS]).toEqual([...DELIVERY_HEALTH_REASONS]);
		expectTypeOf<DeliveryStatusReason>().toEqualTypeOf<(typeof DELIVERY_HEALTH_REASONS)[number]>();
		expectTypeOf<DeliveryStatusLevel>().toEqualTypeOf<DeliveryHealthLevel>();
		expectTypeOf<DeliveryFixAudience>().toEqualTypeOf<DeliveryHealthFixAudience>();
		expectTypeOf<SendingDomainStatusValue>().toEqualTypeOf<DomainStatus>();
	});

	it('answers the health probe with the documented body', async () => {
		const t = setupTest();
		const res = await t.fetch('/api/v1/health', { method: 'GET' });
		await expectContractSuccess('getHealth', res);
	});

	it('answers a malformed body with the documented error body', async () => {
		const t = setupTest();
		const key = await seedKey(t, ALL_SCOPES);
		const res = await t.fetch('/api/v1/transactional', {
			method: 'POST',
			headers: authHeaders(key),
			body: JSON.stringify({ email: 'ada@example.com', slug: 'welcome', dataVariables: { a: [] } }),
		});
		expect(res.status).toBe(400);
		const body: unknown = await res.json();
		expect(apiErrorResponseSchema.safeParse(body).error?.issues).toBeUndefined();
		expect(body).toMatchObject({
			error: {
				category: 'invalid_input',
				message: 'dataVariables must be an object of string, number, boolean or null values',
			},
		});
	});
});
