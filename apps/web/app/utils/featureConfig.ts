/**
 * Pure helpers for the Features settings page.
 *
 * The backend `organizations.featureFlags.getFlagsConfigStatus` query reports,
 * per flag, the requirements that are NOT met (missing env vars, or — for
 * sending flags — a missing delivery provider). This joins that report against
 * the resolved on/off state so the UI can badge flags that are ENABLED but not
 * yet configured ("needs config").
 */

import type { FeatureFlagDefinition } from '@owlat/shared/featureFlags';

/**
 * The set of flags that are enabled yet still missing configuration. A flag
 * only qualifies when it is resolved-on AND the config-status map lists at
 * least one unmet requirement for it. Returns an empty set while the status
 * map is still loading (`undefined`/`null`) so the UI never badges prematurely.
 */
export function flagsNeedingConfig(
	resolved: Record<string, boolean>,
	configStatus: Record<string, string[]> | undefined | null
): Set<string> {
	const result = new Set<string>();
	if (!configStatus) return result;
	for (const [flag, missing] of Object.entries(configStatus)) {
		if (resolved[flag] && missing.length > 0) result.add(flag);
	}
	return result;
}

/** Missing env names only; capability gaps use a `Grant: ` status prefix. */
export function missingPluginEnvironmentVariables(
	definition: FeatureFlagDefinition,
	configStatus: Record<string, string[]> | undefined | null
): string[] {
	const missing = new Set(configStatus?.[definition.key] ?? []);
	return (definition.requiredEnvVars ?? []).filter((variable) => missing.has(variable));
}
