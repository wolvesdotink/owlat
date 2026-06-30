import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { OrganizationRole } from '../../lib/sessionOrganization';

/**
 * Unit tests for the Feature flags (module).
 *
 * Covers the five entry points (`getFeatureFlags`, `getResolvedFlags`,
 * `setFeatureFlag`, `setFeaturePack`, `setAllFeatureFlags`) and the
 * load-bearing per-flag side-effect: an explicit false→true toggle of
 * `ai.agent` via `setFeatureFlag` kicks off the knowledge-graph backfill;
 * a pack-driven or setAll-driven enable does NOT.
 *
 * See docs/adr/0026-organization-settings-modules.md.
 */

let mockRole: OrganizationRole = 'owner';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/sessionOrganization')
	>('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ({
			userId: 'test-user',
			role: mockRole,
		})),
		requireAdminContext: vi.fn(async () => ({
			userId: 'test-user',
			role: mockRole,
		})),
	};
});

// `knowledgeExtraction` and friends import LLM/embedding deps that can't be
// loaded in the test runtime. Exclude them so the scheduler can still try to
// resolve the backfill chunk runner.
//
// Vite canonicalizes glob keys for files in this same subtree: a sibling at
// convex/organizations/X is keyed as '../X' rather than '../../organizations/X'.
// convex-test computes its lookup prefix from '../../_generated/...', so the
// canonicalized keys would never match. Re-prefix the canonicalized half.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.map(([key, val]) => {
			if (key.startsWith('../') && !key.startsWith('../../')) {
				return ['../../organizations/' + key.slice(3), val] as const;
			}
			return [key, val] as const;
		})
		.filter(
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

beforeEach(() => {
	mockRole = 'owner';
});

// Suppress "Could not find module" rejections from the scheduler trying to
// run scheduled functions whose target module is excluded above (the false→true
// ai.agent toggle legitimately schedules a chunk runner; we don't want that
// schedule to fire in tests).
const suppressedErrors: Error[] = [];
const unhandledRejectionHandler = (err: Error) => {
	if (
		err.message?.includes('Could not find module') ||
		err.message?.includes('Write outside of transaction')
	) {
		suppressedErrors.push(err);
	} else {
		throw err;
	}
};

beforeEach(() => {
	suppressedErrors.length = 0;
	process.on('unhandledRejection', unhandledRejectionHandler);
});

// ============================================================
// getFeatureFlags / getResolvedFlags
// ============================================================

describe('organizations.featureFlags.getFeatureFlags', () => {
	it('returns defaults when no settings row exists', async () => {
		const t = convexTest(schema, modules);
		const flags = await t.query(
			api.organizations.featureFlags.getFeatureFlags,
			{},
		);
		// Some default ON flags (campaigns/transactional/...) should be true.
		expect(flags.campaigns).toBe(true);
		expect(flags['ai.agent']).toBe(false);
	});

	it('returns stored flags merged with defaults', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { ai: true, 'ai.agent': true, inbox: true },
				createdAt: Date.now(),
			});
		});

		const flags = await t.query(
			api.organizations.featureFlags.getFeatureFlags,
			{},
		);
		expect(flags['ai.agent']).toBe(true);
	});
});

describe('organizations.featureFlags.getResolvedFlags (internal)', () => {
	it('matches the public getFeatureFlags result', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { ai: true, 'ai.agent': true, inbox: true },
				createdAt: Date.now(),
			});
		});

		const publicFlags = await t.query(
			api.organizations.featureFlags.getFeatureFlags,
			{},
		);
		const internalFlags = await t.query(
			internal.organizations.featureFlags.getResolvedFlags,
			{},
		);
		expect(internalFlags).toEqual(publicFlags);
	});
});

// ============================================================
// setFeatureFlag — basic semantics
// ============================================================

describe('organizations.featureFlags.setFeatureFlag', () => {
	it('writes the flag value and bumps updatedAt', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.organizations.featureFlags.setFeatureFlag, {
			flag: 'webhooks',
			value: true,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			expect(row?.featureFlags?.['webhooks']).toBe(true);
			expect(row?.updatedAt).toBeGreaterThan(0);
		});
	});

	it('throws for an unknown flag key', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.organizations.featureFlags.setFeatureFlag, {
				flag: 'not.a.real.flag',
				value: true,
			}),
		).rejects.toThrow(/Unknown feature flag/);
	});

	it('cascades dependent flags off on disable', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: {
					ai: true,
					'ai.agent': true,
					'ai.autonomy': true,
					inbox: true,
				},
				createdAt: Date.now(),
			});
		});

		// Disabling `ai` should cascade off `ai.agent` and `ai.autonomy`.
		const res = await t.mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai', value: false },
		);
		expect(res.cascaded).toContain('ai.agent');
		expect(res.cascaded).toContain('ai.autonomy');
	});
});

// ============================================================
// ai.agent backfill side-effect — explicit-only semantic
// ============================================================

describe('organizations.featureFlags.setFeatureFlag — ai.agent backfill', () => {
	it('explicit false→true toggle triggers backfill + audit log', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.organizations.featureFlags.setFeatureFlag, {
			flag: 'ai.agent',
			value: true,
		});

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]!.status).toBe('running');
			expect(jobs[0]!.triggeredBy).toBe('test-user');

			const auditLogs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) =>
					q.eq('action', 'agent.backfill_started'),
				)
				.collect();
			expect(auditLogs).toHaveLength(1);
		});
	});

	it('does NOT trigger when ai.agent was already true (no-op)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.agent': true, ai: true, inbox: true },
				createdAt: Date.now(),
			});
		});

		await t.mutation(api.organizations.featureFlags.setFeatureFlag, {
			flag: 'ai.agent',
			value: true,
		});

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(0);
		});
	});

	it('does NOT trigger on true→false toggle', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.agent': true, ai: true, inbox: true },
				createdAt: Date.now(),
			});
		});

		await t.mutation(api.organizations.featureFlags.setFeatureFlag, {
			flag: 'ai.agent',
			value: false,
		});

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(0);
		});
	});

	it('does NOT trigger when a prior backfill job exists', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.agent': false, ai: true, inbox: true },
				createdAt: Date.now(),
			});
			await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'completed',
				triggeredBy: 'prior',
				totalCount: 0,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now() - 1_000,
				updatedAt: Date.now(),
				finishedAt: Date.now(),
			});
		});

		await t.mutation(api.organizations.featureFlags.setFeatureFlag, {
			flag: 'ai.agent',
			value: true,
		});

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			// Only the pre-existing job survives.
			expect(jobs).toHaveLength(1);
			expect(jobs[0]!.triggeredBy).toBe('prior');
		});
	});

	it('pack-driven enable does NOT trigger the backfill', async () => {
		// Critical regression guard: enabling the 'ai' feature pack flips
		// ai.agent to true as a side-effect of the pack write, but the
		// per-flag backfill kick-off lives ONLY in setFeatureFlag. The
		// explicit-only semantic must hold.
		const t = convexTest(schema, modules);

		await t.mutation(api.organizations.featureFlags.setFeaturePack, {
			pack: 'ai',
			value: true,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			// Pack write turned ai.agent on.
			expect(row?.featureFlags?.['ai.agent']).toBe(true);

			// But no backfill job was created.
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(0);

			// And no audit log row either.
			const auditLogs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) =>
					q.eq('action', 'agent.backfill_started'),
				)
				.collect();
			expect(auditLogs).toHaveLength(0);
		});
	});

	it('setAllFeatureFlags-driven enable does NOT trigger the backfill', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.organizations.featureFlags.setAllFeatureFlags, {
			flags: { ai: true, 'ai.agent': true, inbox: true },
		});

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(0);
		});
	});
});

// ============================================================
// setFeaturePack
// ============================================================

describe('organizations.featureFlags.setFeaturePack', () => {
	it('enables every flag in the pack', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.organizations.featureFlags.setFeaturePack, {
			pack: 'marketing',
			value: true,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			expect(row?.featureFlags?.['campaigns']).toBe(true);
			expect(row?.featureFlags?.['automations']).toBe(true);
			expect(row?.featureFlags?.['transactional']).toBe(true);
		});
	});

	it('throws for an unknown pack key', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.organizations.featureFlags.setFeaturePack, {
				pack: 'not-a-real-pack',
				value: true,
			}),
		).rejects.toThrow(/Unknown feature pack/);
	});
});

// ============================================================
// setAllFeatureFlags
// ============================================================

describe('organizations.featureFlags.setAllFeatureFlags', () => {
	it('writes the resolved flag map', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { campaigns: true, automations: true, inbox: true },
				createdAt: Date.now(),
			});
		});

		await t.mutation(api.organizations.featureFlags.setAllFeatureFlags, {
			flags: { campaigns: false, inbox: true },
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			expect(row?.featureFlags?.['campaigns']).toBe(false);
			expect(row?.featureFlags?.['inbox']).toBe(true);
		});
	});

	it('throws for an unknown flag key in the map', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.organizations.featureFlags.setAllFeatureFlags, {
				flags: { 'not.a.real.flag': true },
			}),
		).rejects.toThrow(/Unknown feature flag/);
	});
});

// ============================================================
// setAllInternal (the setup-seed path — no admin gate)
// ============================================================

describe('organizations.featureFlags.setAllInternal', () => {
	it('persists the wizard flags onto a fresh instanceSettings row', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.organizations.featureFlags.setAllInternal, {
			flags: { campaigns: true, inbox: true },
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			expect(row?.featureFlags?.['campaigns']).toBe(true);
			expect(row?.featureFlags?.['inbox']).toBe(true);
		});
	});

	it('rejects an unknown flag key', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(internal.organizations.featureFlags.setAllInternal, {
				flags: { 'not.a.real.flag': true },
			}),
		).rejects.toThrow(/Unknown feature flag/);
	});
});

// ============================================================
// getFlagsConfigStatus — per-flag configuration gaps
// ============================================================

describe('organizations.featureFlags.getFlagsConfigStatus', () => {
	// Snapshot + clear the env vars this query inspects so each case starts from
	// a known "nothing configured" baseline, then restore afterwards.
	const ENV_KEYS = [
		'LLM_PROVIDER',
		'LLM_API_KEY',
		'EMAIL_PROVIDER',
		'MTA_API_URL',
		'MTA_API_KEY',
		'GOOGLE_SAFE_BROWSING_API_KEY',
		'POSTHOG_API_KEY',
		'POSTHOG_HOST',
	] as const;
	const original: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of ENV_KEYS) {
			original[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (original[k] === undefined) delete process.env[k];
			else process.env[k] = original[k];
		}
	});

	it('reports missing env vars for an env-gated flag', async () => {
		const t = convexTest(schema, modules);
		const status = await t.query(
			api.organizations.featureFlags.getFlagsConfigStatus,
			{},
		);
		expect(status['ai']).toEqual(['LLM_PROVIDER', 'LLM_API_KEY']);
	});

	it('omits a flag once its env vars are present', async () => {
		process.env['LLM_PROVIDER'] = 'openai';
		process.env['LLM_API_KEY'] = 'sk-test';

		const t = convexTest(schema, modules);
		const status = await t.query(
			api.organizations.featureFlags.getFlagsConfigStatus,
			{},
		);
		expect(status['ai']).toBeUndefined();
	});

	it('reports a missing delivery provider for sending flags', async () => {
		const t = convexTest(schema, modules);
		const status = await t.query(
			api.organizations.featureFlags.getFlagsConfigStatus,
			{},
		);
		expect(status['campaigns']).toContain('A configured delivery provider');
		expect(status['transactional']).toContain('A configured delivery provider');
		expect(status['automations']).toContain('A configured delivery provider');
	});

	it('clears the sending-flag gap once a delivery provider is configured', async () => {
		process.env['EMAIL_PROVIDER'] = 'mta';
		process.env['MTA_API_URL'] = 'https://mta.example';
		process.env['MTA_API_KEY'] = 'mta-key';

		const t = convexTest(schema, modules);
		const status = await t.query(
			api.organizations.featureFlags.getFlagsConfigStatus,
			{},
		);
		expect(status['campaigns']).toBeUndefined();
		expect(status['transactional']).toBeUndefined();
	});
});
