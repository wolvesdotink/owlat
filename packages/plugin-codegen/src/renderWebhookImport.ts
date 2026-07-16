import {
	orderHostedContributions,
	parsePluginPackageName,
	type BundledPlugin,
} from '@owlat/plugin-host';
import { parsePluginId } from '@owlat/plugin-kit';
import { GENERATED_HEADER } from './renderShared';

interface RenderedWebhookEvent {
	readonly pluginId: string;
	readonly kind: string;
	readonly description: string;
	readonly subscribable: boolean;
}

function webhookEventsFor(plugins: readonly BundledPlugin[]): readonly RenderedWebhookEvent[] {
	return orderHostedContributions(
		plugins.flatMap((plugin) =>
			(plugin.manifest.contributes?.webhookEvents ?? []).map((event) => ({
				pluginId: parsePluginId(plugin.manifest.id),
				contributionId: event.id,
				value: { description: event.description, subscribable: event.subscribable },
			}))
		)
	).map(({ pluginId, contributionId, value }) => ({
		pluginId,
		kind: `plugin.${pluginId}.${contributionId}`,
		description: value.description,
		subscribable: value.subscribable,
	}));
}

export function renderWebhookEventCatalog(plugins: readonly BundledPlugin[]): string {
	const entries = webhookEventsFor(plugins)
		.map(
			(event) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(event.kind)},
\t\tpluginId: ${JSON.stringify(event.pluginId)},
\t\tdescription: ${JSON.stringify(event.description)},
\t\tsubscribable: ${event.subscribable ? 'true' : 'false'},
\t\trequiredCapability: 'webhooks:publish',
\t}),`
		)
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_WEBHOOK_EVENT_CATALOG = ${catalog};\n`;
}

interface RenderedImportProvider {
	readonly packageName: string;
	readonly pluginId: string;
	readonly kind: string;
	readonly label: string;
	readonly exportPath: string;
	readonly attestSource: string | null;
	readonly requiredEnvVars: readonly string[];
	readonly signature: {
		readonly header: string;
		readonly algorithm: string;
		readonly encoding: string;
		readonly secretEnvVar: string;
	};
}

function importProvidersFor(plugins: readonly BundledPlugin[]): readonly RenderedImportProvider[] {
	return orderHostedContributions(
		plugins.flatMap((plugin) =>
			(plugin.manifest.contributes?.importProviders ?? []).map((provider) => ({
				pluginId: parsePluginId(plugin.manifest.id),
				contributionId: provider.id,
				value: {
					packageName: parsePluginPackageName(plugin.packageName),
					label: provider.label,
					exportPath: provider.module.exportPath,
					attestSource: provider.attestSource ?? null,
					requiredEnvVars: plugin.manifest.flag?.requiredEnvVars ?? [],
					signature: provider.signature,
				},
			}))
		)
	).map(({ pluginId, contributionId, value }) => ({
		...value,
		pluginId,
		kind: `plugin.${pluginId}.${contributionId}`,
	}));
}

export function renderImportProviderCatalog(plugins: readonly BundledPlugin[]): string {
	const entries = importProvidersFor(plugins)
		.map(
			(provider) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(provider.kind)},
\t\tpluginId: ${JSON.stringify(provider.pluginId)},
\t\tlabel: ${JSON.stringify(provider.label)},
\t\tattestSource: ${JSON.stringify(provider.attestSource)},
\t\trequiredEnvVars: Object.freeze(${JSON.stringify(provider.requiredEnvVars)}),
\t\tsignature: Object.freeze(${JSON.stringify(provider.signature)}),
\t\trequiredCapability: 'imports:provide',
\t}),`
		)
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_IMPORT_PROVIDER_CATALOG = ${catalog};\n`;
}

export function renderImportProviderModules(plugins: readonly BundledPlugin[]): string {
	const providers = importProvidersFor(plugins);
	const imports = providers
		.map(
			(provider, index) =>
				`import bundledPluginImportProvider${index} from ${JSON.stringify(`${provider.packageName}${provider.exportPath.slice(1)}`)};`
		)
		.join('\n');
	const entries = providers
		.map(
			(provider, index) =>
				`\tObject.freeze({ kind: ${JSON.stringify(provider.kind)}, pluginId: ${JSON.stringify(provider.pluginId)}, module: bundledPluginImportProvider${index} satisfies PluginImportProviderModule }),`
		)
		.join('\n');
	const modules = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	const contractImport = providers.length
		? "import type { PluginImportProviderModule } from '@owlat/plugin-kit';\n"
		: '';
	return `'use node';\n\n${GENERATED_HEADER}${contractImport}${imports}${imports ? '\n\n' : ''}export const BUNDLED_PLUGIN_IMPORT_PROVIDER_MODULES = ${modules};\n`;
}
