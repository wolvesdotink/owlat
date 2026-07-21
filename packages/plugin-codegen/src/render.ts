import {
	composeBundledAgentSteps,
	orderHostedContributions,
	parsePluginPackageName,
	type BundledPlugin,
	type HostedAgentStepDefinition,
} from '@owlat/plugin-host';
import { parsePluginId, pluginNamespacedKind } from '@owlat/plugin-kit';
import {
	AUTOMATION_REGISTRIES,
	renderAutomationCatalog,
	renderAutomationModules,
} from './renderAutomation';
import { renderCronCatalog, renderCronModules } from './renderCron';
import { GENERATED_HEADER, renderPluginModuleFile } from './renderShared';
import {
	importProvidersFor,
	renderImportProviderCatalog,
	renderImportProviderModules,
	renderWebhookEventCatalog,
} from './renderWebhookImport';

export interface GeneratedPluginComposition {
	readonly convex: string;
	readonly components: string;
	readonly nuxt: string;
	readonly sendTransportCatalog: string;
	readonly sendTransportModules: string;
	readonly agentStepCatalog: string;
	readonly agentStepModules: string;
	readonly draftStrategyCatalog: string;
	readonly draftStrategyModules: string;
	readonly autonomyGateCatalog: string;
	readonly autonomyGateModules: string;
	readonly automationTriggerCatalog: string;
	readonly automationTriggerModules: string;
	readonly automationStepCatalog: string;
	readonly automationStepModules: string;
	readonly automationConditionCatalog: string;
	readonly automationConditionModules: string;
	readonly webhookEventCatalog: string;
	readonly importProviderCatalog: string;
	readonly importProviderModules: string;
	readonly cronCatalog: string;
	readonly cronModules: string;
}

/**
 * Every file codegen emits, as ONE table: artifact key -> repository path.
 *
 * The output set used to be spelled out three times — the fields of
 * `GeneratedPluginComposition`, twenty-two `*_OUTPUT_PATH` constants, and
 * twenty-two `{ path, source }` target entries — so adding one registry meant
 * six coordinated edits across two files and forgetting one silently dropped a
 * file from both the writer and the `--check` staleness gate. Typing this as a
 * `Record` over the composition's own keys makes the compiler demand a path for
 * every artifact and reject a path for one that no longer exists.
 */
export const GENERATED_ARTIFACT_PATHS: Readonly<Record<keyof GeneratedPluginComposition, string>> =
	Object.freeze({
		convex: 'apps/api/convex/plugins/plugins.generated.ts',
		components: 'apps/api/convex/plugins/components.generated.ts',
		nuxt: 'apps/web/app/plugins/plugin-composition.generated.ts',
		sendTransportCatalog: 'apps/api/convex/plugins/sendTransportCatalog.generated.ts',
		sendTransportModules: 'apps/api/convex/plugins/sendTransportModules.generated.ts',
		agentStepCatalog: 'apps/api/convex/plugins/agentStepCatalog.generated.ts',
		agentStepModules: 'apps/api/convex/plugins/agentStepModules.generated.ts',
		draftStrategyCatalog: 'apps/api/convex/plugins/draftStrategyCatalog.generated.ts',
		draftStrategyModules: 'apps/api/convex/plugins/draftStrategyModules.generated.ts',
		autonomyGateCatalog: 'apps/api/convex/plugins/autonomyGateCatalog.generated.ts',
		autonomyGateModules: 'apps/api/convex/plugins/autonomyGateModules.generated.ts',
		automationTriggerCatalog: 'apps/api/convex/plugins/automationTriggerCatalog.generated.ts',
		automationTriggerModules: 'apps/api/convex/plugins/automationTriggerModules.generated.ts',
		automationStepCatalog: 'apps/api/convex/plugins/automationStepCatalog.generated.ts',
		automationStepModules: 'apps/api/convex/plugins/automationStepModules.generated.ts',
		automationConditionCatalog: 'apps/api/convex/plugins/automationConditionCatalog.generated.ts',
		automationConditionModules: 'apps/api/convex/plugins/automationConditionModules.generated.ts',
		webhookEventCatalog: 'apps/api/convex/plugins/webhookEventCatalog.generated.ts',
		importProviderCatalog: 'apps/api/convex/plugins/importProviderCatalog.generated.ts',
		importProviderModules: 'apps/api/convex/plugins/importProviderModules.generated.ts',
		cronCatalog: 'apps/api/convex/plugins/cronCatalog.generated.ts',
		cronModules: 'apps/api/convex/plugins/cronModules.generated.ts',
	});

/** One emitted file: where it goes and the source that belongs there. */
export interface GeneratedArtifact {
	readonly key: keyof GeneratedPluginComposition;
	readonly outputPath: string;
	readonly source: string;
}

/** The rendered composition as the flat artifact list the writer iterates. */
export function generatedArtifacts(
	composition: GeneratedPluginComposition
): readonly GeneratedArtifact[] {
	return Object.freeze(
		(Object.keys(GENERATED_ARTIFACT_PATHS) as (keyof GeneratedPluginComposition)[]).map((key) =>
			Object.freeze({ key, outputPath: GENERATED_ARTIFACT_PATHS[key], source: composition[key] })
		)
	);
}

export function renderPluginComposition(
	plugins: readonly BundledPlugin[]
): GeneratedPluginComposition {
	const agentSteps = composeBundledAgentSteps(plugins);
	const importProviders = importProvidersFor(plugins);
	const imports = plugins
		.map((plugin, index) => {
			const packageName = JSON.stringify(parsePluginPackageName(plugin.packageName));
			return `import bundledPluginManifest${index} from ${packageName};`;
		})
		.join('\n');
	const sources = plugins
		.map((plugin, index) => {
			const packageName = JSON.stringify(parsePluginPackageName(plugin.packageName));
			return `\t{ packageName: ${packageName}, manifest: bundledPluginManifest${index} },`;
		})
		.join('\n');
	const composition = sources
		? `export const bundledPluginComposition = composeBundledPlugins([\n${sources}\n]);\n`
		: 'export const bundledPluginComposition = composeBundledPlugins([]);\n';
	const shared = `${GENERATED_HEADER}import { composeBundledPlugins } from '@owlat/plugin-host';\n${imports}${imports ? '\n' : ''}\n${composition}`;

	return Object.freeze({
		convex: shared,
		components: renderConvexComponents(plugins),
		nuxt: `${shared}\nexport default defineNuxtPlugin({\n\tname: 'owlat:bundled-plugin-composition',\n\tsetup() {\n\t\tvoid bundledPluginComposition;\n\t},\n});\n`,
		sendTransportCatalog: renderSendTransportCatalog(plugins),
		sendTransportModules: renderSendTransportModules(plugins),
		agentStepCatalog: renderAgentStepCatalog(agentSteps),
		agentStepModules: renderAgentStepModules(agentSteps),
		draftStrategyCatalog: renderDraftStrategyCatalog(plugins),
		draftStrategyModules: renderDraftStrategyModules(plugins),
		autonomyGateCatalog: renderAutonomyGateCatalog(plugins),
		autonomyGateModules: renderAutonomyGateModules(plugins),
		automationTriggerCatalog: renderAutomationCatalog(plugins, AUTOMATION_REGISTRIES.trigger),
		automationTriggerModules: renderAutomationModules(plugins, AUTOMATION_REGISTRIES.trigger),
		automationStepCatalog: renderAutomationCatalog(plugins, AUTOMATION_REGISTRIES.step),
		automationStepModules: renderAutomationModules(plugins, AUTOMATION_REGISTRIES.step),
		automationConditionCatalog: renderAutomationCatalog(plugins, AUTOMATION_REGISTRIES.condition),
		automationConditionModules: renderAutomationModules(plugins, AUTOMATION_REGISTRIES.condition),
		webhookEventCatalog: renderWebhookEventCatalog(plugins),
		importProviderCatalog: renderImportProviderCatalog(importProviders),
		importProviderModules: renderImportProviderModules(importProviders),
		cronCatalog: renderCronCatalog(plugins),
		cronModules: renderCronModules(plugins),
	});
}

function autonomyGatesFor(plugins: readonly BundledPlugin[]) {
	return orderHostedContributions(
		plugins.flatMap((plugin) =>
			(plugin.manifest.contributes?.sendGates ?? []).map((gate) => ({
				pluginId: parsePluginId(plugin.manifest.id),
				contributionId: gate.id,
				value: {
					packageName: parsePluginPackageName(plugin.packageName),
					label: gate.label,
					exportPath: gate.module.exportPath,
					timeoutMs: gate.timeoutMs,
					requiredEnvVars: plugin.manifest.flag?.requiredEnvVars ?? [],
				},
			}))
		)
	).map(({ pluginId, contributionId, value }) => ({
		...value,
		pluginId,
		kind: pluginNamespacedKind(pluginId, contributionId),
	}));
}

function renderAutonomyGateCatalog(plugins: readonly BundledPlugin[]): string {
	const entries = autonomyGatesFor(plugins)
		.map(
			(gate) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(gate.kind)},
\t\tpluginId: ${JSON.stringify(gate.pluginId)},
\t\tlabel: ${JSON.stringify(gate.label)},
\t\ttimeoutMs: ${gate.timeoutMs},
\t\trequiredEnvVars: Object.freeze(${JSON.stringify(gate.requiredEnvVars)}),
\t\trequiredCapability: 'send:gate',
\t}),`
		)
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_AUTONOMY_GATE_CATALOG = ${catalog};\n`;
}

function renderAutonomyGateModules(plugins: readonly BundledPlugin[]): string {
	return renderPluginModuleFile(autonomyGatesFor(plugins), {
		varPrefix: 'bundledPluginAutonomyGate',
		contract: 'PluginAutonomyGateModule',
		modulesConst: 'BUNDLED_PLUGIN_AUTONOMY_GATE_MODULES',
		useNode: true,
	});
}

function draftStrategiesFor(plugins: readonly BundledPlugin[]) {
	return plugins.flatMap((plugin) =>
		(plugin.manifest.contributes?.draftStrategies ?? []).map((strategy) => ({
			packageName: parsePluginPackageName(plugin.packageName),
			pluginId: parsePluginId(plugin.manifest.id),
			kind: pluginNamespacedKind(plugin.manifest.id, strategy.id),
			label: strategy.label,
			exportPath: strategy.module.exportPath,
			timeoutMs: strategy.timeoutMs,
			requiredEnvVars: plugin.manifest.flag?.requiredEnvVars ?? [],
		}))
	);
}

function renderDraftStrategyCatalog(plugins: readonly BundledPlugin[]): string {
	const entries = draftStrategiesFor(plugins)
		.map(
			(strategy) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(strategy.kind)},
\t\tpluginId: ${JSON.stringify(strategy.pluginId)},
\t\tlabel: ${JSON.stringify(strategy.label)},
\t\ttimeoutMs: ${strategy.timeoutMs},
\t\trequiredEnvVars: Object.freeze(${JSON.stringify(strategy.requiredEnvVars)}),
\t\trequiredCapability: 'draft:strategy',
\t}),`
		)
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_DRAFT_STRATEGY_CATALOG = ${catalog};\n`;
}

function renderDraftStrategyModules(plugins: readonly BundledPlugin[]): string {
	const strategies = draftStrategiesFor(plugins);
	const imports = strategies
		.map(
			(strategy, index) =>
				`import bundledPluginDraftStrategy${index} from ${JSON.stringify(`${strategy.packageName}${strategy.exportPath.slice(1)}`)};`
		)
		.join('\n');
	const entries = strategies
		.map(
			(strategy, index) =>
				`\tObject.freeze({ kind: ${JSON.stringify(strategy.kind)}, pluginId: ${JSON.stringify(strategy.pluginId)}, module: bundledPluginDraftStrategy${index} satisfies PluginDraftStrategyModule }),`
		)
		.join('\n');
	const modules = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	const contractImport = strategies.length
		? "import type { PluginDraftStrategyModule } from '@owlat/plugin-kit';\n"
		: '';
	return `'use node';\n\n${GENERATED_HEADER}${contractImport}${imports}${imports ? '\n\n' : ''}export const BUNDLED_PLUGIN_DRAFT_STRATEGY_MODULES = ${modules};\n`;
}

function renderAgentStepCatalog(steps: readonly HostedAgentStepDefinition[]): string {
	const entries = steps
		.map((step) => {
			const lifecycleEdges = step.lifecycleEdges
				.map((edge) => `Object.freeze(${JSON.stringify(edge)})`)
				.join(', ');
			return `\tObject.freeze({
\t\tkind: ${JSON.stringify(step.kind)},
\t\tpluginId: ${JSON.stringify(step.pluginId)},
\t\tafter: ${JSON.stringify(step.after)},
\t\tcontinuationStatus: ${JSON.stringify(step.continuationStatus)},
\t\tplacement: ${JSON.stringify(step.placement)},
\t\tlifecycleEdges: Object.freeze([${lifecycleEdges}]),
\t\trequiredCapability: 'agent:step',
\t}),`;
		})
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_AGENT_STEP_CATALOG = ${catalog};\n`;
}

function renderAgentStepModules(steps: readonly HostedAgentStepDefinition[]): string {
	const contractImport = steps.length
		? "import type { PluginAgentStepModule } from '@owlat/plugin-kit';\n"
		: '';
	const imports = steps
		.map(
			(step, index) =>
				`import bundledPluginAgentStep${index} from ${JSON.stringify(`${step.packageName}${step.exportPath.slice(1)}`)};`
		)
		.join('\n');
	const entries = steps
		.map(
			(step, index) =>
				`\tObject.freeze({ kind: ${JSON.stringify(step.kind)}, pluginId: ${JSON.stringify(step.pluginId)}, module: bundledPluginAgentStep${index} satisfies PluginAgentStepModule }),`
		)
		.join('\n');
	const modules = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `'use node';\n\n${GENERATED_HEADER}${contractImport}${imports}${imports ? '\n\n' : ''}export const BUNDLED_PLUGIN_AGENT_STEP_MODULES = ${modules};\n`;
}

interface RenderedSendTransport {
	readonly packageName: string;
	readonly pluginId: string;
	readonly localId: string;
	readonly kind: string;
	readonly label: string;
	readonly exportPath: string;
	readonly retryDelays: readonly number[];
	readonly requiredEnvVars: readonly string[];
}

function sendTransportsFor(plugins: readonly BundledPlugin[]): readonly RenderedSendTransport[] {
	return plugins.flatMap((plugin) =>
		(plugin.manifest.contributes?.sendTransports ?? []).map((transport) => ({
			packageName: parsePluginPackageName(plugin.packageName),
			pluginId: parsePluginId(plugin.manifest.id),
			localId: transport.id,
			kind: pluginNamespacedKind(plugin.manifest.id, transport.id),
			label: transport.label,
			exportPath: transport.module.exportPath,
			retryDelays: transport.retryDelays,
			requiredEnvVars: plugin.manifest.flag?.requiredEnvVars ?? [],
		}))
	);
}

function renderSendTransportCatalog(plugins: readonly BundledPlugin[]): string {
	const entries = sendTransportsFor(plugins)
		.map(
			(transport) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(transport.kind)},
\t\tpluginId: ${JSON.stringify(transport.pluginId)},
\t\tlocalId: ${JSON.stringify(transport.localId)},
\t\tlabel: ${JSON.stringify(transport.label)},
\t\tretryDelays: Object.freeze(${JSON.stringify(transport.retryDelays)}),
\t\trequiredEnvVars: Object.freeze(${JSON.stringify(transport.requiredEnvVars)}),
\t\trequiredCapability: 'send:transport',
\t}),`
		)
		.join('\n');
	const catalog = entries ? `Object.freeze([\n${entries}\n])` : 'Object.freeze([])';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG = ${catalog};\n`;
}

function renderSendTransportModules(plugins: readonly BundledPlugin[]): string {
	const transports = sendTransportsFor(plugins);
	const imports = transports
		.map(
			(transport, index) =>
				`import bundledPluginSendTransport${index} from ${JSON.stringify(`${transport.packageName}${transport.exportPath.slice(1)}`)};`
		)
		.join('\n');
	const entries = transports
		.map(
			(transport, index) =>
				`\tObject.freeze({ kind: ${JSON.stringify(transport.kind)}, pluginId: ${JSON.stringify(transport.pluginId)}, module: bundledPluginSendTransport${index} }),`
		)
		.join('\n');
	const modules = entries ? `Object.freeze([\n${entries}\n])` : 'Object.freeze([])';
	return `'use node';\n\n${GENERATED_HEADER}${imports}${imports ? '\n\n' : ''}export const BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES = ${modules};\n`;
}

function renderConvexComponents(plugins: readonly BundledPlugin[]): string {
	const components = plugins.flatMap((plugin) => {
		const component = plugin.manifest.component;
		if (!component) return [];
		const packageName = parsePluginPackageName(plugin.packageName);
		const pluginId = parsePluginId(plugin.manifest.id);
		return [
			{
				moduleSpecifier: `${packageName}${component.exportPath.slice(1)}`,
				namespace: convexComponentNamespace(pluginId),
			},
		];
	});
	const imports = components
		.map(
			(component, index) =>
				`import bundledPluginComponent${index} from ${JSON.stringify(component.moduleSpecifier)};`
		)
		.join('\n');
	const registrations = components
		.map(
			(component, index) =>
				`\tapp.use(bundledPluginComponent${index}, { name: ${JSON.stringify(component.namespace)} });`
		)
		.join('\n');
	return `${GENERATED_HEADER}import type { defineApp } from 'convex/server';
${imports}${imports ? '\n' : ''}
type ConvexAppDefinition = ReturnType<typeof defineApp>;

export function installBundledPluginComponents(app: ConvexAppDefinition): void {
${registrations || '\tvoid app;'}
}
`;
}

/** Kebab-case ids map injectively to Convex's alphanumeric/underscore names. */
export function convexComponentNamespace(pluginId: string): string {
	const id = parsePluginId(pluginId);
	const namespace = `plugin_${id.replaceAll('-', '_')}`;
	if (!/^[A-Za-z0-9_]+$/.test(namespace) || namespace.length > 128) {
		throw new TypeError('Plugin id cannot be represented as a Convex component namespace');
	}
	return namespace;
}
