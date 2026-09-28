/**
 * The write half of every setup route: the interactive wizard, `--config` and
 * `--assume-yes` all resolve an env map and a flag state their own way, then
 * persist them through here so the files on disk cannot drift between routes.
 */

import { sealRelayPasswordForBackup } from '@owlat/shared/envBackupBox';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import { writeEnv, type EnvMap } from './env';
import { saveFlagState } from './flagState';
import { writeComposeOverride } from './override';

export interface ResolvedSetup {
	owlatDir: string;
	envPath: string;
	overridePath: string;
	env: EnvMap;
	flags: FeatureFlagState;
	hosted: boolean;
}

/**
 * Write `.env`, the compose override and the flag mirror for a resolved setup,
 * and return the compose profiles the override activated.
 *
 * - The SMTP relay password is sealed in the `.env` BACKUP copy so it is never
 *   persisted in plaintext. The deploy step reseeds from `.env` through
 *   `selectRuntimeEnvVars`, which unseals sealed tokens before the live push,
 *   so the working credential still reaches the deployment env store.
 * - `.env` is written before the override because the override reads the
 *   co-located `.env` (delivery provider, install-owned profiles), then
 *   rewritten with the canonical `COMPOSE_PROFILES`, which the updater and a
 *   bare `docker compose` read. The MTA profile is opt-in, so it is only there
 *   when the delivery provider needs it.
 * - The resolved flags are mirrored to `.owlat-flags.json` so `doctor`,
 *   `feature` and `pack` start from the baseline this setup chose; without it
 *   they recompute from defaults and silently drop the selections.
 */
export async function persistResolvedSetup({
	owlatDir,
	envPath,
	overridePath,
	env,
	flags,
	hosted,
}: ResolvedSetup): Promise<string[]> {
	const envBackup = sealRelayPasswordForBackup(env);
	await writeEnv(envPath, envBackup);
	const profiles = await writeComposeOverride(overridePath, flags, { hosted });
	await writeEnv(envPath, { ...envBackup, COMPOSE_PROFILES: profiles.join(',') });
	await saveFlagState(owlatDir, flags);
	return profiles;
}
