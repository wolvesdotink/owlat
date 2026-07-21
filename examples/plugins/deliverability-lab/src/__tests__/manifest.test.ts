import {
	PLUGIN_AUTONOMY_GATE_CAPABILITY,
	PLUGIN_CRON_CAPABILITY,
	PLUGIN_NAV_ITEM_CAPABILITY,
	PLUGIN_SETTINGS_PANEL_CAPABILITY,
	PLUGIN_WORKER_CAPABILITY,
	parsePluginManifest,
	validatePluginManifest,
} from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import { deliverabilityLabPlugin, DELIVERABILITY_LAB_SEEDBOX_URL_ENV } from '../manifest';

describe('deliverability-lab manifest', () => {
	it('is a valid plugin manifest that survives a round trip through the kernel validator', () => {
		const result = validatePluginManifest(deliverabilityLabPlugin);
		expect(result.ok).toBe(true);
		// definePlugin already validated at construction; re-parsing must not throw.
		expect(() => parsePluginManifest(deliverabilityLabPlugin)).not.toThrow();
	});

	it('declares every capability its contributions and actions require', () => {
		expect(deliverabilityLabPlugin.capabilities).toEqual(
			expect.arrayContaining([
				PLUGIN_AUTONOMY_GATE_CAPABILITY,
				PLUGIN_CRON_CAPABILITY,
				PLUGIN_NAV_ITEM_CAPABILITY,
				PLUGIN_SETTINGS_PANEL_CAPABILITY,
				PLUGIN_WORKER_CAPABILITY,
				'llm:invoke',
			])
		);
	});

	it('ships a restrict-only send gate contribution with a bounded timeout', () => {
		const gates = deliverabilityLabPlugin.contributes?.sendGates ?? [];
		expect(gates).toHaveLength(1);
		expect(gates[0]?.id).toBe('seed-list-preflight');
		expect(gates[0]?.timeoutMs).toBeGreaterThan(0);
		expect(gates[0]?.timeoutMs).toBeLessThanOrEqual(30_000);
	});

	it('is off by default and does not gate enablement on the not-yet-wired seedbox env var', () => {
		expect(deliverabilityLabPlugin.flag?.default).toBe(false);
		// The seedbox endpoint is declared as a forward-looking constant, but nothing
		// shipped here reads it (the bundled gate has no remote hook), so it must NOT
		// be a `requiredEnvVars` enablement blocker — otherwise an operator would have
		// to provision an endpoint that does nothing. PP-31 promotes it once wired.
		expect(deliverabilityLabPlugin.flag?.requiredEnvVars ?? []).not.toContain(
			'DELIVERABILITY_LAB_SEEDBOX_URL'
		);
		// It stays exported as the contract other tiers will consume.
		expect(DELIVERABILITY_LAB_SEEDBOX_URL_ENV).toBe('DELIVERABILITY_LAB_SEEDBOX_URL');
	});

	it('caps its attributed LLM spend with a hard positive daily budget', () => {
		expect(deliverabilityLabPlugin.llmBudget?.dailyUsd).toBeGreaterThan(0);
	});

	it('never stores a compiled-in default for the secret settings field', () => {
		const secret = (deliverabilityLabPlugin.settingsSchema ?? []).find(
			(field) => field.kind === 'secret'
		);
		expect(secret).toBeDefined();
		expect(secret && 'default' in secret).toBe(false);
	});

	it('rejects a variant that contributes a send gate without the send:gate capability', () => {
		const broken = {
			...deliverabilityLabPlugin,
			capabilities: deliverabilityLabPlugin.capabilities.filter(
				(capability) => capability !== PLUGIN_AUTONOMY_GATE_CAPABILITY
			),
		};
		const result = validatePluginManifest(broken);
		expect(result.ok).toBe(false);
	});
});
