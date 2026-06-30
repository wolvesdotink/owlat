/**
 * Generate cryptographically secure secrets for the install.
 *
 * The implementation now lives in `@owlat/shared/setupSecrets` so the CLI and
 * the web setup endpoint share a single source of truth (same prefixed
 * `mta_…` / `whsec_…` formats and hex `INSTANCE_SECRET`). This module simply
 * re-exports it so existing call sites keep working unchanged.
 */

export { generateSecret, generateHexSecret, ensureSecrets } from '@owlat/shared/setupSecrets';
