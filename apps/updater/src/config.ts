/**
 * The updater's environment, read in one place.
 *
 * This is the only module that reads `process.env` (the workspace lint enforces
 * it). The instance secret and the install directory are fixed for the life of
 * the process and read at load, as before; the rest is read when asked for.
 */

import { readIntEnv } from '@owlat/shared/nodeEnv';

/**
 * The port the sidecar listens on. Through `readIntEnv`, so a blank, partial or
 * out-of-range PORT stops the boot with the key named, instead of `parseInt`
 * handing `listen()` a NaN.
 */
export function readListenPort(
	env: Readonly<Record<string, string | undefined>> = process.env
): number {
	return readIntEnv(env, 'PORT', { default: 3200, min: 1, max: 65535 });
}

/** The secret every endpoint checks; unset, every request is refused (http.ts). */
export const INSTANCE_SECRET = process.env['INSTANCE_SECRET'];

/** The Owlat install directory: `.env`, the compose files and the rollout state. */
export const OWLAT_DIR = process.env['OWLAT_DIR'] || '/opt/owlat';

/** The release this container was created at, as `/health` reports it. */
export interface BuildInfo {
	version: string;
	gitSha: string;
	buildDate: string;
}

export function readBuildInfo(): BuildInfo {
	return {
		version: process.env['OWLAT_VERSION'] || 'dev',
		gitSha: process.env['OWLAT_GIT_SHA'] || 'unknown',
		buildDate: process.env['OWLAT_BUILD_DATE'] || 'unknown',
	};
}

/** The Docker endpoint the self-update helper container must be pointed at. */
export function dockerHost(): string | undefined {
	return process.env['DOCKER_HOST'];
}

/**
 * A copy of the updater's own environment for a docker or compose child. The
 * caller (`exec` in http.ts) removes what compose would let shadow `--env-file`.
 */
export function inheritedChildEnv(): NodeJS.ProcessEnv {
	return { ...process.env };
}
