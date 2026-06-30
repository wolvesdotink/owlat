/**
 * Read and write `.env` files.
 *
 * The implementation now lives in `@owlat/shared/setupEnv` so the CLI and the
 * web setup endpoint share a single source of truth. This module re-exports it
 * (under the CLI's historical `readEnv` / `writeEnv` names) so existing call
 * sites keep working unchanged.
 */

export { mergeEnv, type EnvMap } from '@owlat/shared/setupEnv';
export { readEnvFile as readEnv, writeEnvFile as writeEnv } from '@owlat/shared/setupEnv';
