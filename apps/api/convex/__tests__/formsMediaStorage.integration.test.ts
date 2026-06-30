/**
 * Integration tests for the public form-submission HTTP boundary plus the
 * media-asset / storage validation surfaces.
 *
 * Three surfaces under test:
 *
 *   1. POST /forms/{formId}  (forms/apiHttp.ts:submitForm → forms/submission.ts)
 *      driven through `t.fetch(...)` so the real `http.ts` routing, the
 *      `publicTokenEndpoint` shell (CORS / method / rate-limit / body parse),
 *      and the `submit` internal mutation all run. The rateLimiter component
 *      is registered (the form route consumes the `formSubmission` bucket).
 *
 *   2. mediaAssets.create — extension + MIME allowlist gate + role gate
 *      (`media:manage` = admin). getStats totals + cap saturation.
 *
 *   3. storage.getUrl / storage.deleteFile — the auth gates (logged-in vs
 *      admin) on obtaining / deleting a storage URL.
 *
 * The session module is mocked the same way the chat test does it: a single
 * hoisted `sessionMock` whose role the helpers below flip, so admin and
 * non-admin paths are both reachable while the REAL pure permission functions
 * (`hasPermission`, `requirePermission`) still run.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestTopic, createTestContact } from './factories';

// Mutable mocked session — role flips between admin (owner/admin) and editor so
// the `media:manage` / admin gates are both exercised. The REAL `hasPermission`
// / `requirePermission` pure functions stay live via `...actual`.
const sessionMock = vi.hoisted(() => ({
	user: { id: 'test-user', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.user.id),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireOrgPermission: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: sessionMock.user.id,
			issuer: 'test',
			tokenIdentifier: `test|${sessionMock.user.id}`,
		}),
		// storage.deleteFile calls requireAdminContext directly; its real impl
		// calls the (un-mocked-internally) requireOrgMember, so mock it here.
		requireAdminContext: vi.fn().mockImplementation(async () => {
			if (sessionMock.user.role === 'editor') {
				throw new Error('Only owners and admins can perform this action');
			}
			return { userId: sessionMock.user.id, role: sessionMock.user.role };
		}),
	};
});

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

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'owner') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	setUser('test-user', 'owner');
	// Default: no trusted proxy → getClientIp returns 'unknown'; the form's
	// ip+token key isolates each form to its own bucket regardless.
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
	delete process.env['SITE_URL'];
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
	vi.clearAllMocks();
});

// ─── Form seeding ────────────────────────────────────────────────────────────

interface SeedFormOpts {
	isActive?: boolean;
	topicId?: Id<'topics'>;
	doubleOptIn?: boolean;
	redirectUrl?: string;
	honeypotFieldName?: string;
	fields?: Array<{ key: string; label: string; type: 'email' | 'text' | 'checkbox'; required: boolean }>;
}

async function seedForm(
	t: TestConvex<typeof schema>,
	opts: SeedFormOpts = {},
): Promise<Id<'formEndpoints'>> {
	const now = Date.now();
	return await t.run(async (ctx) =>
		ctx.db.insert('formEndpoints', {
			name: 'Newsletter Signup',
			topicId: opts.topicId,
			fields: opts.fields ?? [
				{ key: 'email', label: 'Email', type: 'email', required: true },
			],
			redirectUrl: opts.redirectUrl,
			honeypotFieldName: opts.honeypotFieldName,
			isActive: opts.isActive ?? true,
			doubleOptIn: opts.doubleOptIn,
			submissionCount: 0,
			createdAt: now,
			updatedAt: now,
		} as never),
	);
}

// ============================================================================
// POST /forms/{formId}  — submitForm
// ============================================================================

describe('submitForm (POST /forms/{formId})', () => {
	it('accepts a valid submission to an active no-topic form (200, ok:true JSON)', async () => {
		const t = setupTest();
		const formId = await seedForm(t);

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'subscriber@example.com', firstName: 'Sub' }),
		});

		// No redirectUrl configured → JSON success envelope (action mode).
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; data: { message: string } };
		expect(json.ok).toBe(true);
		expect(json.data.message).toBe('Form submitted successfully');

		// A formSubmissions row landed with status 'success' (no topic → created).
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.status).toBe('success');
			expect(rows[0]!.formEndpointId).toBe(formId);
			const form = await ctx.db.get(formId);
			expect(form!.submissionCount).toBe(1);
			expect(form!.successfulSubmissionCount).toBe(1);
		});
	});

	it('302-redirects to the form redirectUrl on success when one is configured', async () => {
		const t = setupTest();
		const formId = await seedForm(t, { redirectUrl: 'https://example.com/thanks' });

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'redir@example.com' }),
			redirect: 'manual',
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('https://example.com/thanks');
	});

	it('does NOT 302 to an unsafe redirectUrl — falls back to the JSON envelope', async () => {
		const t = setupTest();
		// javascript: scheme is rejected by isSafeRedirectUrl → buildRedirect null.
		const formId = await seedForm(t, { redirectUrl: 'javascript:alert(1)' });

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'safe@example.com' }),
			redirect: 'manual',
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean };
		expect(json.ok).toBe(true);
	});

	it('rejects an unknown form id (404)', async () => {
		const t = setupTest();
		// A real-but-deleted formEndpoints id → validator-acceptable, row absent.
		const ghostId = await seedForm(t);
		await t.run(async (ctx) => ctx.db.delete(ghostId));

		const res = await t.fetch(`/forms/${ghostId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'nobody@example.com' }),
		});

		expect(res.status).toBe(404);
		const json = (await res.json()) as { error: { category: string } };
		expect(json.error).toBeDefined();
		// No submission row written for a missing form.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows).toHaveLength(0);
		});
	});

	it('rejects an inactive form (403) without writing a row', async () => {
		const t = setupTest();
		const formId = await seedForm(t, { isActive: false });

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'inactive@example.com' }),
		});

		expect(res.status).toBe(403);
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows).toHaveLength(0);
		});
	});

	it('records an invalid submission (200 success envelope, status invalid) when the required email is missing', async () => {
		const t = setupTest();
		const formId = await seedForm(t);

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			// Required email field omitted.
			body: JSON.stringify({ firstName: 'NoEmail' }),
		});

		// submit() returns ok:true action:'invalid' → the HTTP shell maps that to
		// a 400 validation_error (the action-mode failure boundary).
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { category: string; data?: { reason: string } } };
		expect(json.error.category).toBe('invalid_input');

		// A row is still recorded (status 'invalid') — submit() always writes.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.status).toBe('invalid');
		});
	});

	it('rejects a malformed email (400) and records it as invalid', async () => {
		const t = setupTest();
		const formId = await seedForm(t);

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'not-an-email' }),
		});

		expect(res.status).toBe(400);
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.status).toBe('invalid');
		});
	});

	it('flags a honeypot-tripped submission as spam but returns a benign 200', async () => {
		const t = setupTest();
		const formId = await seedForm(t, { honeypotFieldName: '_hp_field' });

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'bot@example.com', _hp_field: 'i-am-a-bot' }),
		});

		// Honeypot path returns action 'spam' which the shell maps to a benign
		// success envelope (no redirectUrl here) — bots get no signal.
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean };
		expect(json.ok).toBe(true);
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.status).toBe('spam');
		});
	});

	it('yields pending_confirmation for a DOI topic form (confirmationRequired in JSON)', async () => {
		const t = setupTest();
		const topicId = await t.run(async (ctx) =>
			ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }) as never),
		);
		const formId = await seedForm(t, { topicId });

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'doi-signup@example.com' }),
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; data: { confirmationRequired?: boolean; message: string } };
		expect(json.ok).toBe(true);
		expect(json.data.confirmationRequired).toBe(true);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.status).toBe('pending_confirmation');
			// The DOI confirmation token is persisted on the submission row.
			expect(rows[0]!.confirmationToken).toBeDefined();
		});
	});

	it('forces pending_confirmation when the FORM toggles doubleOptIn on a non-DOI topic', async () => {
		const t = setupTest();
		const topicId = await t.run(async (ctx) =>
			ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }) as never),
		);
		const formId = await seedForm(t, { topicId, doubleOptIn: true });

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'force-doi@example.com' }),
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; data: { confirmationRequired?: boolean } };
		expect(json.data.confirmationRequired).toBe(true);
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows[0]!.status).toBe('pending_confirmation');
		});
	});

	it('accepts a urlencoded body (formData parser path)', async () => {
		const t = setupTest();
		const formId = await seedForm(t);

		const res = await t.fetch(`/forms/${formId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'email=urlencoded%40example.com&firstName=Url',
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean };
		expect(json.ok).toBe(true);
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('formSubmissions').collect();
			expect(rows[0]!.status).toBe('success');
			expect(rows[0]!.data['email']).toBe('urlencoded@example.com');
		});
	});

	it('rate-limits after the formSubmission bucket (5/min) is drained → 429', async () => {
		const t = setupTest();
		const formId = await seedForm(t);

		const body = JSON.stringify({ email: 'flood@example.com' });
		const post = () =>
			t.fetch(`/forms/${formId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
			});

		// formSubmission: fixed window 5/min. The first 5 succeed; the 6th 429s.
		// All share the same ip+token key ('unknown:<formId>') with no proxy set.
		for (let i = 0; i < 5; i++) {
			const ok = await post();
			expect(ok.status).toBe(200);
		}
		const limited = await post();
		expect(limited.status).toBe(429);
		expect(limited.headers.get('Retry-After')).toBeTruthy();
	});

	it('isolates the rate-limit bucket per form id (ip+token key)', async () => {
		const t = setupTest();
		const formA = await seedForm(t);
		const formB = await seedForm(t);

		const drain = async (id: Id<'formEndpoints'>) => {
			for (let i = 0; i < 5; i++) {
				const res = await t.fetch(`/forms/${id}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ email: `f${i}@example.com` }),
				});
				expect(res.status).toBe(200);
			}
		};

		await drain(formA);
		// formA is now over its window...
		const aLimited = await t.fetch(`/forms/${formA}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'a-extra@example.com' }),
		});
		expect(aLimited.status).toBe(429);

		// ...but formB still has its own full window.
		const bFirst = await t.fetch(`/forms/${formB}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'b-first@example.com' }),
		});
		expect(bFirst.status).toBe(200);
	});

	it('returns 204 for the CORS preflight (OPTIONS)', async () => {
		const t = setupTest();
		const formId = await seedForm(t);
		const res = await t.fetch(`/forms/${formId}`, { method: 'OPTIONS' });
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
	});

	it('does not route a GET on the form path (only OPTIONS + POST are registered → 404)', async () => {
		const t = setupTest();
		const formId = await seedForm(t);
		// Only `/forms/` OPTIONS + POST routes exist in http.ts; a GET matches no
		// route, so the Convex HTTP router returns a 404 (the shell's 405 method
		// gate is never reached because no handler is registered for GET).
		const res = await t.fetch(`/forms/${formId}`, { method: 'GET' });
		expect(res.status).toBe(404);
	});
});

// ============================================================================
// mediaAssets.create — extension / MIME allowlist + role gate
// ============================================================================

/** Store a small blob and return its `_storage` id so create() can resolve a URL. */
async function storeBlob(t: TestConvex<typeof schema>, bytes = 16): Promise<Id<'_storage'>> {
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(bytes).fill(1)], { type: 'image/png' })),
	);
}

describe('mediaAssets.create', () => {
	it('accepts a valid image (allowed extension + MIME)', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);

		const assetId = await t.mutation(api.mediaAssets.create, {
			storageId,
			filename: 'logo.png',
			mimeType: 'image/png',
			fileSize: 16,
		});

		expect(assetId).toBeDefined();
		await t.run(async (ctx) => {
			const asset = await ctx.db.get(assetId);
			expect(asset).toBeDefined();
			expect(asset!.filename).toBe('logo.png');
			expect(asset!.uploadedBy).toBe('test-user');
		});
	});

	it('accepts SVG (media library re-allows it on top of the scanner default)', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);

		const assetId = await t.mutation(api.mediaAssets.create, {
			storageId,
			filename: 'icon.svg',
			mimeType: 'image/svg+xml',
			fileSize: 16,
		});
		expect(assetId).toBeDefined();
	});

	it('rejects a disallowed extension', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);

		await expect(
			t.mutation(api.mediaAssets.create, {
				storageId,
				filename: 'data.psd',
				mimeType: 'image/png',
				fileSize: 16,
			}),
		).rejects.toThrow(/File type not allowed/);
	});

	it('rejects an executable extension', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);

		await expect(
			t.mutation(api.mediaAssets.create, {
				storageId,
				filename: 'malware.exe',
				mimeType: 'image/png',
				fileSize: 16,
			}),
		).rejects.toThrow(/Executable files are not allowed/);
	});

	it('rejects a double-extension disguised executable', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);

		await expect(
			t.mutation(api.mediaAssets.create, {
				storageId,
				filename: 'invoice.pdf.exe',
				mimeType: 'application/pdf',
				fileSize: 16,
			}),
		).rejects.toThrow(/File rejected/);
	});

	it('rejects a disallowed MIME type (extension ok, MIME bad)', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);

		await expect(
			t.mutation(api.mediaAssets.create, {
				storageId,
				filename: 'logo.png',
				mimeType: 'application/x-msdownload',
				fileSize: 16,
			}),
		).rejects.toThrow(/MIME type not allowed/);
	});

	it('rejects creation by a non-admin (editor) — media:manage is admin-only', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);
		setUser('editor-user', 'editor');

		await expect(
			t.mutation(api.mediaAssets.create, {
				storageId,
				filename: 'logo.png',
				mimeType: 'image/png',
				fileSize: 16,
			}),
		).rejects.toThrow(/Only owners and admins/);
	});

	// `create` enforces the advertised per-file size ceiling synchronously on the
	// client-claimed `fileSize` (in addition to the async scanAssetBytes →
	// reconcileAssetSize blob-size reconciliation that guards against
	// under-reporting). An oversize create is rejected at the gate.
	it('rejects a create whose client fileSize exceeds the upload limit', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);

		await expect(
			t.mutation(api.mediaAssets.create, {
				storageId,
				filename: 'logo.png',
				mimeType: 'image/png',
				fileSize: 999_000_000, // far over the 50 MB ceiling
			}),
		).rejects.toThrow(/upload limit/);
	});

	it('accepts a create whose client fileSize is within the upload limit', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);

		const assetId = await t.mutation(api.mediaAssets.create, {
			storageId,
			filename: 'logo.png',
			mimeType: 'image/png',
			fileSize: 16,
		});
		expect(assetId).toBeDefined();
	});
});

// ============================================================================
// mediaAssets.getStats — totals + cap
// ============================================================================

describe('mediaAssets.getStats', () => {
	it('returns { totalCount, totalBytes, truncated:false } for a small library', async () => {
		const t = setupTest();
		const sa = await storeBlob(t);
		const sb = await storeBlob(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mediaAssets', {
				storageId: sa,
				filename: 'a.png',
				mimeType: 'image/png',
				fileSize: 100,
				url: 'https://example.com/a.png',
				uploadedBy: 'test-user',
				searchableText: 'a',
				createdAt: now,
				updatedAt: now,
			} as never);
			await ctx.db.insert('mediaAssets', {
				storageId: sb,
				filename: 'b.png',
				mimeType: 'image/png',
				fileSize: 250,
				url: 'https://example.com/b.png',
				uploadedBy: 'test-user',
				searchableText: 'b',
				createdAt: now,
				updatedAt: now,
			} as never);
		});

		const stats = await t.query(api.mediaAssets.getStats, {});
		expect(stats.totalCount).toBe(2);
		expect(stats.totalBytes).toBe(350);
		expect(stats.truncated).toBe(false);
	});

	it('returns zeroes for an empty library', async () => {
		const t = setupTest();
		const stats = await t.query(api.mediaAssets.getStats, {});
		expect(stats).toEqual({ totalCount: 0, totalBytes: 0, truncated: false });
	});
});

// ============================================================================
// storage.getUrl / storage.deleteFile — auth gates
// ============================================================================

describe('storage.getUrl', () => {
	it('returns a URL for a storageId backed by a mediaAsset', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mediaAssets', {
				storageId,
				filename: 'owned.png',
				mimeType: 'image/png',
				fileSize: 16,
				url: 'https://example.com/owned.png',
				uploadedBy: 'test-user',
				searchableText: 'owned',
				createdAt: now,
				updatedAt: now,
			} as never);
		});

		const url = await t.query(api.storage.getUrl, { storageId });
		// convex-test resolves stored blobs to a (mock) URL string.
		expect(url).toBeTruthy();
		expect(typeof url).toBe('string');
	});

	it('rejects (404) a storageId with no owning mediaAsset — cross-resource IDOR guard', async () => {
		const t = setupTest();
		// Authenticated member, but the blob is backed by no media asset (e.g. a
		// mail body/raw blob). Auth alone must NOT mint its signed URL.
		const storageId = await storeBlob(t);

		await expect(
			t.query(api.storage.getUrl, { storageId }),
		).rejects.toThrow(/File/);
	});
});

describe('storage.deleteFile', () => {
	it('rejects a non-admin (editor) caller', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);
		setUser('editor-user', 'editor');

		await expect(
			t.mutation(api.storage.deleteFile, { storageId }),
		).rejects.toThrow(/Only owners and admins/);
	});

	it('rejects an admin when the blob is owned by no mediaAsset (404)', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);
		// Admin role, but no owning row references this storageId.
		await expect(
			t.mutation(api.storage.deleteFile, { storageId }),
		).rejects.toThrow(/File/);
	});

	it('deletes the blob for an admin when a mediaAsset owns it', async () => {
		const t = setupTest();
		const storageId = await storeBlob(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mediaAssets', {
				storageId,
				filename: 'owned.png',
				mimeType: 'image/png',
				fileSize: 16,
				url: 'https://example.com/owned.png',
				uploadedBy: 'test-user',
				searchableText: 'owned',
				createdAt: now,
				updatedAt: now,
			} as never);
		});

		// Owner role (admin) + owning asset → delete succeeds (no throw).
		await t.mutation(api.storage.deleteFile, { storageId });

		await t.run(async (ctx) => {
			const blob = await ctx.storage.get(storageId);
			expect(blob).toBeNull();
		});
	});
});
