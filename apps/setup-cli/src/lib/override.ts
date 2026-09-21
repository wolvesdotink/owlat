/**
 * Generate docker-compose.override.yml selecting the active profiles for the
 * resolved feature flag state. The rendering itself lives in
 * `@owlat/shared/composeOverride` (one writer shared with the web wizard and
 * the updater sidecar); this module owns the CLI-side filesystem plumbing.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDeliveryProviderFromEnv, renderComposeOverride } from '@owlat/shared/composeOverride';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';

/**
 * The built-in MTA is opt-in: its `mta` compose profile activates when MTA is
 * the delivery provider (env-driven, not a flag) or when postbox/inbox need it.
 * The provider lives in `.env` (EMAIL_PROVIDER), co-located with the override —
 * read it as a fallback so post-setup flag toggles still keep the MTA running
 * for an MTA deployment. Best-effort: a missing/unparseable .env returns undefined.
 */
async function readDeliveryProvider(overridePath: string): Promise<string | undefined> {
	try {
		const envText = await readFile(join(dirname(overridePath), '.env'), 'utf-8');
		return parseDeliveryProviderFromEnv(envText);
	} catch {
		return undefined;
	}
}

export async function writeComposeOverride(
	path: string,
	flags: FeatureFlagState,
	opts: { hosted?: boolean; deliveryProvider?: string } = {}
): Promise<string[]> {
	const deliveryProvider = opts.deliveryProvider ?? (await readDeliveryProvider(path));
	const { profiles, yaml } = renderComposeOverride(flags, { ...opts, deliveryProvider });
	await writeFile(path, yaml, 'utf-8');
	return profiles;
}
