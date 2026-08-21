/**
 * THE RENDER BOUNDARY FOR THE SHARED FEATURE-FLAG REGISTRY.
 *
 * `@owlat/shared/featureFlags` is read by the setup CLI as well as by this app,
 * and `@owlat/plugin-host` mints a definition per bundled plugin at RUNTIME, so
 * its `label`/`description` stay English sentences rather than catalog keys (the
 * reasoning is on `FeatureFlagDefinitionBase` there). The web still has to paint
 * German, so the words come from `sharedPkg.featureFlags.*` — a key DERIVED from
 * the flag/pack key, the same trick the docs sidebar uses for its nav labels.
 *
 * The fallback is the point: a plugin flag ("Policy pack", "Bundled plugin from
 * @example/policy-pack.") can never have a shipped catalog entry, so a missing
 * key renders the registry's own English instead of the key path a `t()` would
 * have painted at the operator.
 */
import type { FeatureFlagDefinition, FeaturePackKey } from '@owlat/shared/featureFlags';
import { FEATURE_PACKS } from '@owlat/shared/featureFlags';

/** Catalog key for a flag's name. Dots in the flag key nest, as they do in JSON. */
export function featureFlagLabelKey(flag: string): string {
	return `sharedPkg.featureFlags.flags.${flag}.label`;
}

export function featureFlagDescriptionKey(flag: string): string {
	return `sharedPkg.featureFlags.flags.${flag}.description`;
}

export function featurePackLabelKey(pack: FeaturePackKey): string {
	return `sharedPkg.featureFlags.packs.${pack}.label`;
}

export function featurePackDescriptionKey(pack: FeaturePackKey): string {
	return `sharedPkg.featureFlags.packs.${pack}.description`;
}

export function useFeatureCopy() {
	const { t, te } = useI18n();

	/** The catalog's words when it has them, the registry's English when it does not. */
	const translated = (key: string, fallback: string): string => (te(key) ? t(key) : fallback);

	return {
		/** A flag's name: core flags from the catalog, plugin flags from the plugin. */
		flagLabel: (definition: FeatureFlagDefinition): string =>
			translated(featureFlagLabelKey(definition.key), definition.label),
		flagDescription: (definition: FeatureFlagDefinition): string =>
			translated(featureFlagDescriptionKey(definition.key), definition.description),
		/**
		 * A flag's name from its key alone — for the cascade dialogs and toasts,
		 * which name flags the registry may not know (a stale stored key).
		 */
		flagKeyLabel: (flag: string, definition?: FeatureFlagDefinition): string =>
			translated(featureFlagLabelKey(flag), definition?.label ?? flag),
		packLabel: (pack: FeaturePackKey): string =>
			translated(featurePackLabelKey(pack), FEATURE_PACKS[pack].label),
		packDescription: (pack: FeaturePackKey): string =>
			translated(featurePackDescriptionKey(pack), FEATURE_PACKS[pack].description),
	};
}
