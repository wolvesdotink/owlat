import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../_generated/api';
import schema from '../../schema';

vi.mock('../../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../../lib/sessionOrganization')),
	getMutationContext: vi.fn().mockResolvedValue({ userId: 'owner', role: 'owner' }),
	requireAdminContext: vi.fn().mockResolvedValue({ userId: 'owner', role: 'owner' }),
	getSingletonOrganizationId: vi.fn().mockResolvedValue('tenant'),
}));

vi.mock('../draftStrategyCatalog.generated', () => ({
	BUNDLED_PLUGIN_DRAFT_STRATEGY_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.draft-pack.legal',
			pluginId: 'draft-pack',
			label: 'Legal',
			timeoutMs: 1_000,
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'draft:strategy',
		}),
	]),
}));

const rootGlob = import.meta.glob('../../**/*.*s');
const pluginGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../plugins/'),
		module,
	])
);
const modules = { ...rootGlob, ...pluginGlob };
const identity = {
	subject: 'owner',
	issuer: 'https://test.issuer.example',
	tokenIdentifier: 'https://test.issuer.example|owner',
};

describe('draft strategy selection mutations', () => {
	it('creates, updates idempotently, and removes a classification selection', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		const scope = { type: 'classification' as const, id: 'support' };

		await t.mutation(api.plugins.draftStrategySelections.setSelection, {
			scope,
			strategyKind: 'plugin.draft-pack.legal',
		});
		await t.mutation(api.plugins.draftStrategySelections.setSelection, {
			scope,
			strategyKind: 'plugin.draft-pack.legal',
		});
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('draftStrategySelections').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				organizationId: 'tenant',
				scopeType: 'classification',
				scopeId: 'support',
				strategyKind: 'plugin.draft-pack.legal',
			});
		});

		await t.mutation(api.plugins.draftStrategySelections.setSelection, {
			scope,
			strategyKind: 'default',
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.query('draftStrategySelections').collect()).toEqual([]);
		});
	});

	it('rejects unknown strategies and noncanonical classifications without writing', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await expect(
			t.mutation(api.plugins.draftStrategySelections.setSelection, {
				scope: { type: 'classification', id: 'support' },
				strategyKind: 'plugin.retired.missing',
			})
		).rejects.toThrow('Unknown draft strategy');
		await expect(
			t.mutation(api.plugins.draftStrategySelections.setSelection, {
				scope: { type: 'classification', id: 'invented-category' },
				strategyKind: 'plugin.draft-pack.legal',
			})
		).rejects.toThrow('Invalid draft classification scope');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('draftStrategySelections').collect()).toEqual([]);
		});
	});
});
