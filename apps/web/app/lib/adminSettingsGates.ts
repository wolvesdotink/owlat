/**
 * The gates the admin registry (`adminSettingsRegistry.ts`) puts its entries
 * behind, and the environment they read. Split out of the registry so its
 * table of pages stays under the file-size cap; the registry re-exports the
 * two types, so importers keep one place to get them from.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

/**
 * The ambient inputs an admin gate reads. Role is deliberately absent: the whole
 * tree already sits behind the `admin` route middleware, so a gate here answers
 * "does this deployment have this page" rather than "may this person open it".
 */
export interface AdminEnvironment {
	isFeatureEnabled(flag: FeatureFlagKey): boolean;
	/** Deployment-level tooling (operator console, system, backups). */
	isPlatformAdmin: boolean;
	/** This build ships at least one plugin that has settings. */
	hasPlugins: boolean;
	/** The delivery ramp has taken over a cell (now, or within decision retention). */
	hasRampStarted: boolean;
}

export type AdminGate = (env: AdminEnvironment) => boolean;

export const flag =
	(key: FeatureFlagKey): AdminGate =>
	(env) =>
		env.isFeatureEnabled(key);
export const anyFlag =
	(...keys: readonly FeatureFlagKey[]): AdminGate =>
	(env) =>
		keys.some((key) => env.isFeatureEnabled(key));
export const platformOnly: AdminGate = (env) => env.isPlatformAdmin;
export const withPlugins: AdminGate = (env) => env.hasPlugins;
export const rampStarted: AdminGate = (env) => env.hasRampStarted;
