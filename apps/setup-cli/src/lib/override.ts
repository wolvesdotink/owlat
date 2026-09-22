/**
 * Generate docker-compose.override.yml selecting the active profiles for the
 * resolved feature flag state. The rendering itself lives in
 * `@owlat/shared/composeOverride` (one writer shared with the web wizard and
 * the updater sidecar); this module owns the CLI-side filesystem plumbing.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	mergeComposeProfiles,
	parseComposeProfilesFromEnv,
	parseDeliveryProviderFromEnv,
	renderComposeOverrideYaml,
} from '@owlat/shared/composeOverride';
import { getActiveProfiles, type FeatureFlagState } from '@owlat/shared/featureFlags';

/**
 * The co-located `.env` — the one beside the override being written — as text,
 * or '' when there is none yet (a first install). Two answers come out of it:
 * the delivery provider, and the profiles already applied.
 */
async function readColocatedEnv(overridePath: string): Promise<string> {
	try {
		return await readFile(join(dirname(overridePath), '.env'), 'utf-8');
	} catch {
		return '';
	}
}

export async function writeComposeOverride(
	path: string,
	flags: FeatureFlagState,
	opts: { hosted?: boolean; deliveryProvider?: string } = {}
): Promise<string[]> {
	const envText = await readColocatedEnv(path);
	// The built-in MTA is opt-in: its `mta` compose profile activates when MTA is
	// the delivery provider (env-driven, not a flag) or when postbox/inbox need
	// it. Read EMAIL_PROVIDER as a fallback so post-setup flag toggles still keep
	// the MTA running for an MTA deployment.
	const deliveryProvider = opts.deliveryProvider ?? parseDeliveryProviderFromEnv(envText);
	// Union over the install-owned half of COMPOSE_PROFILES: `tls` (the Caddy
	// edge) and `dashboard` are not derivable from any flag state, so rendering
	// the derived set as the whole truth would drop them.
	const profiles = mergeComposeProfiles(
		parseComposeProfilesFromEnv(envText),
		getActiveProfiles(flags, { ...opts, deliveryProvider })
	);
	await writeFile(path, renderComposeOverrideYaml(profiles), 'utf-8');
	return profiles;
}
