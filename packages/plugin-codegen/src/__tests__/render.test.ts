import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { composeBundledPlugins, type BundledPlugin } from '@owlat/plugin-host';
import { convexComponentNamespace, renderPluginComposition } from '../render';

describe('composition rendering', () => {
	it('renders deterministic Convex and Nuxt imports in manifest-id order', () => {
		const first = composeBundledPlugins([
			{
				packageName: 'zebra-plugin',
				manifest: { id: 'zebra', version: '1.0.0', capabilities: [] },
			},
			{
				packageName: '@acme/alpha-plugin',
				manifest: { id: 'alpha', version: '1.0.0', capabilities: [] },
			},
		]);
		const second = composeBundledPlugins([...first].reverse());

		const rendered = renderPluginComposition(first);
		expect(renderPluginComposition(second)).toEqual(rendered);
		expect(rendered.convex).toContain(
			'import bundledPluginManifest0 from "@acme/alpha-plugin";\nimport bundledPluginManifest1 from "zebra-plugin";'
		);
		expect(rendered.convex).toContain(
			'{ packageName: "@acme/alpha-plugin", manifest: bundledPluginManifest0 }'
		);
		expect(rendered.nuxt).toContain("name: 'owlat:bundled-plugin-composition'");
		const parsed = ts.createSourceFile(
			'plugins.generated.ts',
			rendered.convex,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		expect(
			(parsed as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
				.parseDiagnostics
		).toEqual([]);
	});

	it.each([
		`safe-package';\nconsole.error('INJECTED');//`,
		'safe-package\\escape',
		'safe-package\rnext',
		'safe-package\nnext',
		'safe-package\u2028next',
		'safe-package\u2029next',
		'safe-package${template}',
	])('rejects an unvalidated generated module specifier: %j', (packageName) => {
		const maliciousPlugin = {
			packageName,
			manifest: { id: 'safe', version: '1.0.0', capabilities: [] },
		} as unknown as BundledPlugin;

		expect(() => renderPluginComposition([maliciousPlugin])).toThrow(
			'Invalid bundled plugin package name'
		);
	});

	it('keeps a zero-plugin repository as an explicit no-op composition', () => {
		const rendered = renderPluginComposition([]);
		expect(rendered.convex).toContain('composeBundledPlugins([]);');
		expect(rendered.convex).not.toContain('bundledPluginManifest0');
		expect(rendered.nuxt).toContain('void bundledPluginComposition;');
		expect(rendered.components).toContain('void app;');
		expect(rendered.sendTransportCatalog).toContain('Object.freeze([])');
		expect(rendered.sendTransportModules).toContain("'use node';");
		expect(rendered.sendTransportModules).toContain('Object.freeze([])');
		expect(rendered.agentStepCatalog).toContain('Object.freeze([] as const)');
		expect(rendered.agentStepModules).toContain("'use node';");
		expect(rendered.draftStrategyCatalog).toContain('Object.freeze([] as const)');
		expect(rendered.draftStrategyModules).toContain("'use node';");
		expect(rendered.autonomyGateCatalog).toContain('Object.freeze([] as const)');
		expect(rendered.autonomyGateModules).toContain("'use node';");
		expect(rendered.autonomyGateModules).toContain('Object.freeze([] as const)');
		for (const catalog of [
			rendered.automationTriggerCatalog,
			rendered.automationStepCatalog,
			rendered.automationConditionCatalog,
		]) {
			expect(catalog).toContain('Object.freeze([] as const)');
		}
		for (const modules of [
			rendered.automationTriggerModules,
			rendered.automationStepModules,
			rendered.automationConditionModules,
		]) {
			expect(modules).toContain('Object.freeze([] as const)');
		}
		// Only the step walker runs in a Convex action, so only step modules are Node-only.
		expect(rendered.automationStepModules).toContain("'use node';");
		expect(rendered.automationTriggerModules).not.toContain("'use node';");
		expect(rendered.automationConditionModules).not.toContain("'use node';");
		expect(rendered.webhookEventCatalog).toContain('Object.freeze([] as const)');
		expect(rendered.importProviderCatalog).toContain('Object.freeze([] as const)');
		expect(rendered.importProviderModules).toContain("'use node';");
		expect(rendered.importProviderModules).toContain('Object.freeze([] as const)');
	});

	it('separates automation registry editor metadata from executable modules', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/auto-plugin',
				manifest: {
					id: 'auto-pack',
					version: '1.0.0',
					capabilities: ['automation:trigger', 'automation:step', 'automation:condition'],
					flag: { default: false, requiredEnvVars: ['AUTO_TOKEN'] },
					contributes: {
						automationTriggers: [
							{
								id: 'ping',
								label: 'Ping',
								description: 'Fires on a ping',
								icon: 'bolt',
								module: { exportPath: './automation/trigger' },
							},
						],
						automationSteps: [
							{
								id: 'notify',
								label: 'Notify',
								description: 'Sends a notification',
								icon: 'bell',
								module: { exportPath: './automation/step' },
							},
						],
						automationConditions: [
							{
								id: 'vip',
								label: 'Is VIP',
								description: 'Contact is a VIP',
								icon: 'star',
								module: { exportPath: './automation/condition' },
							},
						],
					},
				},
			},
		]);
		const rendered = renderPluginComposition(plugins);

		expect(rendered.automationTriggerCatalog).toContain('plugin.auto-pack.ping');
		expect(rendered.automationTriggerCatalog).toContain("requiredCapability: 'automation:trigger'");
		expect(rendered.automationTriggerCatalog).toContain('AUTO_TOKEN');
		expect(rendered.automationTriggerCatalog).toContain('icon: "bolt"');
		// The catalog is metadata only — it never leaks the executable import path.
		expect(rendered.automationTriggerCatalog).not.toContain('@acme/auto-plugin');
		expect(rendered.automationTriggerModules).toContain(
			'from "@acme/auto-plugin/automation/trigger"'
		);
		expect(rendered.automationTriggerModules).toContain('satisfies PluginAutomationTriggerModule');

		expect(rendered.automationStepCatalog).toContain('plugin.auto-pack.notify');
		expect(rendered.automationStepCatalog).toContain("requiredCapability: 'automation:step'");
		expect(rendered.automationStepModules).toContain('satisfies PluginAutomationStepModule');

		expect(rendered.automationConditionCatalog).toContain('plugin.auto-pack.vip');
		expect(rendered.automationConditionCatalog).toContain(
			"requiredCapability: 'automation:condition'"
		);
		expect(rendered.automationConditionModules).toContain(
			'satisfies PluginAutomationConditionModule'
		);
	});

	it('renders automation registries independent of plugin input order', () => {
		// Two plugins that each contribute an automation kind, listed so their
		// input order (zebra, alpha) differs from manifest-id order (alpha, zebra).
		const zebra = {
			packageName: '@acme/zebra-auto',
			manifest: {
				id: 'zebra-auto',
				version: '1.0.0',
				capabilities: ['automation:trigger', 'automation:step', 'automation:condition'],
				flag: { default: false },
				contributes: {
					automationTriggers: [
						{
							id: 'z-trigger',
							label: 'Z trigger',
							description: 'zebra trigger',
							icon: 'bolt',
							module: { exportPath: './automation/z-trigger' },
						},
					],
					automationSteps: [
						{
							id: 'z-step',
							label: 'Z step',
							description: 'zebra step',
							icon: 'bell',
							module: { exportPath: './automation/z-step' },
						},
					],
					automationConditions: [
						{
							id: 'z-condition',
							label: 'Z condition',
							description: 'zebra condition',
							icon: 'star',
							module: { exportPath: './automation/z-condition' },
						},
					],
				},
			},
		} as const;
		const alpha = {
			packageName: '@acme/alpha-auto',
			manifest: {
				id: 'alpha-auto',
				version: '1.0.0',
				capabilities: ['automation:trigger', 'automation:step', 'automation:condition'],
				flag: { default: false },
				contributes: {
					automationTriggers: [
						{
							id: 'a-trigger',
							label: 'A trigger',
							description: 'alpha trigger',
							icon: 'bolt',
							module: { exportPath: './automation/a-trigger' },
						},
					],
					automationSteps: [
						{
							id: 'a-step',
							label: 'A step',
							description: 'alpha step',
							icon: 'bell',
							module: { exportPath: './automation/a-step' },
						},
					],
					automationConditions: [
						{
							id: 'a-condition',
							label: 'A condition',
							description: 'alpha condition',
							icon: 'star',
							module: { exportPath: './automation/a-condition' },
						},
					],
				},
			},
		} as const;

		const forward = renderPluginComposition(composeBundledPlugins([zebra, alpha]));
		const reverse = renderPluginComposition(composeBundledPlugins([alpha, zebra]));

		for (const key of [
			'automationTriggerCatalog',
			'automationTriggerModules',
			'automationStepCatalog',
			'automationStepModules',
			'automationConditionCatalog',
			'automationConditionModules',
		] as const) {
			// Byte-identical regardless of the order the plugins were listed in.
			expect(reverse[key]).toBe(forward[key]);
			// And canonically ordered: alpha's contribution precedes zebra's.
			expect(forward[key].indexOf('alpha-auto')).toBeLessThan(forward[key].indexOf('zebra-auto'));
		}
	});

	it('orders webhook events deterministically and carries only data metadata', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/events-plugin',
				manifest: {
					id: 'events-pack',
					version: '1.0.0',
					capabilities: ['webhooks:publish'],
					flag: { default: false },
					contributes: {
						webhookEvents: [
							{ id: 'z-last', description: 'Last', subscribable: false },
							{ id: 'a-first', description: 'First', subscribable: true },
						],
					},
				},
			},
		]);
		const rendered = renderPluginComposition(plugins);
		expect(rendered.webhookEventCatalog.indexOf('a-first')).toBeLessThan(
			rendered.webhookEventCatalog.indexOf('z-last')
		);
		expect(rendered.webhookEventCatalog).toContain('plugin.events-pack.a-first');
		expect(rendered.webhookEventCatalog).toContain("requiredCapability: 'webhooks:publish'");
		expect(rendered.webhookEventCatalog).toContain('subscribable: true');
		expect(rendered.webhookEventCatalog).not.toContain('@acme/events-plugin');
	});

	it('separates import provider metadata from Node-only executable modules', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/crm-plugin',
				manifest: {
					id: 'crm-pack',
					version: '1.0.0',
					capabilities: ['imports:provide'],
					flag: { default: false, requiredEnvVars: ['HUBSPOT_KEY'] },
					contributes: {
						importProviders: [
							{
								id: 'hubspot',
								label: 'HubSpot',
								module: { exportPath: './providers/hubspot' },
								signature: {
									header: 'x-hubspot-signature',
									algorithm: 'hmac-sha256',
									encoding: 'hex',
									secretEnvVar: 'PLUGIN_HUBSPOT_WEBHOOK_SECRET',
								},
								attestSource: 'hubspot',
							},
						],
					},
				},
			},
		]);
		const rendered = renderPluginComposition(plugins);
		expect(rendered.importProviderCatalog).toContain('plugin.crm-pack.hubspot');
		expect(rendered.importProviderCatalog).toContain("requiredCapability: 'imports:provide'");
		expect(rendered.importProviderCatalog).toContain('HUBSPOT_KEY');
		expect(rendered.importProviderCatalog).toContain('x-hubspot-signature');
		expect(rendered.importProviderCatalog).toContain('attestSource: "hubspot"');
		expect(rendered.importProviderCatalog).not.toContain('@acme/crm-plugin');
		expect(rendered.importProviderModules).toContain("'use node';");
		expect(rendered.importProviderModules).toContain('satisfies PluginImportProviderModule');
		expect(rendered.importProviderModules).toContain('from "@acme/crm-plugin/providers/hubspot"');
	});

	it('orders autonomy gates deterministically and separates metadata from executable modules', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/policy-plugin',
				manifest: {
					id: 'policy-pack',
					version: '1.0.0',
					capabilities: ['send:gate'],
					flag: { default: false, requiredEnvVars: ['POLICY_TOKEN'] },
					contributes: {
						sendGates: [
							{
								id: 'z-last',
								label: 'Last policy',
								module: { exportPath: './gates/last' },
								timeoutMs: 4_000,
							},
							{
								id: 'a-first',
								label: 'First policy',
								module: { exportPath: './gates/first' },
								timeoutMs: 1_000,
							},
						],
					},
				},
			},
		]);
		const rendered = renderPluginComposition(plugins);
		expect(rendered.autonomyGateCatalog.indexOf('a-first')).toBeLessThan(
			rendered.autonomyGateCatalog.indexOf('z-last')
		);
		expect(rendered.autonomyGateCatalog).toContain("requiredCapability: 'send:gate'");
		expect(rendered.autonomyGateCatalog).toContain('POLICY_TOKEN');
		expect(rendered.autonomyGateCatalog).not.toContain('@acme/policy-plugin');
		expect(rendered.autonomyGateModules).toContain('satisfies PluginAutonomyGateModule');
		expect(rendered.autonomyGateModules).toContain('from "@acme/policy-plugin/gates/first"');
	});

	it('separates draft strategy metadata from executable modules', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/draft-plugin',
				manifest: {
					id: 'draft-pack',
					version: '1.0.0',
					capabilities: ['draft:strategy'],
					flag: { default: false, requiredEnvVars: ['DRAFT_TOKEN'] },
					contributes: {
						draftStrategies: [
							{
								id: 'legal',
								label: 'Legal',
								module: { exportPath: './draft/legal' },
								timeoutMs: 4000,
							},
						],
					},
				},
			},
		]);
		const rendered = renderPluginComposition(plugins);
		expect(rendered.draftStrategyCatalog).toContain('plugin.draft-pack.legal');
		expect(rendered.draftStrategyCatalog).toContain('DRAFT_TOKEN');
		expect(rendered.draftStrategyCatalog).not.toContain('@acme/draft-plugin');
		expect(rendered.draftStrategyModules).toContain('satisfies PluginDraftStrategyModule');
		expect(rendered.draftStrategyModules).toContain('from "@acme/draft-plugin/draft/legal"');
	});

	it('separates agent step policy metadata from Node-only executable imports', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/policy-plugin',
				manifest: {
					id: 'policy-pack',
					version: '1.0.0',
					capabilities: ['agent:step'],
					flag: { default: false },
					contributes: {
						agentSteps: [
							{
								id: 'spam-score',
								after: 'security_scan',
								module: { exportPath: './agent/spam-score' },
								lifecycleEdges: [{ kind: 'caution', from: 'classifying', to: 'archived' }],
							},
						],
					},
				},
			},
		]);
		const rendered = renderPluginComposition(plugins);

		expect(rendered.agentStepCatalog).toContain('plugin.policy-pack.spam-score');
		expect(rendered.agentStepCatalog).toContain('classifying');
		expect(rendered.agentStepCatalog).toContain('classification');
		expect(rendered.agentStepCatalog).toContain(
			'Object.freeze({"kind":"caution","from":"classifying","to":"archived"})'
		);
		expect(rendered.agentStepCatalog).not.toContain('@acme/policy-plugin');
		expect(rendered.agentStepModules).toContain("'use node';");
		expect(rendered.agentStepModules).toContain('satisfies PluginAgentStepModule');
		expect(rendered.agentStepModules).toContain('from "@acme/policy-plugin/agent/spam-score"');
	});

	it('separates pure transport metadata from Node-only executable imports', () => {
		const [plugin] = composeBundledPlugins([
			{
				packageName: '@acme/mail-plugin',
				manifest: {
					id: 'mail-pack',
					version: '1.0.0',
					capabilities: ['send:transport'],
					flag: { default: false, requiredEnvVars: ['POSTMARK_TOKEN'] },
					contributes: {
						sendTransports: [
							{
								id: 'postmark',
								label: 'Postmark',
								module: { exportPath: './transports/postmark' },
								retryDelays: [1000, 5000],
							},
						],
					},
				},
			},
		]);
		if (!plugin) throw new Error('Expected plugin fixture');
		const rendered = renderPluginComposition([plugin]);

		expect(rendered.sendTransportCatalog).toContain('plugin.mail-pack.postmark');
		expect(rendered.sendTransportCatalog).toContain('POSTMARK_TOKEN');
		expect(rendered.sendTransportCatalog).not.toContain('@acme/mail-plugin');
		expect(rendered.sendTransportModules).toContain("'use node';");
		expect(rendered.sendTransportModules).toContain('from "@acme/mail-plugin/transports/postmark"');
		expect(rendered.convex).not.toContain('/transports/postmark');
		expect(rendered.nuxt).not.toContain('/transports/postmark');
	});

	it('statically imports and installs components in deterministic isolated namespaces', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: 'zebra-plugin',
				manifest: {
					id: 'zebra-lab',
					version: '1.0.0',
					capabilities: [],
					component: { exportPath: './convex/convex.config' },
				},
			},
			{
				packageName: '@acme/alpha-plugin',
				manifest: {
					id: 'alpha',
					version: '1.0.0',
					capabilities: [],
					component: { exportPath: './backend/component' },
				},
			},
		]);
		const output = renderPluginComposition(plugins).components;

		expect(output).toContain('from "@acme/alpha-plugin/backend/component"');
		expect(output).toContain('{ name: "plugin_alpha" }');
		expect(output).toContain('from "zebra-plugin/convex/convex.config"');
		expect(output).toContain('{ name: "plugin_zebra_lab" }');
		expect(output.indexOf('plugin_alpha')).toBeLessThan(output.indexOf('plugin_zebra_lab'));
	});

	it('maps every valid id injectively into a bounded Convex identifier', () => {
		const ids = ['a', 'a-b', 'ab', 'a-b-c', `a${'b'.repeat(63)}`];
		const names = ids.map(convexComponentNamespace);

		expect(new Set(names).size).toBe(ids.length);
		for (const name of names) {
			expect(name).toMatch(/^[A-Za-z0-9_]+$/);
			expect(name.length).toBeLessThanOrEqual(128);
		}
	});
});
