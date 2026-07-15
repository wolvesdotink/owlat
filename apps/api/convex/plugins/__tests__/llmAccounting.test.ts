import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginCapability } from '@owlat/plugin-kit';
import schema from '../../schema';
import { internal } from '../../_generated/api';

const rootGlob = import.meta.glob('../../**/*.*s');
const pluginGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../plugins/'),
		module,
	])
);
const modules = { ...rootGlob, ...pluginGlob };
const auth = vi.hoisted(() => ({ organizationId: 'tenant-a', userId: 'actor', isMember: true }));
const registry = vi.hoisted(() => ({
	plugins: [
		{
			packageName: 'test-alpha',
			manifest: {
				id: 'alpha',
				version: '1.0.0',
				capabilities: ['llm:invoke'],
				flag: { default: false },
				llmBudget: { dailyUsd: 0.0006 },
			},
		},
	],
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn(async () =>
			auth.isMember
				? {
						activeOrganizationId: auth.organizationId,
						userId: auth.userId,
						role: 'owner',
					}
				: null
		),
	};
});

vi.mock('../plugins.generated', () => ({ bundledPluginComposition: registry.plugins }));

const reservationId = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

beforeEach(() => {
	auth.organizationId = 'tenant-a';
	auth.userId = 'actor';
	auth.isMember = true;
	registry.plugins.splice(0, registry.plugins.length, {
		packageName: 'test-alpha',
		manifest: {
			id: 'alpha',
			version: '1.0.0',
			capabilities: ['llm:invoke'],
			flag: { default: false },
			llmBudget: { dailyUsd: 0.0006 },
		},
	});
});

async function grant(
	t: ReturnType<typeof convexTest>,
	capabilities: readonly PluginCapability[] = ['llm:invoke'],
	isEnabled = true
) {
	await t.run(async (ctx) => {
		const current = await ctx.db.query('instanceSettings').first();
		const value = {
			featureFlags: { 'plugin.alpha': isEnabled },
			pluginCapabilityGrants: {
				'plugin.alpha': Object.fromEntries(capabilities.map((capability) => [capability, true])),
			},
			updatedAt: Date.now(),
		};
		if (current) await ctx.db.patch(current._id, value);
		else await ctx.db.insert('instanceSettings', { ...value, createdAt: Date.now() });
	});
}

async function reserve(t: ReturnType<typeof convexTest>, id: string, amount = 300) {
	return t.mutation(internal.plugins.llmAccounting.reserve, {
		pluginId: 'alpha',
		reservationId: id,
		reservedMicrousd: amount,
		tier: 'fast',
	});
}

describe('plugin LLM accounting', () => {
	it('requires registration, enabled state, declaration, and exact operator grant', async () => {
		const t = convexTest(schema, modules);
		await grant(t, [], true);
		await expect(reserve(t, reservationId(1))).rejects.toThrow();
		await grant(t, ['llm:invoke'], false);
		await expect(reserve(t, reservationId(2))).rejects.toThrow();
		await grant(t);
		registry.plugins[0]!.manifest.capabilities = [];
		await expect(reserve(t, reservationId(3))).rejects.toThrow();
		registry.plugins.splice(0, 1);
		await expect(reserve(t, reservationId(4))).rejects.toThrow();
	});

	it('serializes concurrent admissions at the exact fixed-point daily boundary', async () => {
		const t = convexTest(schema, modules);
		await grant(t);
		const outcomes = await Promise.allSettled([
			reserve(t, reservationId(10)),
			reserve(t, reservationId(11)),
			reserve(t, reservationId(12)),
		]);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
		await t.run(async (ctx) => {
			const daily = await ctx.db.query('pluginLlmDailyUsage').unique();
			expect(daily).toMatchObject({ chargedMicrousd: 600, admittedCallCount: 2 });
			expect(await ctx.db.query('pluginLlmReservations').take(4)).toHaveLength(2);
		});
	});

	it('is idempotent only for an exact pending reservation in the same scope', async () => {
		const t = convexTest(schema, modules);
		await grant(t);
		const id = reservationId(20);
		await reserve(t, id);
		await reserve(t, id);
		await expect(reserve(t, id, 303)).rejects.toThrow('Plugin LLM denied');
		auth.organizationId = 'tenant-b';
		await expect(reserve(t, id)).rejects.toThrow('Plugin LLM denied');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').take(2)).toHaveLength(1);
			expect(await ctx.db.query('pluginLlmDailyUsage').unique()).toMatchObject({
				chargedMicrousd: 300,
				admittedCallCount: 1,
			});
		});
	});

	it('settles actual usage atomically and retains a full maximum for provider failure', async () => {
		const t = convexTest(schema, modules);
		await grant(t);
		const successId = reservationId(30);
		const failureId = reservationId(31);
		await reserve(t, successId);
		await t.mutation(internal.plugins.llmAccounting.settleSuccess, {
			reservationId: successId,
			modelUsed: 'gpt-4o-mini',
			tokenUsage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
			attempts: 2,
		});
		// Idempotent settlement must not double-count usage or audit.
		await t.mutation(internal.plugins.llmAccounting.settleSuccess, {
			reservationId: successId,
			modelUsed: 'gpt-4o-mini',
			tokenUsage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
			attempts: 2,
		});
		await reserve(t, failureId);
		await t.mutation(internal.plugins.llmAccounting.settleFailure, { reservationId: failureId });

		await t.run(async (ctx) => {
			const daily = await ctx.db.query('pluginLlmDailyUsage').unique();
			// Successful charge: one failed-attempt maximum (100) + actual (75),
			// plus the failed call's full three-attempt reservation (300).
			expect(daily).toMatchObject({ chargedMicrousd: 475, actualMicrousd: 75 });
			const usage = await ctx.db.query('llmUsageEvents').unique();
			expect(usage).toMatchObject({
				organizationId: 'tenant-a',
				pluginId: 'alpha',
				feature: 'plugin:alpha',
				totalTokens: 200,
			});
			const audits = await ctx.db.query('auditLogs').take(3);
			expect(audits).toHaveLength(2);
			expect(audits.every((row) => row.organizationId === 'tenant-a' && row.pluginId === 'alpha')).toBe(true);
			expect(JSON.stringify(audits)).not.toContain('provider error');
		});
	});

	it('retains the full reservation and skips usage persistence for malformed accounting', async () => {
		const t = convexTest(schema, modules);
		await grant(t);
		const id = reservationId(40);
		await reserve(t, id);
		await t.mutation(internal.plugins.llmAccounting.settleSuccess, {
			reservationId: id,
			modelUsed: 'gpt-4o-mini',
			tokenUsage: { promptTokens: 100, completionTokens: 100, totalTokens: 1 },
			attempts: 1,
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmDailyUsage').unique()).toMatchObject({
				chargedMicrousd: 300,
				actualMicrousd: 0,
			});
			expect(await ctx.db.query('llmUsageEvents').take(1)).toEqual([]);
		});
	});

	it('isolates the same plugin budget by tenant and resets on a new UTC day', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-07-15T23:59:59.000Z'));
			const t = convexTest(schema, modules);
			await grant(t);
			await reserve(t, reservationId(50));
			auth.organizationId = 'tenant-b';
			await reserve(t, reservationId(51));
			auth.organizationId = 'tenant-a';
			vi.setSystemTime(new Date('2026-07-16T00:00:01.000Z'));
			await reserve(t, reservationId(52));
			await t.run(async (ctx) => {
				const rows = await ctx.db.query('pluginLlmDailyUsage').take(4);
				expect(rows.map((row) => `${row.organizationId}:${row.utcDay}`).sort()).toEqual([
					'tenant-a:2026-07-15',
					'tenant-a:2026-07-16',
					'tenant-b:2026-07-15',
				]);
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
