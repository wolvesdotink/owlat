/**
 * The previous release's agent config and health paths
 * (`agentConfigMutations:*`, `agentHealth:*`) keep working against this
 * release: each old path takes the same arguments, returns what its moved
 * function returns, writes what it writes, and keeps its auth floor.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { OrganizationRole } from '../lib/sessionOrganization';
import type * as SessionOrganizationModule from '../lib/sessionOrganization';
import * as oldConfigPaths from '../agentConfigMutations';
import * as oldHealthPaths from '../agentHealth';
import * as configMutations from '../agent/configMutations';
import * as health from '../agent/health';
import * as healthRollup from '../agent/healthRollup';
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
			!path.includes('semanticFileProcessing') &&
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

/** Metric rows and breakers without ids or timestamps, for comparing two rollups. */
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

describe('previous-release agent config paths', () => {
	it('take the same arguments and declare the same result as the moved functions', () => {
		const shape = (fn: unknown) => {
			const registered = fn as { exportArgs(): string; exportReturns(): string };
			return { args: registered.exportArgs(), returns: registered.exportReturns() };
		};
		const pairs: [unknown, unknown][] = [
			[oldConfigPaths.getConfig, configMutations.getConfig],
			[oldConfigPaths.updateConfig, configMutations.updateConfig],
			[oldConfigPaths.setReplyMode, configMutations.setReplyMode],
			[oldHealthPaths.getDashboardMetrics, health.getDashboardMetrics],
			[oldHealthPaths.getMetricHistory, health.getMetricHistory],
			[oldHealthPaths.getCostByStep, health.getCostByStep],
			[oldHealthPaths.getAccuracyTrend, health.getAccuracyTrend],
			[oldHealthPaths.getCircuitBreakersInternal, health.getCircuitBreakersInternal],
			[oldHealthPaths.rollupMetrics, healthRollup.rollupMetrics],
			[oldHealthPaths.getRecentActions, healthRollup.getRecentActions],
			[oldHealthPaths.getPendingCount, healthRollup.getPendingCount],
		];
		for (const [old, moved] of pairs) expect(shape(old)).toEqual(shape(moved));
		expect(Object.keys(JSON.parse(shape(oldConfigPaths.updateConfig).args).value)).toHaveLength(13);
	});

	it('reads and writes through agentConfigMutations:* match agent/configMutations', async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(identity);

		expect(await user.query(api.agentConfigMutations.getConfig, {})).toBeNull();

		const configId = await user.mutation(api.agentConfigMutations.updateConfig, {
			confidenceThreshold: 0.7,
			workingHoursStart: 2000,
			workingHoursDays: [5, 1, 1, 9],
		});
		const oldConfig = await user.query(api.agentConfigMutations.getConfig, {});
		expect(oldConfig).toEqual(await user.query(api.agent.configMutations.getConfig, {}));
		expect(oldConfig).toMatchObject({
			_id: configId,
			confidenceThreshold: 0.7,
			workingHoursStart: 1439,
			workingHoursDays: [1, 5],
		});

		expect(
			await user.mutation(api.agentConfigMutations.updateConfig, { toneDescription: 'calm' })
		).toBe(configId);
		expect(await user.mutation(api.agentConfigMutations.setReplyMode, { mode: 'auto' })).toBeNull();
		expect(await user.query(api.agent.configMutations.getConfig, {})).toMatchObject({
			toneDescription: 'calm',
			isAutoReplyEnabled: true,
			isShadowMode: false,
		});

		await user.mutation(api.agentConfigMutations.setReplyMode, { mode: 'draft' });
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
		expect(await user.query(api.agentConfigMutations.getConfig, {})).toBeNull();
	});

	it('keep the owner/admin floor on the old write paths', async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(identity);
		mockRole = 'editor';
		const denied = "You don't have permission to perform this action";
		await expect(
			user.mutation(api.agentConfigMutations.updateConfig, { confidenceThreshold: 0.1 })
		).rejects.toThrow(denied);
		await expect(
			user.mutation(api.agentConfigMutations.setReplyMode, { mode: 'auto' })
		).rejects.toThrow(denied);
		expect(await t.run((ctx) => ctx.db.query('agentConfig').collect())).toEqual([]);
	});
});

describe('previous-release agent health paths', () => {
	it('reads through agentHealth:* match agent/health and agent/healthRollup', async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(identity);
		await seedPipeline(t);

		const dashboard = await user.query(api.agentHealth.getDashboardMetrics, {});
		expect(dashboard).toEqual(await user.query(api.agent.health.getDashboardMetrics, {}));
		expect(dashboard).toMatchObject({ queueDepth: 1, processingCount: 1, autoApproveRatio: 0.6 });

		const historyArgs = { metricType: 'processing_latency' as const, hoursBack: 2 };
		const history = await user.query(api.agentHealth.getMetricHistory, historyArgs);
		expect(history).toEqual(await user.query(api.agent.health.getMetricHistory, historyArgs));
		expect(history.map((m) => m.value)).toEqual([900]);

		const cost = await user.query(api.agentHealth.getCostByStep, { hoursBack: 2 });
		expect(cost).toEqual(await user.query(api.agent.health.getCostByStep, { hoursBack: 2 }));
		expect(cost).toMatchObject({ totalTokens: 620, hoursBack: 2 });

		const trend = await user.query(api.agentHealth.getAccuracyTrend, {});
		expect(trend).toEqual(await user.query(api.agent.health.getAccuracyTrend, {}));
		expect(trend.series).toMatchObject([{ autoApproveRatio: 0.6, rejectionRate: 0.1 }]);

		const breakers = await t.query(internal.agentHealth.getCircuitBreakersInternal, {});
		expect(breakers).toEqual(await t.query(internal.agent.health.getCircuitBreakersInternal, {}));
		expect(breakers.map((b) => [b.breakerType, b.state])).toEqual([['llm_failure', 'open']]);

		const recent = await t.query(internal.agentHealth.getRecentActions, { since: 0 });
		expect(recent).toEqual(
			await t.query(internal.agent.healthRollup.getRecentActions, { since: 0 })
		);
		expect(recent.map((a) => a.actionType).sort()).toEqual(['classify', 'draft']);

		const pending = await t.query(internal.agentHealth.getPendingCount, {});
		expect(pending).toBe(await t.query(internal.agent.healthRollup.getPendingCount, {}));
		expect(pending).toBe(1);
	});

	it('a rollup through agentHealth:rollupMetrics writes what agent/healthRollup writes', async () => {
		const viaOld = convexTest(schema, modules);
		await seedPipeline(viaOld);
		expect(await viaOld.action(internal.agentHealth.rollupMetrics, {})).toBeNull();

		const viaNew = convexTest(schema, modules);
		await seedPipeline(viaNew);
		await viaNew.action(internal.agent.healthRollup.rollupMetrics, {});

		const written = await rollupResult(viaOld);
		expect(written).toEqual(await rollupResult(viaNew));
		// One of two actions failed, and the only classification is unsure.
		expect(written.metrics).toContainEqual(['error_rate', 0.5]);
		expect(written.breakers).toContainEqual(['confidence_degradation', 'open', 1]);
	});

	it('keep the owner/admin floor on every old public read', async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(identity);
		mockRole = 'editor';
		const denied = "You don't have permission to perform this action";
		await expect(user.query(api.agentHealth.getDashboardMetrics, {})).rejects.toThrow(denied);
		await expect(
			user.query(api.agentHealth.getMetricHistory, { metricType: 'queue_depth' })
		).rejects.toThrow(denied);
		await expect(user.query(api.agentHealth.getCostByStep, {})).rejects.toThrow(denied);
		await expect(user.query(api.agentHealth.getAccuracyTrend, {})).rejects.toThrow(denied);
	});
});
