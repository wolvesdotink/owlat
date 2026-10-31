/**
 * Owlat Feature Flags — single source of truth.
 *
 * Every toggleable product surface is declared in `featureFlagDefinitions.ts`
 * with its required env vars, docker profile and copy, and in
 * `featureFlagRuntime.ts` with its default state and dependency rules. The
 * setup CLI, web wizard, Convex backend, and Nuxt frontend all read the
 * registry through this module (`@owlat/shared/featureFlags`), so the toggle
 * list stays in sync across the stack. The siblings re-exported here hold the
 * registry operations (`featureFlagRegistry.ts`), what an enabled flag set
 * needs from the host (`featureFlagRequirements.ts`) and the packs
 * (`featurePacks.ts`).
 */

export {
	isPluginFeatureFlagDefinition,
	isPluginFeatureFlagKey,
} from './pluginFeatureFlagDefinition';
export {
	getDefaultFlags,
	resolveFlags,
	type CoreFeatureFlagKey,
	type FeatureFlagKey,
	type FeatureFlagState,
	type PluginFeatureFlagKey,
} from './featureFlagRuntime';
export {
	ALL_FEATURE_FLAG_KEYS,
	FEATURE_FLAGS,
	type CoreFeatureCategory,
	type CoreFeatureFlagDefinition,
	type FeatureCategory,
	type FeatureFlagDefinition,
	type PluginFeatureFlagDefinition,
} from './featureFlagDefinitions';
export {
	applyToggle,
	createFeatureFlagRegistry,
	getFeatureFlagDefinition,
	getFlagsByCategory,
	hasFeatureFlagDefinition,
	isFlagEnabled,
	registeredFeatureFlagOverrides,
	type FeatureFlagRegistry,
	type FeatureFlagResolutionOptions,
} from './featureFlagRegistry';
export {
	DELIVERY_PROVIDER_KINDS,
	SENDING_FLAGS_REQUIRING_DELIVERY,
	getActiveProfiles,
	getFlagOwnedProfiles,
	getRequiredEnvVars,
	getSendPathRequiredEnv,
	isDeliveryProviderKind,
	needsDeliveryProvider,
	type DeliveryProviderKind,
} from './featureFlagRequirements';
export {
	ALL_FEATURE_PACK_KEYS,
	FEATURE_PACKS,
	applyPackToggle,
	isPackEnabled,
	type FeaturePack,
	type FeaturePackKey,
	type PackState,
} from './featurePacks';
