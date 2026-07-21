import type { PluginId } from '@owlat/plugin-kit';
import { PluginHostError } from './errors';

export interface PluginFeatureFlagService {
	/** Only the literal boolean `true` enables a plugin. */
	isEnabled(pluginId: PluginId): boolean | Promise<boolean>;
}

/** Run statically composed code only while its plugin flag is explicitly on. */
export async function runWithPluginFeatureFlag<Result>(
	featureFlags: PluginFeatureFlagService,
	pluginId: PluginId,
	operation: () => Result | Promise<Result>
): Promise<Result> {
	let enabled: boolean;
	try {
		enabled = (await featureFlags.isEnabled(pluginId)) === true;
	} catch (cause) {
		throw new PluginHostError(
			'feature_check_failed',
			`Could not verify whether plugin ${pluginId} is enabled`,
			{ pluginId, cause }
		);
	}

	if (!enabled) {
		throw new PluginHostError('plugin_disabled', `Plugin ${pluginId} is disabled`, { pluginId });
	}
	return operation();
}
