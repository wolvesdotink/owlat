import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { MAX_METERED_REQUESTS_PER_WRITE } from '../analytics/llmUsage';
import { PRICE_VERSION } from '../lib/llm/pricing';
import { spendPeriodKeys, usdToMicrousd } from '../lib/aiRouting/spendPeriods';
import { SETTLEMENT_FEATURE } from '../lib/llmUsageTags';
import { reconcileSpend } from '../aiRouting/__tests__/spend.testlib';

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

describe('analytics.llmUsage.recordRequests', () => {
	it('writes one priced row per provider request, with the routing columns', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.analytics.llmUsage.recordRequests, {
			feature: 'agent_classify',
			requestId: 'req-1',
			rootRequestId: 'team:msg-1',
			requests: [
				// A retried attempt the provider billed, then the one that answered.
				{
					attempt: 1,
					latencyMs: 120,
					modelUsed: 'gpt-4o',
					usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
				},
				{
					attempt: 2,
					latencyMs: 340,
					modelUsed: 'gpt-4o',
					endpoint: 'openai-native',
					cacheReadTokens: 200,
					reasoningTokens: 50,
					usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
				},
				// A request that failed with no reported usage.
				{ attempt: 3, latencyMs: 9, modelUsed: 'gpt-4o' },
			],
		});

		await t.run(async (ctx) => {
			const rows = (await ctx.db.query('llmUsageEvents').collect()).sort(
				(left, right) => (left.attempt ?? 0) - (right.attempt ?? 0)
			);
			expect(rows.map((row) => row.attempt)).toEqual([1, 2, 3]);
			for (const row of rows) {
				expect(row).toMatchObject({
					feature: 'agent_classify',
					requestId: 'req-1',
					rootRequestId: 'team:msg-1',
					// The task the feature maps to, and its triage budget class.
					task: 'mail.classify',
					budgetClass: 'triage',
					priceVersion: PRICE_VERSION,
				});
				expect(row.costMicrousd).toBe(usdToMicrousd(row.costUsd));
			}
			expect(rows[1]).toMatchObject({
				latencyMs: 340,
				endpoint: 'openai-native',
				cacheReadTokens: 200,
				reasoningTokens: 50,
				totalTokens: 2000,
			});
			expect(rows[0]!.isEstimated).toBe(false);
			expect(rows[2]).toMatchObject({ isEstimated: true, costUsd: 0, totalTokens: 0 });
			expect(rows[1]!.costUsd).toBeGreaterThan(rows[0]!.costUsd);
		});
	});

	it('adds every row to its day and month bucket in the same mutation', async () => {
		const t = convexTest(schema, modules);
		const write = (feature: string, tokens: number | undefined) =>
			t.mutation(internal.analytics.llmUsage.recordRequests, {
				feature,
				requests: [
					{
						attempt: 1,
						latencyMs: 1,
						modelUsed: 'gpt-4o',
						...(tokens === undefined
							? {}
							: { usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens } }),
					},
				],
			});
		await write('agent_draft', 1_000_000); // $2.50, standard
		await write('agent_draft', 400_000); // $1.00, standard
		await write('agent_security_scan', 200_000); // $0.50, triage
		await write('agent_draft', undefined); // estimated, $0

		await t.run(async (ctx) => {
			const buckets = await ctx.db.query('llmSpendPeriods').collect();
			const pick = (kind: 'day' | 'month', budgetClass: 'standard' | 'triage') =>
				buckets.filter((b) => b.periodKind === kind && b.budgetClass === budgetClass);
			for (const kind of ['day', 'month'] as const) {
				const [standard] = pick(kind, 'standard');
				const [triage] = pick(kind, 'triage');
				expect(pick(kind, 'standard')).toHaveLength(1);
				expect(standard).toMatchObject({
					plane: 'language',
					settledMicrousd: 3_500_000,
					estimatedMicrousd: 0,
					eventCount: 3,
					generation: 0,
				});
				expect(triage).toMatchObject({ settledMicrousd: 500_000, eventCount: 1 });
			}
			const rows = await ctx.db.query('llmUsageEvents').collect();
			const total = rows.reduce((sum, row) => sum + (row.costMicrousd ?? 0), 0);
			const days = pick('day', 'standard').concat(pick('day', 'triage'));
			expect(days.reduce((sum, b) => sum + b.settledMicrousd, 0)).toBe(total);
		});
	});

	it('starts a bucket from an older generation again instead of adding to it', async () => {
		const t = convexTest(schema, modules);
		const keys = spendPeriodKeys(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert('llmSpendAggregateState', {
				status: 'rebuilding',
				generation: 2,
				scannedCount: 0,
				updatedAt: 0,
			});
			await ctx.db.insert('llmSpendPeriods', {
				periodKind: 'day',
				periodKey: keys.day,
				plane: 'language',
				budgetClass: 'standard',
				settledMicrousd: 9_999,
				estimatedMicrousd: 0,
				eventCount: 7,
				generation: 1,
				updatedAt: 0,
			});
		});
		await t.mutation(internal.analytics.llmUsage.recordRequests, {
			feature: 'agent_draft',
			requests: [
				{
					attempt: 1,
					latencyMs: 1,
					modelUsed: 'gpt-4o',
					usage: { promptTokens: 400_000, completionTokens: 0, totalTokens: 400_000 },
				},
			],
		});
		await t.run(async (ctx) => {
			const buckets = await ctx.db.query('llmSpendPeriods').collect();
			const day = buckets.find((b) => b.periodKind === 'day');
			const month = buckets.find((b) => b.periodKind === 'month');
			expect(day).toMatchObject({ settledMicrousd: 1_000_000, eventCount: 1, generation: 2 });
			expect(month).toMatchObject({ settledMicrousd: 1_000_000, eventCount: 1, generation: 2 });
		});
	});

	it('writes a request once, however often its batch is retried', async () => {
		const t = convexTest(schema, modules);
		const batch = {
			feature: 'agent_draft',
			requestId: 'req-retried',
			requests: [
				{
					attempt: 1,
					latencyMs: 1,
					modelUsed: 'gpt-4o',
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				},
			],
		};
		await t.mutation(internal.analytics.llmUsage.recordRequests, batch);
		await t.mutation(internal.analytics.llmUsage.recordRequests, {
			...batch,
			requests: [...batch.requests, { ...batch.requests[0]!, attempt: 2 }],
		});
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('llmUsageEvents').collect();
			expect(rows.map((row) => row.attempt).sort()).toEqual([1, 2]);
			const days = (await ctx.db.query('llmSpendPeriods').collect()).filter(
				(b) => b.periodKind === 'day'
			);
			expect(days.reduce((sum, b) => sum + b.eventCount, 0)).toBe(2);
		});
	});

	it('prices a local embedder at zero and a hosted one at its listed rate, and marks an unknown price', async () => {
		const t = convexTest(schema, modules);
		const write = (requestId: string, modelUsed: string, isLocalEngine?: boolean) =>
			t.mutation(internal.analytics.llmUsage.recordRequests, {
				feature: 'embedding_knowledge',
				requestId,
				requests: [
					{
						attempt: 1,
						latencyMs: 1,
						modelUsed,
						...(isLocalEngine ? { isLocalEngine } : {}),
						usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
					},
				],
			});
		await write('local', 'nomic-embed-text', true);
		await write('openai', 'text-embedding-3-small');
		await write('google-legacy', 'text-embedding-004');
		await write('chat-unknown', 'qwen3.6:27b');

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('llmUsageEvents').collect();
			const by = (id: string) => rows.find((row) => row.requestId === id)!;
			expect(by('local')).toMatchObject({ costUsd: 0, isLocalEngine: true, isEstimated: false });
			expect(by('local').plane).toBe('embedding');
			expect(by('openai')).toMatchObject({ costMicrousd: 20_000, isEstimated: false });
			// Unlisted: the dearest embedding rate, never a chat model's, and an estimate.
			expect(by('google-legacy')).toMatchObject({ costMicrousd: 200_000, isEstimated: true });
			// The embedding task, whatever model id: priced as an embedding.
			expect(by('chat-unknown')).toMatchObject({ costMicrousd: 200_000, isEstimated: true });
		});
	});

	it('prices a language request on the operator’s own server at zero, and one without usage as unknown', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.analytics.llmUsage.recordRequests, {
			feature: 'agent_draft',
			requestId: 'ollama',
			requests: [
				{
					attempt: 1,
					latencyMs: 1,
					modelUsed: 'qwen3.6:27b',
					isLocalEngine: true,
					usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
				},
				// The provider reported no usage: unknown, so an estimate.
				{ attempt: 2, latencyMs: 1, modelUsed: 'gpt-4o' },
			],
		});
		await t.run(async (ctx) => {
			const rows = (await ctx.db.query('llmUsageEvents').collect()).sort(
				(a, b) => (a.attempt ?? 0) - (b.attempt ?? 0)
			);
			expect(rows[0]).toMatchObject({ costUsd: 0, isLocalEngine: true, isEstimated: false });
			expect(rows[1]).toMatchObject({ costUsd: 0, isEstimated: true, totalTokens: 0 });
		});
	});

	it('marks a language row priced at the unknown-model fallback as an estimate', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.analytics.llmUsage.recordRequests, {
			feature: 'agent_draft',
			requestId: 'unknown-chat',
			requests: [
				{
					attempt: 1,
					latencyMs: 1,
					modelUsed: 'qwen3.6:27b',
					usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
				},
			],
		});
		await t.run(async (ctx) => {
			const [row] = await ctx.db.query('llmUsageEvents').collect();
			expect(row).toMatchObject({ isEstimated: true });
			expect(row!.costUsd).toBeGreaterThan(0);
		});
	});

	it('refuses an unbounded batch', async () => {
		const t = convexTest(schema, modules);
		const requests = Array.from({ length: MAX_METERED_REQUESTS_PER_WRITE + 1 }, (_, i) => ({
			attempt: i + 1,
			latencyMs: 1,
		}));
		await expect(
			t.mutation(internal.analytics.llmUsage.recordRequests, { feature: 'agent_draft', requests })
		).rejects.toThrow(/Too many metered requests/);
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

describe('settlement rows in the spend dashboard (Sol r6 F1)', () => {
	it('counts an estimate and a late offset in the spend, never as calls', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		try {
			const t = convexTest(schema, modules);
			await reconcileSpend(t);
			const hold = (reservationId: string, expiresAt: number) =>
				t.mutation(internal.aiRouting.admission.reserve, {
					reservationId,
					rootRequestId: `postbox_action:${reservationId}`,
					plane: 'language',
					task: 'mail.ask',
					budgetClass: 'standard',
					priority: 'pipeline',
					heldMicrousd: 1_000_000,
					maxRequests: 1,
					requestBound: { requestId: reservationId, attempt: 1, microusd: 1_000_000 },
					modelId: 'gpt-4o',
					expiresAt,
				});
			const request = (
				reservationId: string,
				usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
			) =>
				t.mutation(internal.analytics.llmUsage.recordRequests, {
					feature: 'postbox_ask_thread',
					requestId: reservationId,
					requests: [
						{
							attempt: 1,
							latencyMs: 1,
							modelUsed: 'gpt-4o',
							reservationId,
							...(usage ? { usage } : {}),
						},
					],
				});

			// 1. A request of unknown usage: settled with an estimate row.
			await hold('estimated', Date.now() + 60_000);
			await request('estimated');
			await t.mutation(internal.aiRouting.admission.settle, {
				reservationId: 'estimated',
				expectedRequests: 1,
			});
			// 2. A hold swept on expiry (estimate), then its row lands late (offset).
			await hold('late', Date.now() - 1);
			await t.mutation(internal.aiRouting.admission.sweepExpiredHolds, {});
			await request('late', { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 });

			const rows = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
			const settlementRows = rows.filter((r) => r.feature === SETTLEMENT_FEATURE);
			// An estimate per hold and the late row's offset.
			expect(settlementRows).toHaveLength(3);
			const spend = rows.reduce((sum, r) => sum + r.costUsd, 0);

			const byFeature = await t.query(api.analytics.llmUsage.getSpendByFeature, {});
			expect(byFeature.features.find((f) => f.feature === 'postbox_ask_thread')?.calls).toBe(2);
			expect(byFeature.features.find((f) => f.feature === SETTLEMENT_FEATURE)?.calls).toBe(0);
			expect(byFeature.features.reduce((sum, f) => sum + f.calls, 0)).toBe(2);
			expect(byFeature.totalCostUsd).toBeCloseTo(spend);

			const byProvider = await t.query(api.analytics.llmUsage.getSpendByProvider, {});
			expect(byProvider.providers.reduce((sum, p) => sum + p.calls, 0)).toBe(2);
			expect(byProvider.totalCostUsd).toBeCloseTo(spend);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('tenant-scoped LLM spend reads', () => {
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
	});

	it('shares one bounded spend-window validator across feature and provider reads', async () => {
		const t = convexTest(schema, modules);
		for (const call of [
			t.query(api.analytics.llmUsage.getSpendByFeature, { hoursBack: -1 }),
			t.query(api.analytics.llmUsage.getSpendByProvider, { hoursBack: Number.POSITIVE_INFINITY }),
		]) {
			await expect(call).rejects.toThrow('Invalid LLM spend window');
		}
	});
});
