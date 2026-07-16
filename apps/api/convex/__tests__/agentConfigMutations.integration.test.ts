import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestAgentConfig } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner', activeOrganizationId: 'org-1' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner', activeOrganizationId: 'org-1' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner', activeOrganizationId: 'org-1' }),
	};
});
vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
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

/** Strip fields not in the agentConfig schema (master toggle is now the
 * `ai.agent` feature flag — `isEnabled` is no longer a column). */
function configData(overrides: Record<string, unknown> = {}) {
	const { autoReplyCount, autoReplyCountResetAt, isEnabled, ...rest } = createTestAgentConfig(
		overrides,
	) as ReturnType<typeof createTestAgentConfig> & { isEnabled?: unknown };
	return rest;
}

const testIdentity = {
	subject: 'test-user-123',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user-123',
};

// ============ getConfig ============

describe('agentConfigMutations.getConfig', () => {
	it('should return null when not authenticated', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.agentConfigMutations.getConfig, {});
		expect(result).toBeNull();
	});

	it('should return null when no config exists', async () => {
		const t = convexTest(schema, modules);
		const result = await t.withIdentity(testIdentity).query(
			api.agentConfigMutations.getConfig,
			{}
		);
		expect(result).toBeNull();
	});

	it('should return config when it exists', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', configData({ confidenceThreshold: 0.75 }));
		});

		const result = await t.withIdentity(testIdentity).query(
			api.agentConfigMutations.getConfig,
			{}
		);

		expect(result).toBeDefined();
		expect(result!.confidenceThreshold).toBe(0.75);
	});
});

// ============ updateConfig ============
// Note: the master agent on/off used to live on `agentConfig.isEnabled`; it is
// now the `ai.agent` feature flag. updateConfig only manages tuning fields.

describe('agentConfigMutations.updateConfig', () => {
	it('should throw when not authenticated', async () => {
		// adminMutation rejects pre-handler when the mocked role check throws.
		// We re-stub `requireAdminContext` for this case to mirror real
		// behavior; restored at end so the rest of the suite stays admin-ok.
		const sessionMod = await import('../lib/sessionOrganization');
		const stub = vi
			.mocked(sessionMod.requireAdminContext)
			.mockRejectedValueOnce(new Error('Not authenticated'));
		try {
			const t = convexTest(schema, modules);
			await expect(
				t.mutation(api.agentConfigMutations.updateConfig, { confidenceThreshold: 0.7 })
			).rejects.toThrow('Not authenticated');
		} finally {
			stub.mockResolvedValue({ userId: 'test-user', role: 'owner', activeOrganizationId: 'org-1' });
		}
	});

	it('should create config on first call with defaults', async () => {
		const t = convexTest(schema, modules);

		const configId = await t.withIdentity(testIdentity).mutation(
			api.agentConfigMutations.updateConfig,
			{ confidenceThreshold: 0.7 }
		);

		expect(configId).toBeDefined();

		await t.run(async (ctx) => {
			const config = await ctx.db.get(configId);
			expect(config).toBeDefined();
			expect(config!.isAutoReplyEnabled).toBe(false);
			expect(config!.confidenceThreshold).toBe(0.7);
			expect(config!.maxDailyAutoReplies).toBe(100);
			expect(config!.coalesceWindowMs).toBe(30000);
		});
	});

	it('should update existing config', async () => {
		const t = convexTest(schema, modules);

		let existingConfigId!: Id<'agentConfig'>;
		await t.run(async (ctx) => {
			existingConfigId = await ctx.db.insert(
				'agentConfig',
				configData({ confidenceThreshold: 0.85 })
			);
		});

		const returnedId = await t.withIdentity(testIdentity).mutation(
			api.agentConfigMutations.updateConfig,
			{
				confidenceThreshold: 0.7,
				toneDescription: 'Casual and friendly',
			}
		);

		expect(returnedId).toBe(existingConfigId);

		await t.run(async (ctx) => {
			const config = await ctx.db.get(existingConfigId);
			expect(config!.confidenceThreshold).toBe(0.7);
			expect(config!.toneDescription).toBe('Casual and friendly');
		});
	});

	it('should create an audit log on config creation', async () => {
		const t = convexTest(schema, modules);

		await t.withIdentity(testIdentity).mutation(
			api.agentConfigMutations.updateConfig,
			{ confidenceThreshold: 0.7 }
		);

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'agent.config_updated'))
				.collect();

			expect(logs.length).toBeGreaterThanOrEqual(1);
			expect(logs[0]!.resource).toBe('agent_config');
			// userId now comes from the admin-context session (mocked above),
			// not the raw BetterAuth identity — admin gating is enforced by
			// `requireAdminContext`, which is the authoritative source.
			expect(logs[0]!.userId).toBe('test-user');
		});
	});

	it('should create an audit log on config update', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', configData());
		});

		await t.withIdentity(testIdentity).mutation(
			api.agentConfigMutations.updateConfig,
			{ confidenceThreshold: 0.6 }
		);

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'agent.config_updated'))
				.collect();

			expect(logs.length).toBeGreaterThanOrEqual(1);
		});
	});
});
