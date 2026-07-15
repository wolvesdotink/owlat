import { getBundledPluginFeatureFlagDefinitions } from '@owlat/plugin-host';
import {
	createFeatureFlagRegistry,
	type PluginFeatureFlagDefinition,
} from '@owlat/shared/featureFlags';
import { bundledPluginComposition } from './plugins.generated';

export const PLUGIN_FEATURE_FLAG_DEFINITIONS =
	getBundledPluginFeatureFlagDefinitions(bundledPluginComposition);

export const FEATURE_FLAG_REGISTRY = createFeatureFlagRegistry(PLUGIN_FEATURE_FLAG_DEFINITIONS);

/**
 * Validate one explicit app-store-style approval against the capabilities in
 * the immutable manifest snapshot. All requested capabilities must be approved
 * exactly once; declaration alone never grants authority.
 */
export function validatePluginCapabilityApproval(
	definition: PluginFeatureFlagDefinition,
	approvedCapabilities: readonly string[] | undefined
): Readonly<Record<string, boolean>> {
	const required = definition.requiredCapabilities;
	const approved = approvedCapabilities ?? [];
	if (approved.length !== required.length) {
		throw new TypeError(`Approve every capability requested by ${definition.key}`);
	}

	const requiredSet = new Set(required);
	const approvedSet = new Set(approved);
	if (approvedSet.size !== approved.length) {
		throw new TypeError(`Capability approvals for ${definition.key} contain duplicates`);
	}
	for (const capability of approved) {
		if (!requiredSet.has(capability)) {
			throw new TypeError(`Unknown capability approval for ${definition.key}: ${capability}`);
		}
	}
	for (const capability of required) {
		if (!approvedSet.has(capability)) {
			throw new TypeError(`Missing capability approval for ${definition.key}: ${capability}`);
		}
	}

	return Object.freeze(Object.fromEntries(required.map((capability) => [capability, true])));
}
