import { describe, expect, it } from 'vitest';
import {
	composeBundledAgentSteps,
	composeBundledPlugins,
	createPluginPermissionService,
} from '@owlat/plugin-host';
import {
	parsePluginManifest,
	PLUGIN_AGENT_STEP_CAPABILITY,
	PLUGIN_AUTOMATION_CONDITION_CAPABILITY,
	PLUGIN_AUTOMATION_STEP_CAPABILITY,
	PLUGIN_AUTOMATION_TRIGGER_CAPABILITY,
	PLUGIN_DRAFT_STRATEGY_CAPABILITY,
	PLUGIN_NAV_ITEM_CAPABILITY,
	PLUGIN_SETTINGS_PANEL_CAPABILITY,
	PLUGIN_WEBHOOK_EVENT_CAPABILITY,
} from '@owlat/plugin-kit';
import { escalationGuardPlugin, ESCALATION_GUARD_DAILY_LLM_BUDGET_USD } from '../manifest';

const PACKAGE_NAME = '@owlat/example-escalation-guard';

describe('escalation-guard manifest', () => {
	it('is accepted by the host manifest validator', () => {
		expect(() => parsePluginManifest(escalationGuardPlugin)).not.toThrow();
	});

	it('is off by default so an operator must opt in', () => {
		expect(escalationGuardPlugin.flag.default).toBe(false);
	});

	it('declares a hard daily LLM budget', () => {
		expect(escalationGuardPlugin.llmBudget.dailyUsd).toBe(ESCALATION_GUARD_DAILY_LLM_BUDGET_USD);
		expect(ESCALATION_GUARD_DAILY_LLM_BUDGET_USD).toBeGreaterThan(0);
	});

	it('declares exactly the capabilities its contributions need', () => {
		expect([...escalationGuardPlugin.capabilities].sort()).toEqual(
			[
				PLUGIN_AGENT_STEP_CAPABILITY,
				PLUGIN_AUTOMATION_CONDITION_CAPABILITY,
				PLUGIN_AUTOMATION_STEP_CAPABILITY,
				PLUGIN_AUTOMATION_TRIGGER_CAPABILITY,
				PLUGIN_DRAFT_STRATEGY_CAPABILITY,
				PLUGIN_NAV_ITEM_CAPABILITY,
				PLUGIN_SETTINGS_PANEL_CAPABILITY,
				PLUGIN_WEBHOOK_EVENT_CAPABILITY,
				'llm:invoke',
			].sort()
		);
	});

	it('requests no send, transport, worker, cron, or import capability', () => {
		for (const capability of escalationGuardPlugin.capabilities) {
			expect(capability).not.toMatch(/^(send:|transport:|worker:|scheduler:|import:)/);
		}
	});

	it('contributes to no bucket it lacks a capability for', () => {
		expect(Object.keys(escalationGuardPlugin.contributes).sort()).toEqual([
			'agentSteps',
			'automationConditions',
			'automationSteps',
			'automationTriggers',
			'draftStrategies',
			'navItems',
			'settingsPanels',
			'webhookEvents',
		]);
	});

	it('declares only the restrict-only post-draft review edge', () => {
		expect(escalationGuardPlugin.contributes.agentSteps).toHaveLength(1);
		expect(escalationGuardPlugin.contributes.agentSteps[0]?.lifecycleEdges).toEqual([
			{ kind: 'draft_review', from: 'drafting', to: 'draft_ready' },
		]);
	});

	it('composes into the host agent pipeline at the after_draft placement', () => {
		const plugins = composeBundledPlugins([
			{ packageName: PACKAGE_NAME, manifest: escalationGuardPlugin },
		]);
		const steps = composeBundledAgentSteps(plugins);
		expect(steps).toHaveLength(1);
		expect(steps[0]?.kind).toBe('plugin.escalation-guard.escalation-check');
		expect(steps[0]?.placement).toBe('after_draft');
		expect(steps[0]?.continuationStatus).toBe('drafting');
	});

	it('grants nothing until an operator grants it, and cannot grant beyond the manifest', () => {
		const permissions = createPluginPermissionService({
			pluginId: escalationGuardPlugin.id,
			declaredCapabilities: escalationGuardPlugin.capabilities,
			grants: [{ capability: 'llm:invoke', granted: true }],
		});
		expect(permissions.has('llm:invoke')).toBe(true);
		expect(permissions.has(PLUGIN_AGENT_STEP_CAPABILITY)).toBe(false);
		expect(() => permissions.require(PLUGIN_AGENT_STEP_CAPABILITY)).toThrow();
		expect(() =>
			createPluginPermissionService({
				pluginId: escalationGuardPlugin.id,
				declaredCapabilities: escalationGuardPlugin.capabilities,
				grants: [{ capability: 'send:transport', granted: true }],
			})
		).toThrow();
	});

	it('points every contributed navigation entry at an internal dashboard path', () => {
		const hrefs = [
			...escalationGuardPlugin.contributes.navItems.map((item) => item.href),
			...escalationGuardPlugin.contributes.settingsPanels.map((panel) => panel.href),
		];
		expect(hrefs).toHaveLength(2);
		for (const href of hrefs) expect(href).toMatch(/^\/dashboard\//);
	});

	it('declares a settings schema whose keys are unique and non-secret', () => {
		const keys = escalationGuardPlugin.settingsSchema.map((field) => field.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const field of escalationGuardPlugin.settingsSchema) {
			expect(field.kind).not.toBe('secret');
		}
	});
});
