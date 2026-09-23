/**
 * A plugin automation step runs through the whole run-creation path (issue
 * #809, finding 9).
 *
 * `automationSteps.stepType` and `automationStepRuns.stepType` are stored under
 * the plugin-extensible `stepKindValidator`, and the walker dispatches plugin
 * kinds, but `createStepRun` hardcoded `email | delay | condition` — so the
 * first composed plugin step would have failed argument validation the moment
 * a run reached it. This drives a generated-catalog fixture through
 * add-step → start-run → execute, plus the validation boundary on both sides.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { createTestAutomation, enableFeatures } from '../../__tests__/factories';
import {
	runDueScheduled,
	runOf,
	seedRun,
	seedSettings,
	stepRunsOf,
	walkerModules,
	type T,
} from './walkerHarness';

const PLUGIN_KIND = 'plugin.deliverability.notify';

const pluginExecute = vi.hoisted(() => vi.fn());

vi.mock('../../plugins/automationStepCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG: [
		{
			kind: 'plugin.deliverability.notify',
			pluginId: 'deliverability',
			localId: 'notify',
			label: 'Notify',
			description: 'Send a notification',
			icon: 'bell',
			requiredEnvVars: [],
			requiredCapability: 'automation:step',
		},
	],
}));

vi.mock('../../plugins/automationStepModules.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_STEP_MODULES: [
		{
			kind: 'plugin.deliverability.notify',
			pluginId: 'deliverability',
			module: Object.freeze({ parseConfig: (raw: unknown) => raw, execute: pluginExecute }),
		},
	],
}));

// Plugin enablement and operator grants are covered by their own suites; here
// the plugin is simply authorized at both the editor and the runtime seam.
vi.mock('../../plugins/authorization', async () => {
	const actual = await vi.importActual<typeof import('../../plugins/authorization')>(
		'../../plugins/authorization'
	);
	return {
		...actual,
		requireAuthenticatedBundledPlugin: vi.fn(async () => undefined),
		getBundledPluginManifest: () => ({
			id: 'deliverability',
			version: '1.0.0',
			capabilities: ['automation:step'],
			flag: { default: false },
		}),
	};
});
vi.mock('../../plugins/hostedContributionAuthorization', () => ({
	authorizeHostedContribution: vi.fn(async () => true),
	recordHostedContributionOutcome: vi.fn(async () => undefined),
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const owner = { userId: 'user-owner', role: 'owner' as const };
	return {
		...actual,
		getMutationContext: vi.fn(async () => owner),
		requireOrgPermission: vi.fn(async () => owner),
	};
});

vi.mock('../../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

beforeEach(() => {
	vi.useFakeTimers();
	pluginExecute.mockReset().mockResolvedValue({ kind: 'completed' });
});
afterEach(() => {
	vi.useRealTimers();
});

async function freshT(): Promise<T> {
	const t = convexTest(schema, walkerModules);
	await seedSettings(t);
	await enableFeatures(t, ['automations']);
	return t;
}

describe('plugin step kind through run creation', () => {
	it('add-step → start-run → execute completes the plugin step and the run', async () => {
		const t = await freshT();
		const automationId = await t.run(async (ctx) =>
			ctx.db.insert('automations', createTestAutomation({ status: 'draft' }))
		);

		const stepId = await t.mutation(api.automations.steps.addStep, {
			automationId,
			stepType: PLUGIN_KIND,
			config: { pluginConfig: { channel: 'ops' } },
		});
		await t.run(async (ctx) => ctx.db.patch(automationId, { status: 'active' }));
		const { runId } = await seedRun(t, automationId);

		await t.action(internal.automations.stepWalker.startAutomationRun, {
			automationRunId: runId,
		});
		await runDueScheduled(t);

		expect(pluginExecute).toHaveBeenCalledOnce();
		expect(pluginExecute.mock.calls[0]?.[1]).toEqual({ channel: 'ops' });
		const [stepRun] = await stepRunsOf(t, runId);
		expect(stepRun?.automationStepId).toBe(stepId);
		expect(stepRun?.stepType).toBe(PLUGIN_KIND);
		expect(stepRun?.status).toBe('completed');
		expect((await runOf(t, runId)).status).toBe('completed');
	});

	it('createStepRun accepts a composed plugin kind (it hardcoded the core kinds)', async () => {
		const t = await freshT();
		const automationId = await t.run(async (ctx) =>
			ctx.db.insert('automations', createTestAutomation({ status: 'active' }))
		);
		const stepId = await t.run(async (ctx) =>
			ctx.db.insert('automationSteps', {
				automationId,
				stepIndex: 0,
				stepType: PLUGIN_KIND,
				config: { pluginConfig: {} },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
		const { runId } = await seedRun(t, automationId);

		const stepRunId = await t.mutation(internal.automations.stepExecutorQueries.createStepRun, {
			automationRunId: runId,
			automationStepId: stepId,
			stepIndex: 0,
			stepType: PLUGIN_KIND,
		});

		const stepRun = await t.run(async (ctx) => ctx.db.get(stepRunId));
		expect(stepRun?.stepType).toBe(PLUGIN_KIND);
		expect(stepRun?.status).toBe('pending');
	});

	it('rejects a plugin kind that is not in the composed catalog, at both layers', async () => {
		const t = await freshT();
		const automationId = await t.run(async (ctx) =>
			ctx.db.insert('automations', createTestAutomation({ status: 'draft' }))
		);
		const ghost = 'plugin.deliverability.ghost';

		await expect(
			t.mutation(api.automations.steps.addStep, {
				automationId,
				stepType: ghost as never,
				config: { pluginConfig: {} },
			})
		).rejects.toThrow(/Validator error/);

		const stepId = await t.mutation(api.automations.steps.addStep, {
			automationId,
			stepType: 'delay',
			config: { duration: 1, unit: 'days' },
		});
		const { runId } = await seedRun(t, automationId);
		await expect(
			t.mutation(internal.automations.stepExecutorQueries.createStepRun, {
				automationRunId: runId,
				automationStepId: stepId,
				stepIndex: 0,
				stepType: ghost as never,
			})
		).rejects.toThrow(/Validator error/);
	});
});
