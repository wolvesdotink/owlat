import {
	orderHostedContributions,
	parsePluginPackageName,
	type BundledPlugin,
} from '@owlat/plugin-host';
import { parsePluginId, pluginNamespacedKind } from '@owlat/plugin-kit';
import { GENERATED_HEADER, renderPluginModuleFile } from './renderShared';

interface RenderedCron {
	readonly packageName: string;
	readonly pluginId: string;
	readonly kind: string;
	readonly label: string;
	readonly exportPath: string;
	readonly intervalMinutes: number;
	readonly timeoutMs: number;
	readonly requiredEnvVars: readonly string[];
}

function cronsFor(plugins: readonly BundledPlugin[]): readonly RenderedCron[] {
	return orderHostedContributions(
		plugins.flatMap((plugin) =>
			(plugin.manifest.contributes?.crons ?? []).map((cron) => ({
				pluginId: parsePluginId(plugin.manifest.id),
				contributionId: cron.id,
				value: {
					packageName: parsePluginPackageName(plugin.packageName),
					label: cron.label,
					exportPath: cron.module.exportPath,
					intervalMinutes: cron.schedule.intervalMinutes,
					timeoutMs: cron.timeoutMs,
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

export function renderCronCatalog(plugins: readonly BundledPlugin[]): string {
	const entries = cronsFor(plugins)
		.map(
			(cron) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(cron.kind)},
\t\tpluginId: ${JSON.stringify(cron.pluginId)},
\t\tlabel: ${JSON.stringify(cron.label)},
\t\tintervalMinutes: ${cron.intervalMinutes},
\t\ttimeoutMs: ${cron.timeoutMs},
\t\trequiredEnvVars: Object.freeze(${JSON.stringify(cron.requiredEnvVars)}),
\t\trequiredCapability: 'scheduler:cron',
\t}),`
		)
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_CRON_CATALOG = ${catalog};\n`;
}

export function renderCronModules(plugins: readonly BundledPlugin[]): string {
	return renderPluginModuleFile(cronsFor(plugins), {
		varPrefix: 'bundledPluginCron',
		contract: 'PluginCronModule',
		modulesConst: 'BUNDLED_PLUGIN_CRON_MODULES',
		useNode: true,
	});
}
