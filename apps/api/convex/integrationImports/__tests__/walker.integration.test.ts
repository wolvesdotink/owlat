/**
 * Integration import walker — integration tests.
 *
 * Drives `startIntegrationImport` (config + topic + no-running gate checks)
 * and `processIntegrationPage` (the page-by-page action) with stubbed
 * `global.fetch`. The action is invoked directly via `t.action()` —
 * convex-test's `finishInProgressScheduledFunctions()` is unreliable for
 * scheduled internal-actions, so we seed the row and exercise the action
 * end-to-end without going through the scheduler.
 *
 * Asserts:
 *   - `startIntegrationImport` enforces the no-running gate, the
 *     adapter's `validateConfig`, and the topic-id existence check.
 *   - `processIntegrationPage` happy-path imports contacts via
 *     `importBatch`, accumulates counters, and ends in `'completed'`.
 *   - `defaultDoiAttest` threads through to `importBatch` (assertable
 *     via the resulting `contacts.doiStatus = 'confirmed'`).
 *   - Cancellation short-circuits the next scheduled hop.
 *   - Per-page `RetryableProviderError` retries up to MAX_RETRIES, then
 *     fails.
 *   - Non-retryable `Error` fails the import immediately.
 *
 * Per ADR-0027.
 */

import { convexTest } from 'convex-test';
import { enableFeatures } from '../../__tests__/factories';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';

// `ctx.db.get(importId)` widens across all docs in convex-test's generic ctx;
// callsite cast keeps assertions readable.
function asImport(row: unknown): Doc<'integrationImports'> {
	return row as Doc<'integrationImports'>;
}

// Convex mutations + the seeded user gate every public mutation; stub the
// session helper to a known owner role so the walker's permission check
// passes without needing a real BetterAuth row.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		// Migrated walker handlers gate via requireOrgPermission; run the real
		// role→permission map against the mocked owner role so the check passes
		// without a BetterAuth session.
		requireOrgPermission: vi.fn().mockImplementation(
			async (_ctx: unknown, permission: string, message?: string) => {
				const mod: typeof import('../../lib/sessionOrganization') =
					actual as typeof import('../../lib/sessionOrganization');
				mod.requirePermission(
					mod.hasPermission(
						'owner' as Parameters<typeof mod.hasPermission>[0],
						permission as Parameters<typeof mod.hasPermission>[1],
					),
					message,
				);
				return { userId: 'test-user', role: 'owner' as const };
			},
		),
	};
});

// Vite canonicalizes glob keys for files in this same subtree: a sibling
// at convex/integrationImports/X is keyed as '../X' rather than
// '../../integrationImports/X'. convex-test computes its lookup prefix
// from '../../_generated/...', so the canonicalized keys would never
// match. Re-prefix the canonicalized half.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.map(([key, val]) => {
			if (key.startsWith('../') && !key.startsWith('../../')) {
				return ['../../integrationImports/' + key.slice(3), val] as [
					string,
					typeof val,
				];
			}
			return [key, val] as [string, typeof val];
		})
		.filter(
			([path]) =>
				// Exclude long-running agent/LLM/email modules that the test
				// harness can't load (network calls, optional native deps).
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

const VALID_MAILCHIMP_CONFIG = {
	provider: 'mailchimp' as const,
	apiKey: 'abc-us21',
	listId: 'list_1',
};

function mailchimpPageResponse(
	emails: string[],
	totalItems: number,
): Response {
	return new Response(
		JSON.stringify({
			members: emails.map((email) => ({
				email_address: email,
				status: 'subscribed',
				merge_fields: { FNAME: email.split('@')[0]!, LNAME: 'Last' },
			})),
			total_items: totalItems,
		}),
		{ status: 200 },
	);
}

async function seedRunningImport(
	t: ReturnType<typeof convexTest>,
	overrides: Partial<Doc<'integrationImports'>> = {},
): Promise<Id<'integrationImports'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('integrationImports', {
			provider: 'mailchimp',
			status: 'running',
			cursor: '',
			imported: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
			errors: [],
			handleDuplicates: 'skip',
			startedAt: Date.now(),
			...overrides,
		});
	});
}

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

// ─── startIntegrationImport — input validation ──────────────────────────────

describe('startIntegrationImport — validation gates', () => {
	it('refuses when the provider feature flag is disabled', async () => {
		const t = convexTest(schema, modules);
		// No enableFeatures call — imports.mailchimp defaults to off.
		await expect(
			t.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: VALID_MAILCHIMP_CONFIG,
				handleDuplicates: 'skip',
			}),
		).rejects.toThrow(/imports\.mailchimp/);
	});

	it('rejects malformed mailchimp config via adapter.validateConfig', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		await expect(
			t.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: { provider: 'mailchimp', apiKey: 'no-datacenter', listId: 'x' },
				handleDuplicates: 'skip',
			}),
		).rejects.toThrow(/Invalid Mailchimp API key/);
	});

	it('rejects unknown topicId', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		// Build a syntactically-valid id by inserting+removing to obtain
		// a stale id from a deleted row.
		const fakeTopicId: Id<'topics'> = await t.run(async (ctx) => {
			const id = await ctx.db.insert('topics', {
				name: 'temp',
				requireDoubleOptIn: false,
				createdAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		await expect(
			t.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: VALID_MAILCHIMP_CONFIG,
				handleDuplicates: 'skip',
				topicId: fakeTopicId,
			}),
		).rejects.toThrow(/Topic not found/);
	});

	it('refuses when an import is already running', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		await seedRunningImport(t);
		await expect(
			t.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: VALID_MAILCHIMP_CONFIG,
				handleDuplicates: 'skip',
			}),
		).rejects.toThrow(/already running/);
	});

	it('inserts running row and returns importId on happy path', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		global.fetch = vi
			.fn()
			.mockImplementation(() => mailchimpPageResponse([], 0));

		const importId = await t.mutation(
			api.integrationImports.walker.startIntegrationImport,
			{
				config: VALID_MAILCHIMP_CONFIG,
				handleDuplicates: 'skip',
			},
		);

		expect(importId).toBeDefined();
		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			expect(row.provider).toBe('mailchimp');
			// status is 'running' immediately after insertion; the scheduled
			// hop is what flips it to 'completed'. Convex-test's
			// finishInProgressScheduledFunctions does not reliably drain
			// scheduled actions, so we don't assert downstream state here.
			expect(row.cursor).toBe('');
			expect(row.imported).toBe(0);
		});
	});
});

// ─── processIntegrationPage — happy path (direct action invocation) ─────────

describe('processIntegrationPage — happy path with terminal page', () => {
	it('imports rows, accumulates counters, and ends at completed', async () => {
		const t = convexTest(schema, modules);
		global.fetch = vi
			.fn()
			.mockImplementation(() =>
				mailchimpPageResponse(['alice@example.com', 'bob@example.com'], 2),
			);

		const importId = await seedRunningImport(t);

		await t.action(
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: VALID_MAILCHIMP_CONFIG,
				cursor: '',
			},
		);

		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			expect(row.status).toBe('completed');
			expect(row.imported).toBe(2);
			expect(row.completedAt).toBeDefined();
			// Total estimate propagated from Mailchimp's `total_items`.
			expect(row.totalEstimate).toBe(2);
		});

		// Verify contacts actually got inserted via importBatch.
		await t.run(async (ctx) => {
			const contacts = await ctx.db.query('contacts').collect();
			const emails = contacts.map((c) => c.email).sort();
			expect(emails).toEqual(['alice@example.com', 'bob@example.com']);
		});
	});
});

// ─── processIntegrationPage — multi-page sequence ───────────────────────────

describe('processIntegrationPage — multi-page sequence', () => {
	it('returns non-null nextCursor on full page; null on partial page', async () => {
		const t = convexTest(schema, modules);
		// Page 1: 100 members (full) → walker patches cursor to "100".
		const page1Emails = Array.from({ length: 100 }, (_, i) => `u${i}@example.com`);
		global.fetch = vi.fn().mockImplementation(() => mailchimpPageResponse(page1Emails, 150));

		const importId = await seedRunningImport(t);
		await t.action(
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: VALID_MAILCHIMP_CONFIG,
				cursor: '',
			},
		);

		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			// Full page → next hop scheduled, status still running.
			expect(row.status).toBe('running');
			expect(row.imported).toBe(100);
			expect(row.cursor).toBe('100');
		});

		// Page 2: 50 members (partial) → walker completes.
		const page2Emails = Array.from({ length: 50 }, (_, i) => `v${i}@example.com`);
		global.fetch = vi.fn().mockImplementation(() => mailchimpPageResponse(page2Emails, 150));

		await t.action(
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: VALID_MAILCHIMP_CONFIG,
				cursor: '100',
			},
		);

		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			expect(row.status).toBe('completed');
			expect(row.imported).toBe(150);
		});
	});
});

// ─── processIntegrationPage — cancellation ──────────────────────────────────

describe('processIntegrationPage — cancellation', () => {
	it('short-circuits when status is not running (no HTTP issued)', async () => {
		const t = convexTest(schema, modules);
		const fetchSpy = vi
			.fn()
			.mockImplementation(() => mailchimpPageResponse([], 0));
		global.fetch = fetchSpy;

		// Seed a cancelled row directly.
		const importId = await seedRunningImport(t, {
			status: 'failed',
			errors: ['Cancelled by user'],
			completedAt: Date.now(),
		});

		await t.action(
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: VALID_MAILCHIMP_CONFIG,
				cursor: '',
			},
		);

		// No HTTP call should have been made.
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('cancelImport flips status to failed and records the cancel reason', async () => {
		const t = convexTest(schema, modules);
		const importId = await seedRunningImport(t);

		await t.mutation(api.integrationImports.walker.cancelImport, { importId });

		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			expect(row.status).toBe('failed');
			expect(row.errors).toContain('Cancelled by user');
		});
	});

	it('cancelImport refuses when import is not running', async () => {
		const t = convexTest(schema, modules);
		const importId = await seedRunningImport(t, {
			status: 'completed',
			completedAt: Date.now(),
		});

		await expect(
			t.mutation(api.integrationImports.walker.cancelImport, { importId }),
		).rejects.toThrow(/not running/);
	});
});

// ─── processIntegrationPage — retry semantics ───────────────────────────────

describe('processIntegrationPage — retry semantics', () => {
	it('retries on 429 up to MAX_RETRIES then succeeds', async () => {
		const t = convexTest(schema, modules);
		// First two attempts return 429; third returns ok.
		let callCount = 0;
		const fetchSpy = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount <= 2) return new Response('rate', { status: 429 });
			return mailchimpPageResponse(['x@example.com'], 1);
		});
		global.fetch = fetchSpy;

		// Avoid wall-clock sleep waiting in tests — collapse the backoff.
		vi.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => {
			cb();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);

		const importId = await seedRunningImport(t);
		await t.action(
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: VALID_MAILCHIMP_CONFIG,
				cursor: '',
			},
		);

		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			expect(row.status).toBe('completed');
			expect(row.imported).toBe(1);
		});
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it('fails after MAX_RETRIES + 1 attempts of 429', async () => {
		const t = convexTest(schema, modules);
		const fetchSpy = vi
			.fn()
			.mockImplementation(() => new Response('rate', { status: 429 }));
		global.fetch = fetchSpy;

		vi.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => {
			cb();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);

		const importId = await seedRunningImport(t);
		await t.action(
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: VALID_MAILCHIMP_CONFIG,
				cursor: '',
			},
		);

		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			expect(row.status).toBe('failed');
			expect(row.errors.some((e) => /rate limit/i.test(e))).toBe(true);
		});
		// 3 attempts total: initial + MAX_RETRIES (2).
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it('fails immediately on non-retryable error (no retry)', async () => {
		const t = convexTest(schema, modules);
		const fetchSpy = vi.fn().mockImplementation(
			() =>
				new Response(JSON.stringify({ detail: 'Invalid key' }), { status: 401 }),
		);
		global.fetch = fetchSpy;

		const importId = await seedRunningImport(t);
		await t.action(
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: VALID_MAILCHIMP_CONFIG,
				cursor: '',
			},
		);

		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			expect(row.status).toBe('failed');
			expect(row.errors.some((e) => e.includes('Invalid key'))).toBe(true);
		});
		// Only one attempt for non-retryable error.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

// ─── processIntegrationPage — DOI attest + topic threading ──────────────────

describe('processIntegrationPage — topic assignment + DOI attest threading', () => {
	it('threads topicId into importBatch and confirms DOI via defaultDoiAttest', async () => {
		const t = convexTest(schema, modules);
		const topicId = await t.run(async (ctx) => {
			return await ctx.db.insert('topics', {
				name: 'integration',
				requireDoubleOptIn: true,
				createdAt: Date.now(),
			});
		});

		global.fetch = vi
			.fn()
			.mockImplementation(() => mailchimpPageResponse(['z@example.com'], 1));

		const importId = await seedRunningImport(t, { topicId });
		await t.action(
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: VALID_MAILCHIMP_CONFIG,
				cursor: '',
			},
		);

		await t.run(async (ctx) => {
			const row = asImport(await ctx.db.get(importId));
			expect(row.status).toBe('completed');

			// Mailchimp default DOI attest landed the contact as confirmed.
			const contacts = await ctx.db.query('contacts').collect();
			expect(contacts).toHaveLength(1);
			expect(contacts[0]!.email).toBe('z@example.com');
			expect(contacts[0]!.doiStatus).toBe('confirmed');

			// Subscribed to the topic.
			const subs = await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicId))
				.collect();
			expect(subs).toHaveLength(1);
		});
	});
});
