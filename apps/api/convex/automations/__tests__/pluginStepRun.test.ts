/**
 * A plugin automation step runs through the whole run-creation path (issue
 * #809, finding 9).
 *
 * `automationSteps.stepType` and `automationStepRuns.stepType` are stored under
 * the plugin-extensible `stepKindValidator`, and the walker dispatches plugin
 * kinds, but `createStepRun` hardcoded `email | delay | condition` — so the
 * first composed plugin step would have failed argument validation the moment
 * a run reached it. Run creation now copies the kind off the step row inside
 * one mutation, so there is no second validator to drift. This drives a
 * generated-catalog fixture through add-step → start-run → execute, plus the
 * validation boundary.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { createTestAutomation, enableFeatures } from '../../__tests__/factories';
import type { StepKind } from '../steps/catalog';
import type * as PluginAuthorization from '../../plugins/authorization';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import {
	runDueScheduled,
	runOf,
	seedRun,
	seedSettings,
	stepRunsOf,
	walkerModules,
	type T,
} from './walkerHarness';

// The generated catalog is empty in the repo, so the static `StepKind` type has
// no plugin members; the mocked catalog below widens the RUNTIME validator only.
const PLUGIN_KIND = 'plugin.deliverability.notify' as StepKind;

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
	const actual = await vi.importActual<typeof PluginAuthorization>('../../plugins/authorization');
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
	const actual = await vi.importActual<typeof SessionOrganization>('../../lib/sessionOrganization');
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

	it('rejects a plugin kind that is not in the composed catalog, at the editor and in storage', async () => {
		const t = await freshT();
		const automationId = await t.run(async (ctx) =>
			ctx.db.insert('automations', createTestAutomation({ status: 'draft' }))
		);
		const ghost = 'plugin.deliverability.ghost' as StepKind;

		await expect(
			t.mutation(api.automations.steps.addStep, {
				automationId,
				stepType: ghost,
				config: { pluginConfig: {} },
			})
		).rejects.toThrow(/Validator error/);

		// The step run's kind is stored under the same validator, so run
		// creation can never persist a kind the catalog does not know either.
		await expect(
			t.run(async (ctx) =>
				ctx.db.insert('automationSteps', {
					automationId,
					stepIndex: 0,
					stepType: ghost,
					config: { pluginConfig: {} },
					createdAt: Date.now(),
					updatedAt: Date.now(),
				})
			)
		).rejects.toThrow();
	});
});
