/**
 * The agent config and health endpoints (`agent/configMutations`,
 * `agent/health`, `agent/healthRollup`): what each reads and writes, and the
 * auth floor each keeps.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { OrganizationRole } from '../lib/sessionOrganization';
import type * as SessionOrganizationModule from '../lib/sessionOrganization';
import {
	createTestAgentAction,
	createTestAgentMetric,
	createTestInboundMessage,
} from './factories';

let mockRole: OrganizationRole = 'owner';
let isMember = true;

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../lib/sessionOrganization'
	);
	const session = () => ({ userId: 'test-user', role: mockRole });
	const denied = () => new Error("You don't have permission to perform this action");
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn(async () => isMember),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => session()),
		// The adminMutation floor.
		requireAdminContext: vi.fn(async () => {
			if (mockRole === 'editor') throw denied();
			return session();
		}),
		// The adminQuery floor: owner/admin pass `organization:manage`, editor does not.
		requireOrgPermission: vi.fn(async () => {
			if (mockRole === 'editor') throw denied();
			return session();
		}),
	};
});

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

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
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

type T = ReturnType<typeof convexTest>;

/** A pipeline window with every input the health reads and the rollup look at. */
async function seedPipeline(t: T) {
	await t.run(async (ctx) => {
		const messageId = await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({ threadId: undefined, contactId: undefined })
		);
		await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				threadId: undefined,
				contactId: undefined,
				processingStatus: 'classifying',
			})
		);
		await ctx.db.insert(
			'agentActions',
			createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'classify',
				status: 'completed',
				durationMs: 400,
				output: JSON.stringify({ confidence: 0.3 }),
				tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
			})
		);
		await ctx.db.insert(
			'agentActions',
			createTestAgentAction({
				inboundMessageId: messageId,
				actionType: 'draft',
				status: 'failed',
				tokenUsage: { promptTokens: 200, completionTokens: 300, totalTokens: 500 },
			})
		);
		// One rollup window for every metric, inside the dashboard's five-minute
		// window: the accuracy trend joins its two series on the exact start.
		const windowStart = Date.now() - 60_000;
		for (const [metricType, value] of [
			['auto_approve_ratio', 0.6],
			['rejection_rate', 0.1],
			['processing_latency', 900],
		] as const) {
			await ctx.db.insert(
				'agentMetrics',
				createTestAgentMetric({ metricType, value, windowStart })
			);
		}
		await ctx.db.insert('agentCircuitBreakers', {
			breakerType: 'llm_failure',
			state: 'open',
			threshold: 0.2,
			currentValue: 0.5,
			trippedAt: 1_000,
			createdAt: 1_000,
		});
	});
}

/** Metric rows and breakers without ids or timestamps. */
async function rollupResult(t: T) {
	return await t.run(async (ctx) => {
		const metrics = await ctx.db.query('agentMetrics').collect();
		const breakers = await ctx.db.query('agentCircuitBreakers').collect();
		return {
			metrics: metrics.map((m) => [m.metricType, m.value]).sort(),
			breakers: breakers.map((b) => [b.breakerType, b.state, b.currentValue]).sort(),
		};
	});
}

const NOW = Date.UTC(2026, 9, 21, 8, 0);

beforeEach(() => {
	// The seeds and the health reads both take their windows from the clock, so
	// a millisecond tick between two of them would split or drop a window.
	vi.useFakeTimers({ toFake: ['Date'], now: NOW });
	mockRole = 'owner';
	isMember = true;
});
afterEach(() => {
	vi.useRealTimers();
});

describe('agent config endpoints', () => {
	it('reads and writes the config, normalising working hours and logging each write', async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(identity);

		expect(await user.query(api.agent.configMutations.getConfig, {})).toBeNull();

		const configId = await user.mutation(api.agent.configMutations.updateConfig, {
			confidenceThreshold: 0.7,
			workingHoursStart: 2000,
			workingHoursDays: [5, 1, 1, 9],
		});
		expect(await user.query(api.agent.configMutations.getConfig, {})).toMatchObject({
			_id: configId,
			confidenceThreshold: 0.7,
			workingHoursStart: 1439,
			workingHoursDays: [1, 5],
		});

		expect(
			await user.mutation(api.agent.configMutations.updateConfig, { toneDescription: 'calm' })
		).toBe(configId);
		expect(
			await user.mutation(api.agent.configMutations.setReplyMode, { mode: 'auto' })
		).toBeNull();
		expect(await user.query(api.agent.configMutations.getConfig, {})).toMatchObject({
			toneDescription: 'calm',
			isAutoReplyEnabled: true,
			isShadowMode: false,
		});

		await user.mutation(api.agent.configMutations.setReplyMode, { mode: 'draft' });
		expect(await user.query(api.agent.configMutations.getConfig, {})).toMatchObject({
			isAutoReplyEnabled: false,
			isShadowMode: true,
		});
		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((row) => [row.action, row.userId])).toEqual([
			['agent.config_updated', 'test-user'],
			['agent.config_updated', 'test-user'],
			['agent.config_updated', 'test-user'],
			['agent.config_updated', 'test-user'],
		]);

		isMember = false;
		expect(await user.query(api.agent.configMutations.getConfig, {})).toBeNull();
	});

	it('keep the owner/admin floor on the writes', async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(identity);
		mockRole = 'editor';
		const denied = "You don't have permission to perform this action";
		await expect(
			user.mutation(api.agent.configMutations.updateConfig, { confidenceThreshold: 0.1 })
		).rejects.toThrow(denied);
		await expect(
			user.mutation(api.agent.configMutations.setReplyMode, { mode: 'auto' })
		).rejects.toThrow(denied);
		expect(await t.run((ctx) => ctx.db.query('agentConfig').collect())).toEqual([]);
	});
});

describe('agent health endpoints', () => {
	it('read the pipeline window the health dashboard and the rollup see', async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(identity);
		await seedPipeline(t);

		const dashboard = await user.query(api.agent.health.getDashboardMetrics, {});
		expect(dashboard).toMatchObject({ queueDepth: 1, processingCount: 1, autoApproveRatio: 0.6 });

		const historyArgs = { metricType: 'processing_latency' as const, hoursBack: 2 };
		const history = await user.query(api.agent.health.getMetricHistory, historyArgs);
		expect(history.map((m) => m.value)).toEqual([900]);

		const cost = await user.query(api.agent.health.getCostByStep, { hoursBack: 2 });
		expect(cost).toMatchObject({ totalTokens: 620, hoursBack: 2 });

		const trend = await user.query(api.agent.health.getAccuracyTrend, {});
		expect(trend.series).toMatchObject([{ autoApproveRatio: 0.6, rejectionRate: 0.1 }]);

		const breakers = await t.query(internal.agent.health.getCircuitBreakersInternal, {});
		expect(breakers.map((b) => [b.breakerType, b.state])).toEqual([['llm_failure', 'open']]);

		const recent = await t.query(internal.agent.healthRollup.getRecentActions, { since: 0 });
		expect(recent.map((a) => a.actionType).sort()).toEqual(['classify', 'draft']);

		expect(await t.query(internal.agent.healthRollup.getPendingCount, {})).toBe(1);
	});

	it('a rollup writes the window metrics and trips the breakers they cross', async () => {
		const t = convexTest(schema, modules);
		await seedPipeline(t);
		expect(await t.action(internal.agent.healthRollup.rollupMetrics, {})).toBeNull();

		const written = await rollupResult(t);
		// One of two actions failed, and the only classification is unsure.
		expect(written.metrics).toContainEqual(['error_rate', 0.5]);
		expect(written.breakers).toContainEqual(['confidence_degradation', 'open', 1]);
	});

	it('keep the owner/admin floor on every public read', async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(identity);
		mockRole = 'editor';
		const denied = "You don't have permission to perform this action";
		await expect(user.query(api.agent.health.getDashboardMetrics, {})).rejects.toThrow(denied);
		await expect(
			user.query(api.agent.health.getMetricHistory, { metricType: 'queue_depth' })
		).rejects.toThrow(denied);
		await expect(user.query(api.agent.health.getCostByStep, {})).rejects.toThrow(denied);
		await expect(user.query(api.agent.health.getAccuracyTrend, {})).rejects.toThrow(denied);
	});
});
