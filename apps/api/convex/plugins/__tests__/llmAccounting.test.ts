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

const reservationId = (suffix: number) =>
	`00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

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

async function reserve(
	t: ReturnType<typeof convexTest>,
	id: string,
	amount = 300,
	modelId = 'gpt-4o-mini',
	endpointProvenance: 'openai-native' | 'anthropic-native' | 'custom' = 'openai-native'
) {
	return t.mutation(internal.plugins.llmAccounting.reserve, {
		pluginId: 'alpha',
		reservationId: id,
		reservedMicrousd: amount,
		tier: 'fast',
		modelId,
		endpointProvenance,
		actorMode: 'authenticated_actor',
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
		await expect(reserve(t, id, 300, 'gpt-4o')).rejects.toThrow('Plugin LLM denied');
		await expect(reserve(t, id, 300, 'claude-opus-4-8', 'anthropic-native')).rejects.toThrow(
			'Plugin LLM denied'
		);
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

	it('rejects untrusted endpoint provenance and provider/model mismatches', async () => {
		const t = convexTest(schema, modules);
		await grant(t);
		await expect(reserve(t, reservationId(25), 300, 'gpt-4o-mini', 'custom')).rejects.toThrow(
			'Plugin LLM denied'
		);
		await expect(
			reserve(t, reservationId(26), 300, 'gpt-4o-mini', 'anthropic-native')
		).rejects.toThrow('Plugin LLM denied');
		await expect(
			reserve(t, reservationId(27), 300, 'gpt-4o-mini-9999', 'openai-native')
		).rejects.toThrow('Plugin LLM denied');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').take(1)).toEqual([]);
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
			actorMode: 'authenticated_actor',
			modelUsed: 'gpt-4o-mini',
			tokenUsage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
			attempts: 2,
		});
		// Idempotent settlement must not double-count usage or audit.
		await t.mutation(internal.plugins.llmAccounting.settleSuccess, {
			reservationId: successId,
			actorMode: 'authenticated_actor',
			modelUsed: 'gpt-4o-mini',
			tokenUsage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
			attempts: 2,
		});
		await reserve(t, failureId);
		await t.mutation(internal.plugins.llmAccounting.settleFailure, {
			reservationId: failureId,
			actorMode: 'authenticated_actor',
		});

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
			expect(
				audits.every((row) => row.organizationId === 'tenant-a' && row.pluginId === 'alpha')
			).toBe(true);
			expect(JSON.stringify(audits)).not.toContain('provider error');
		});
	});

	it('settles at list price × tokens, without the admission cache-write ceiling', async () => {
		const t = convexTest(schema, modules);
		await grant(t);
		const id = reservationId(32);
		await reserve(t, id, 300, 'claude-sonnet-5-5', 'anthropic-native');
		await t.mutation(internal.plugins.llmAccounting.settleSuccess, {
			reservationId: id,
			actorMode: 'authenticated_actor',
			modelUsed: 'claude-sonnet-5-5',
			tokenUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
			attempts: 1,
		});

		await t.run(async (ctx) => {
			const daily = await ctx.db.query('pluginLlmDailyUsage').unique();
			// Sonnet 5.5 list: $2/M input, $10/M output ⇒ 20 × 2 + 5 × 10 = 90 micro-USD.
			// The 2× admission ceiling would make it 130, over the 100 per-attempt hold.
			expect(daily).toMatchObject({ chargedMicrousd: 90, actualMicrousd: 90 });
		});
	});

	it('retains the full reservation and skips usage persistence for malformed accounting', async () => {
		const t = convexTest(schema, modules);
		await grant(t);
		const id = reservationId(40);
		await reserve(t, id);
		await t.mutation(internal.plugins.llmAccounting.settleSuccess, {
			reservationId: id,
			actorMode: 'authenticated_actor',
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

	it('retains the full reservation when the provider reports a different model', async () => {
		const t = convexTest(schema, modules);
		await grant(t);
		const id = reservationId(45);
		await reserve(t, id);
		await t.mutation(internal.plugins.llmAccounting.settleSuccess, {
			reservationId: id,
			actorMode: 'authenticated_actor',
			modelUsed: 'gpt-4o-mini-9999',
			tokenUsage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
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

describe('plugin LLM calls and the deployment ceiling', () => {
	const reconciled = async (t: ReturnType<typeof convexTest>) => {
		const { reconcileSpend } = await import('../../aiRouting/__tests__/spend.testlib');
		await reconcileSpend(t);
	};

	it('takes a deployment hold under the same id, and settles it with the call’s rows', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		try {
			const t = convexTest(schema, modules);
			await reconciled(t);
			await grant(t);
			const id = reservationId(70);
			await reserve(t, id);
			const held = await t.run((ctx) => ctx.db.query('llmReservations').unique());
			expect(held).toMatchObject({
				reservationId: id,
				status: 'held',
				task: 'plugin.invoke',
				heldMicrousd: 300,
			});
			await t.mutation(internal.plugins.llmAccounting.settleSuccess, {
				reservationId: id,
				actorMode: 'authenticated_actor',
				modelUsed: 'gpt-4o-mini',
				tokenUsage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
				attempts: 1,
				requestId: 'plugin-call-70',
				requests: [
					{
						attempt: 1,
						latencyMs: 5,
						modelUsed: 'gpt-4o-mini',
						usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
					},
				],
			});
			const settled = await t.run((ctx) => ctx.db.query('llmReservations').unique());
			expect(settled).toMatchObject({ status: 'settled' });
			const rows = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
			expect(rows.every((row) => row.reservationId === id)).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('denies the call, before any provider request, when the deployment ceiling has no room', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '0.0001');
		try {
			const t = convexTest(schema, modules);
			await reconciled(t);
			await grant(t);
			await expect(reserve(t, reservationId(71))).rejects.toThrow('Plugin LLM denied');
			await t.run(async (ctx) => {
				expect(await ctx.db.query('pluginLlmReservations').collect()).toHaveLength(0);
				expect(await ctx.db.query('llmReservations').collect()).toHaveLength(0);
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
