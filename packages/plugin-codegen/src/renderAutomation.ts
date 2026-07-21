/**
 * Automation registry rendering (trigger / step / condition).
 *
 * A sibling of `renderCron.ts` and `renderWebhookImport.ts`: the three
 * automation registries share one editor-metadata + static-module descriptor
 * shape, so one renderer drives all three from a spec table.
 */

import { parsePluginPackageName, type BundledPlugin } from '@owlat/plugin-host';
import { parsePluginId, pluginNamespacedKind } from '@owlat/plugin-kit';
import { GENERATED_HEADER, renderPluginModuleFile } from './renderShared';

/**
 * The three automation registries share one editor-metadata + static-module
 * descriptor shape, so one renderer drives all three. Each descriptor differs
 * only in its manifest bucket, capability, and generated constant/contract
 * names — captured here so the generated output stays byte-identical in shape.
 */
interface AutomationRegistrySpec {
	readonly bucket: 'automationTriggers' | 'automationSteps' | 'automationConditions';
	readonly capability: string;
	readonly catalogConst: string;
	readonly modulesConst: string;
	readonly contract: string;
	readonly varPrefix: string;
	/**
	 * Only automation STEP modules run inside a Convex action (the step walker),
	 * so only they carry `'use node'`. Trigger fanout runs in a mutation and
	 * condition evaluation runs in a query — both non-node — so their module
	 * lists must stay importable outside the Node runtime.
	 */
	readonly useNode: boolean;
}

export const AUTOMATION_REGISTRIES = {
	trigger: {
		bucket: 'automationTriggers',
		capability: 'automation:trigger',
		catalogConst: 'BUNDLED_PLUGIN_AUTOMATION_TRIGGER_CATALOG',
		modulesConst: 'BUNDLED_PLUGIN_AUTOMATION_TRIGGER_MODULES',
		contract: 'PluginAutomationTriggerModule',
		varPrefix: 'bundledPluginAutomationTrigger',
		useNode: false,
	},
	step: {
		bucket: 'automationSteps',
		capability: 'automation:step',
		catalogConst: 'BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG',
		modulesConst: 'BUNDLED_PLUGIN_AUTOMATION_STEP_MODULES',
		contract: 'PluginAutomationStepModule',
		varPrefix: 'bundledPluginAutomationStep',
		useNode: true,
	},
	condition: {
		bucket: 'automationConditions',
		capability: 'automation:condition',
		catalogConst: 'BUNDLED_PLUGIN_AUTOMATION_CONDITION_CATALOG',
		modulesConst: 'BUNDLED_PLUGIN_AUTOMATION_CONDITION_MODULES',
		contract: 'PluginAutomationConditionModule',
		varPrefix: 'bundledPluginAutomationCondition',
		useNode: false,
	},
} as const satisfies Record<string, AutomationRegistrySpec>;

interface RenderedAutomationContribution {
	readonly packageName: string;
	readonly pluginId: string;
	readonly localId: string;
	readonly kind: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
	readonly exportPath: string;
	readonly requiredEnvVars: readonly string[];
}

function automationContributionsFor(
	plugins: readonly BundledPlugin[],
	spec: AutomationRegistrySpec
): readonly RenderedAutomationContribution[] {
	return plugins.flatMap((plugin) => {
		const entries = plugin.manifest.contributes?.[spec.bucket] ?? [];
		return entries.map((entry) => ({
			packageName: parsePluginPackageName(plugin.packageName),
			pluginId: parsePluginId(plugin.manifest.id),
			localId: entry.id,
			kind: pluginNamespacedKind(plugin.manifest.id, entry.id),
			label: entry.label,
			description: entry.description,
			icon: entry.icon,
			exportPath: entry.module.exportPath,
			requiredEnvVars: plugin.manifest.flag?.requiredEnvVars ?? [],
		}));
	});
}

export function renderAutomationCatalog(
	plugins: readonly BundledPlugin[],
	spec: AutomationRegistrySpec
): string {
	const entries = automationContributionsFor(plugins, spec)
		.map(
			(entry) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(entry.kind)},
\t\tpluginId: ${JSON.stringify(entry.pluginId)},
\t\tlocalId: ${JSON.stringify(entry.localId)},
\t\tlabel: ${JSON.stringify(entry.label)},
\t\tdescription: ${JSON.stringify(entry.description)},
\t\ticon: ${JSON.stringify(entry.icon)},
\t\trequiredEnvVars: Object.freeze(${JSON.stringify(entry.requiredEnvVars)}),
\t\trequiredCapability: '${spec.capability}',
\t}),`
		)
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const ${spec.catalogConst} = ${catalog};\n`;
}

export function renderAutomationModules(
	plugins: readonly BundledPlugin[],
	spec: AutomationRegistrySpec
): string {
	return renderPluginModuleFile(automationContributionsFor(plugins, spec), {
		varPrefix: spec.varPrefix,
		contract: spec.contract,
		modulesConst: spec.modulesConst,
		useNode: spec.useNode,
	});
}
