import type { PluginCapability, PluginId } from '@owlat/plugin-kit';
import type { BundledPlugin } from './composition';
import { PluginHostError } from './errors';

export type BundledPluginFeatureFlagKey = `plugin.${string}`;

/** Framework-neutral definition consumed by the shared feature-flag registry. */
export interface BundledPluginFeatureFlagDefinition {
	readonly key: BundledPluginFeatureFlagKey;
	readonly category: 'plugins';
	readonly label: string;
	readonly description: string;
	readonly default: boolean;
	readonly requiredEnvVars: readonly string[];
	readonly requiredCapabilities: readonly PluginCapability[];
	readonly pluginPackageName: string;
}

/** Derive the runtime flag catalog from the one validated build composition. */
export function getBundledPluginFeatureFlagDefinitions(
	plugins: readonly BundledPlugin[]
): readonly BundledPluginFeatureFlagDefinition[] {
	const definitions = plugins.flatMap((plugin) => {
		const flag = plugin.manifest.flag;
		if (!flag) return [];

		const requiredEnvVars = Object.freeze([...(flag.requiredEnvVars ?? [])]);
		const requiredCapabilities = Object.freeze([...plugin.manifest.capabilities]);
		return [
			Object.freeze({
				key: pluginFeatureFlagKey(plugin.manifest.id),
				category: 'plugins' as const,
				label: pluginLabel(plugin.manifest.id),
				description: `Bundled plugin from ${plugin.packageName}.`,
				default: flag.default,
				requiredEnvVars,
				requiredCapabilities,
				pluginPackageName: plugin.packageName,
			}),
		];
	});

	return Object.freeze(definitions);
}

export interface PluginEnvironmentService {
	isPresent(name: string): boolean | Promise<boolean>;
}

export async function assertPluginEnvironmentRequirements(
	environment: PluginEnvironmentService,
	pluginId: PluginId,
	requiredEnvironmentVariables: readonly string[]
): Promise<void> {
	for (const variable of requiredEnvironmentVariables) {
		let isPresent: boolean;
		try {
			isPresent = (await environment.isPresent(variable)) === true;
		} catch (cause) {
			throw new PluginHostError(
				'environment_check_failed',
				`Could not verify environment requirement ${variable} for plugin ${pluginId}`,
				{ pluginId, environmentVariable: variable, cause }
			);
		}
		if (!isPresent) {
			throw new PluginHostError(
				'required_environment_missing',
				`Plugin ${pluginId} requires environment variable ${variable}`,
				{ pluginId, environmentVariable: variable }
			);
		}
	}
}

function pluginFeatureFlagKey(pluginId: PluginId): BundledPluginFeatureFlagKey {
	return `plugin.${pluginId}`;
}

function pluginLabel(pluginId: PluginId): string {
	return pluginId
		.split('-')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}
