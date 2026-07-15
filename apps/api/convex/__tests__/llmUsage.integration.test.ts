import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			activeOrganizationId: 'tenant-a',
			role: 'owner',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing')
	)
);

describe('analytics.llmUsage.record', () => {
	it('inserts a priced usage row and no-ops on absent usage', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.analytics.llmUsage.record, {
			feature: 'assistant_ask',
			modelUsed: 'gpt-4o',
			tokenUsage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
		});
		// No usage → must not write a row.
		await t.mutation(internal.analytics.llmUsage.record, {
			feature: 'assistant_ask',
			modelUsed: 'gpt-4o',
			tokenUsage: undefined,
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('llmUsageEvents').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.feature).toBe('assistant_ask');
			expect(rows[0]!.costUsd).toBeGreaterThan(0);
			expect(rows[0]!.totalTokens).toBe(2000);
		});
	});
});

describe('analytics.llmUsage.getSpendByFeature', () => {
	it('groups spend by feature, sorts by cost desc, and totals it', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('llmUsageEvents', {
				feature: 'postbox_summarize',
				modelUsed: 'gpt-4o-mini',
				promptTokens: 100,
				completionTokens: 100,
				totalTokens: 200,
				costUsd: 0.001,
				createdAt: now,
			});
			await ctx.db.insert('llmUsageEvents', {
				feature: 'assistant_ask',
				modelUsed: 'gpt-4o',
				promptTokens: 1000,
				completionTokens: 1000,
				totalTokens: 2000,
				costUsd: 0.5,
				createdAt: now,
			});
			await ctx.db.insert('llmUsageEvents', {
				feature: 'assistant_ask',
				modelUsed: 'gpt-4o',
				promptTokens: 500,
				completionTokens: 500,
				totalTokens: 1000,
				costUsd: 0.25,
				createdAt: now,
			});
		});

		const result = await t.query(api.analytics.llmUsage.getSpendByFeature, {});
		expect(result.features.map((f) => f.feature)).toEqual(['assistant_ask', 'postbox_summarize']);
		const assistant = result.features.find((f) => f.feature === 'assistant_ask')!;
		expect(assistant.calls).toBe(2);
		expect(assistant.costUsd).toBeCloseTo(0.75);
		expect(result.totalCostUsd).toBeCloseTo(0.751);
	});
});

describe('plugin LLM spend reads', () => {
	it('combines legacy core with the active tenant and excludes another tenant', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			for (const row of [
				{ feature: 'core', costUsd: 0.1 },
				{ feature: 'plugin:alpha', organizationId: 'tenant-a', pluginId: 'alpha', costUsd: 0.2 },
				{ feature: 'plugin:alpha', organizationId: 'tenant-b', pluginId: 'alpha', costUsd: 100 },
			]) {
				await ctx.db.insert('llmUsageEvents', {
					...row,
					modelUsed: 'gpt-4o-mini',
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15,
					createdAt: now,
				});
			}
		});
		const byFeature = await t.query(api.analytics.llmUsage.getSpendByFeature, {});
		expect(byFeature.totalCostUsd).toBeCloseTo(0.3);
		expect(byFeature.features.map((row) => row.feature).sort()).toEqual(['core', 'plugin:alpha']);
		const byProvider = await t.query(api.analytics.llmUsage.getSpendByProvider, {});
		expect(byProvider.totalCostUsd).toBeCloseTo(0.3);
		const plugin = await t.query(api.analytics.llmUsage.getSpendByPlugin, { pluginId: 'alpha' });
		expect(plugin).toMatchObject({ pluginId: 'alpha', calls: 1, totalTokens: 15, costUsd: 0.2 });
		await expect(
			t.query(api.analytics.llmUsage.getSpendByPlugin, { pluginId: '../secret' })
		).rejects.toThrow();
	});

	it('shares one bounded spend-window validator across feature, provider, and plugin reads', async () => {
		const t = convexTest(schema, modules);
		for (const call of [
			t.query(api.analytics.llmUsage.getSpendByFeature, { hoursBack: -1 }),
			t.query(api.analytics.llmUsage.getSpendByProvider, { hoursBack: Number.POSITIVE_INFINITY }),
			t.query(api.analytics.llmUsage.getSpendByPlugin, { pluginId: 'alpha', hoursBack: 2161 }),
		]) {
			await expect(call).rejects.toThrow('Invalid LLM spend window');
		}
	});

	it('marks a plugin attribution window truncated at its bounded read ceiling', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		for (let batch = 0; batch < 50; batch++) {
			await t.run(async (ctx) => {
				for (let index = 0; index < 100; index++) {
					await ctx.db.insert('llmUsageEvents', {
						feature: 'plugin:alpha',
						organizationId: 'tenant-a',
						pluginId: 'alpha',
						modelUsed: 'gpt-4o-mini',
						promptTokens: 1,
						completionTokens: 1,
						totalTokens: 2,
						costUsd: 0.000001,
						createdAt: now + batch * 100 + index,
					});
				}
			});
		}
		const plugin = await t.query(api.analytics.llmUsage.getSpendByPlugin, { pluginId: 'alpha' });
		expect(plugin).toMatchObject({ calls: 5000, isTruncated: true });
	});
});
