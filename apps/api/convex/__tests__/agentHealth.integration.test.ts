import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestAgentMetric, createTestAgentAction, createTestInboundMessage } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
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
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') && !path.includes('agentSecurity') && !path.includes('agentContext') && !path.includes('agentClassifier') && !path.includes('agentDrafter') && !path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') && !path.includes('knowledgeExtraction') && !path.includes('semanticFileProcessing') && !path.includes('visualizationAgent') && !path.includes('llmProvider')
	)
);

// ============ getDashboardMetrics ============

describe('agentHealth.getDashboardMetrics', () => {
	it('should return dashboard metrics structure with defaults', async () => {
		const t = convexTest(schema, modules);
		const metrics = await t.query(api.agentHealth.getDashboardMetrics);

		expect(metrics).toHaveProperty('queueDepth');
		expect(metrics).toHaveProperty('processingCount');
		expect(metrics).toHaveProperty('processingLatencyMs');
		expect(metrics).toHaveProperty('errorRate');
		expect(metrics).toHaveProperty('circuitBreakers');
		expect(metrics.queueDepth).toBe(0);
		expect(metrics.circuitBreakers).toEqual([]);
	});

	it('should include circuit breakers in dashboard metrics', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('agentCircuitBreakers', {
				breakerType: 'llm_failure',
				state: 'open',
				threshold: 0.2,
				currentValue: 0.35,
				trippedAt: Date.now(),
				createdAt: Date.now(),
			});
		});

		const metrics = await t.query(api.agentHealth.getDashboardMetrics);
		expect(metrics.circuitBreakers).toHaveLength(1);
		expect(metrics.circuitBreakers[0]!.type).toBe('llm_failure');
		expect(metrics.circuitBreakers[0]!.state).toBe('open');
	});
});

// ============ getMetricHistory ============

describe('agentHealth.getMetricHistory', () => {
	it('should return empty array when no metrics exist', async () => {
		const t = convexTest(schema, modules);
		const history = await t.query(api.agentHealth.getMetricHistory, { metricType: 'queue_depth' });
		expect(history).toEqual([]);
	});

	it('should return metrics for the requested type', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await t.run(async (ctx) => {
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'queue_depth',
				value: 10,
				windowStart: now - 60000,
				windowEnd: now,
				createdAt: now,
			}));
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'error_rate',
				value: 0.05,
				windowStart: now - 60000,
				windowEnd: now,
				createdAt: now,
			}));
		});

		const history = await t.query(api.agentHealth.getMetricHistory, { metricType: 'queue_depth' });
		expect(history).toHaveLength(1);
		expect(history[0]!.value).toBe(10);
	});
});

// ============ recordMetric (internal) ============

describe('agentHealth.recordMetric', () => {
	it('should insert a metric data point', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await t.mutation(internal.agentHealth.recordMetric, {
			metricType: 'processing_latency',
			value: 250,
			windowStart: now - 300000,
			windowEnd: now,
		});

		await t.run(async (ctx) => {
			const metrics = await ctx.db.query('agentMetrics').collect();
			expect(metrics).toHaveLength(1);
			expect(metrics[0]!.metricType).toBe('processing_latency');
			expect(metrics[0]!.value).toBe(250);
			expect(metrics[0]!.createdAt).toBeTypeOf('number');
		});
	});
});

// ============ updateCircuitBreaker (internal) ============

describe('agentHealth.updateCircuitBreaker', () => {
	it('should create a new circuit breaker when none exists', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.agentHealth.updateCircuitBreaker, {
			breakerType: 'llm_failure',
			state: 'closed',
			currentValue: 0.05,
		});

		await t.run(async (ctx) => {
			const breakers = await ctx.db.query('agentCircuitBreakers').collect();
			expect(breakers).toHaveLength(1);
			expect(breakers[0]!.breakerType).toBe('llm_failure');
			expect(breakers[0]!.state).toBe('closed');
			expect(breakers[0]!.threshold).toBe(0.2); // default for llm_failure
			expect(breakers[0]!.currentValue).toBe(0.05);
		});
	});

	it('should set trippedAt when transitioning to open', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('agentCircuitBreakers', {
				breakerType: 'llm_failure',
				state: 'closed',
				threshold: 0.2,
				currentValue: 0.1,
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.agentHealth.updateCircuitBreaker, {
			breakerType: 'llm_failure',
			state: 'open',
			currentValue: 0.35,
		});

		await t.run(async (ctx) => {
			const breaker = await ctx.db
				.query('agentCircuitBreakers')
				.withIndex('by_breaker_type', (q) => q.eq('breakerType', 'llm_failure'))
				.first();
			expect(breaker!.state).toBe('open');
			expect(breaker!.trippedAt).toBeTypeOf('number');
		});
	});

	it('should set recoveredAt when transitioning to closed from open', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('agentCircuitBreakers', {
				breakerType: 'rejection_spike',
				state: 'open',
				threshold: 0.4,
				currentValue: 0.5,
				trippedAt: Date.now() - 60000,
				createdAt: Date.now() - 120000,
			});
		});

		await t.mutation(internal.agentHealth.updateCircuitBreaker, {
			breakerType: 'rejection_spike',
			state: 'closed',
			currentValue: 0.1,
		});

		await t.run(async (ctx) => {
			const breaker = await ctx.db
				.query('agentCircuitBreakers')
				.withIndex('by_breaker_type', (q) => q.eq('breakerType', 'rejection_spike'))
				.first();
			expect(breaker!.state).toBe('closed');
			expect(breaker!.recoveredAt).toBeTypeOf('number');
		});
	});
});

// ============ cleanupOldMetrics (internal) ============

describe('agentHealth.cleanupOldMetrics', () => {
	it('should remove metrics older than 7 days', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

		await t.run(async (ctx) => {
			// Old metric (should be deleted)
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				windowStart: eightDaysAgo,
				windowEnd: eightDaysAgo + 300000,
				createdAt: eightDaysAgo,
			}));
			// Recent metric (should be kept)
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				windowStart: now - 60000,
				windowEnd: now,
				createdAt: now,
			}));
		});

		await t.mutation(internal.agentHealth.cleanupOldMetrics);

		await t.run(async (ctx) => {
			const metrics = await ctx.db.query('agentMetrics').collect();
			expect(metrics).toHaveLength(1);
			expect(metrics[0]!.windowStart).toBeGreaterThan(eightDaysAgo);
		});
	});
});

// ============ getCostByStep ============

describe('agentHealth.getCostByStep', () => {
	it('returns empty steps and zero total when no actions exist', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.agentHealth.getCostByStep, {});
		expect(result.steps).toEqual([]);
		expect(result.totalTokens).toBe(0);
		expect(result.hoursBack).toBe(24);
	});

	it('sums token usage grouped by actionType (pipeline step)', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const messageId = await ctx.db.insert('inboundMessages', createTestInboundMessage({ threadId: undefined, contactId: undefined }));
			// Two classify actions, one draft action, one with no tokenUsage.
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'classify',
				status: 'completed',
				tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
			}));
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'classify',
				status: 'completed',
				tokenUsage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
			}));
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'draft',
				status: 'completed',
				tokenUsage: { promptTokens: 200, completionTokens: 300, totalTokens: 500 },
			}));
			// No tokenUsage — must be ignored, not counted as a step.
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'security_scan',
				status: 'completed',
			}));
		});

		const result = await t.query(api.agentHealth.getCostByStep, {});

		// Only steps that incurred tokens appear.
		expect(result.steps.map((s) => s.step)).toEqual(['draft', 'classify']);
		expect(result.totalTokens).toBe(700);

		const draft = result.steps.find((s) => s.step === 'draft')!;
		expect(draft.totalTokens).toBe(500);
		expect(draft.promptTokens).toBe(200);
		expect(draft.completionTokens).toBe(300);
		expect(draft.actionCount).toBe(1);

		const classify = result.steps.find((s) => s.step === 'classify')!;
		expect(classify.totalTokens).toBe(200);
		expect(classify.promptTokens).toBe(150);
		expect(classify.completionTokens).toBe(50);
		expect(classify.actionCount).toBe(2);
	});

	it('orders steps by total tokens descending', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const messageId = await ctx.db.insert('inboundMessages', createTestInboundMessage({ threadId: undefined, contactId: undefined }));
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'classify',
				tokenUsage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
			}));
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'draft',
				tokenUsage: { promptTokens: 90, completionTokens: 0, totalTokens: 90 },
			}));
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'route',
				tokenUsage: { promptTokens: 50, completionTokens: 0, totalTokens: 50 },
			}));
		});

		const result = await t.query(api.agentHealth.getCostByStep, {});
		expect(result.steps.map((s) => s.step)).toEqual(['draft', 'route', 'classify']);
	});

	it('estimates a non-zero dollar cost per step and in total', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const messageId = await ctx.db.insert('inboundMessages', createTestInboundMessage({ threadId: undefined, contactId: undefined }));
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'draft',
				tokenUsage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
			}));
		});

		const result = await t.query(api.agentHealth.getCostByStep, {});
		expect(result.totalCostUsd).toBeGreaterThan(0);
		expect(result.steps[0]!.costUsd).toBeGreaterThan(0);
		// Cost is bounded sanely for 2k tokens at any reasonable price (<$1).
		expect(result.totalCostUsd).toBeLessThan(1);
	});
});

// ============ getAccuracyTrend ============

describe('agentHealth.getAccuracyTrend', () => {
	it('returns an empty series when no metrics exist', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.agentHealth.getAccuracyTrend, {});
		expect(result.series).toEqual([]);
		expect(result.hoursBack).toBe(24);
	});

	it('aligns auto_approve_ratio and rejection_rate by window start', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const w1 = now - 10 * 60 * 1000;
		const w2 = now - 5 * 60 * 1000;

		await t.run(async (ctx) => {
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'auto_approve_ratio', value: 0.8, windowStart: w1, windowEnd: w1 + 300000, createdAt: w1,
			}));
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'rejection_rate', value: 0.1, windowStart: w1, windowEnd: w1 + 300000, createdAt: w1,
			}));
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'auto_approve_ratio', value: 0.6, windowStart: w2, windowEnd: w2 + 300000, createdAt: w2,
			}));
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'rejection_rate', value: 0.3, windowStart: w2, windowEnd: w2 + 300000, createdAt: w2,
			}));
			// An unrelated metric type must not leak into the trend.
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'queue_depth', value: 99, windowStart: w2, windowEnd: w2 + 300000, createdAt: w2,
			}));
		});

		const result = await t.query(api.agentHealth.getAccuracyTrend, {});

		expect(result.series).toHaveLength(2);
		// Ascending by windowStart.
		expect(result.series[0]).toMatchObject({ windowStart: w1, autoApproveRatio: 0.8, rejectionRate: 0.1 });
		expect(result.series[1]).toMatchObject({ windowStart: w2, autoApproveRatio: 0.6, rejectionRate: 0.3 });
	});

	it('defaults the missing series value to 0 when only one type is recorded for a window', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const w = now - 5 * 60 * 1000;

		await t.run(async (ctx) => {
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'auto_approve_ratio', value: 0.5, windowStart: w, windowEnd: w + 300000, createdAt: w,
			}));
		});

		const result = await t.query(api.agentHealth.getAccuracyTrend, {});
		expect(result.series).toHaveLength(1);
		expect(result.series[0]).toMatchObject({ windowStart: w, autoApproveRatio: 0.5, rejectionRate: 0 });
	});

	it('excludes metrics outside the hoursBack window', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - 48 * 60 * 60 * 1000; // 2 days ago, outside a 24h window

		await t.run(async (ctx) => {
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'auto_approve_ratio', value: 0.9, windowStart: old, windowEnd: old + 300000, createdAt: old,
			}));
			await ctx.db.insert('agentMetrics', createTestAgentMetric({
				metricType: 'auto_approve_ratio', value: 0.4, windowStart: now - 60000, windowEnd: now, createdAt: now,
			}));
		});

		const result = await t.query(api.agentHealth.getAccuracyTrend, { hoursBack: 24 });
		expect(result.series).toHaveLength(1);
		expect(result.series[0]!.autoApproveRatio).toBe(0.4);
	});
});

// ============ rollupMetrics (internal action) ============

describe('agentHealth.rollupMetrics', () => {
	it('records classification_accuracy as the mean confidence of classify actions', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const messageId = await ctx.db.insert('inboundMessages', createTestInboundMessage({ threadId: undefined, contactId: undefined }));
			// Two classify actions with known confidence: mean = (0.8 + 0.4) / 2 = 0.6.
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'classify',
				status: 'completed',
				output: JSON.stringify({ confidence: 0.8 }),
			}));
			await ctx.db.insert('agentActions', createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'classify',
				status: 'completed',
				output: JSON.stringify({ confidence: 0.4 }),
			}));
		});

		await t.action(internal.agentHealth.rollupMetrics);

		const history = await t.query(api.agentHealth.getMetricHistory, { metricType: 'classification_accuracy' });
		expect(history).toHaveLength(1);
		expect(history[0]!.value).toBeCloseTo(0.6, 5);
	});

	it('records classification_accuracy as 0 when there are no scored classify actions', async () => {
		const t = convexTest(schema, modules);

		await t.action(internal.agentHealth.rollupMetrics);

		const history = await t.query(api.agentHealth.getMetricHistory, { metricType: 'classification_accuracy' });
		expect(history).toHaveLength(1);
		expect(history[0]!.value).toBe(0);
	});
});

// ============ getCircuitBreakers ============

describe('agentHealth.getCircuitBreakers', () => {
	it('should return empty array when no breakers exist', async () => {
		const t = convexTest(schema, modules);
		const breakers = await t.query(api.agentHealth.getCircuitBreakers);
		expect(breakers).toEqual([]);
	});

	it('should return all breaker states', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('agentCircuitBreakers', {
				breakerType: 'llm_failure',
				state: 'closed',
				threshold: 0.2,
				currentValue: 0.05,
				createdAt: Date.now(),
			});
			await ctx.db.insert('agentCircuitBreakers', {
				breakerType: 'confidence_degradation',
				state: 'half_open',
				threshold: 0.3,
				currentValue: 0.25,
				createdAt: Date.now(),
			});
		});

		const breakers = await t.query(api.agentHealth.getCircuitBreakers);
		expect(breakers).toHaveLength(2);
		const types = breakers.map((b) => b.breakerType);
		expect(types).toContain('llm_failure');
		expect(types).toContain('confidence_degradation');
	});
});
