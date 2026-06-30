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
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) => !path.includes('sesActions') && !path.includes('visualizationAgent') && !path.includes('semanticFileProcessing'),
	),
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
				feature: 'postbox_summarize', modelUsed: 'gpt-4o-mini',
				promptTokens: 100, completionTokens: 100, totalTokens: 200, costUsd: 0.001, createdAt: now,
			});
			await ctx.db.insert('llmUsageEvents', {
				feature: 'assistant_ask', modelUsed: 'gpt-4o',
				promptTokens: 1000, completionTokens: 1000, totalTokens: 2000, costUsd: 0.5, createdAt: now,
			});
			await ctx.db.insert('llmUsageEvents', {
				feature: 'assistant_ask', modelUsed: 'gpt-4o',
				promptTokens: 500, completionTokens: 500, totalTokens: 1000, costUsd: 0.25, createdAt: now,
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
