/**
 * First-run setup token.
 *
 * NODE-ONLY: uses `node:crypto`. The unauthenticated setup endpoints
 * (`/api/setup/apply`, `/api/setup/validate-provider`) run only while the
 * instance is in setup mode, before any admin account exists. Setup mode alone
 * is not an authorization boundary — the first caller would otherwise create the
 * platform-admin account and rewrite `.env`, i.e. take over the instance. The
 * setup token closes that hole: the `owlat setup` CLI mints one when it enables
 * setup mode, writes it to the root-owned `.env`, and prints it to the console;
 * the wizard must echo it back in the `X-Setup-Token` header, and the endpoints
 * verify it with a constant-time compare.
 *
 * Exposed via the `@owlat/shared/setupToken` subpath ONLY — it uses `node:crypto`
 * and must never be re-exported from the `.` barrel, which has to stay
 * browser-safe.
 */

import { secretMatches } from './constantTimeEqual';
import { generateSecret } from './setupSecrets';

/**
 * Mint a fresh setup token. High-entropy (40 base62 chars ≈ 238 bits) with a
 * cosmetic `stk_` prefix for human recognition in logs; the prefix carries no
 * meaning to the verifier, which compares the whole string.
 */
export function generateSetupToken(): string {
	return `stk_${generateSecret(40)}`;
}

/**
 * Constant-time equality of `provided` against `expected` (`secretMatches`):
 * leaks neither length nor content via timing, and fails closed when either
 * side is missing or empty, so an unconfigured token can never be satisfied.
 */
export function isValidSetupToken(
	provided: string | null | undefined,
	expected: string | null | undefined
): boolean {
	return secretMatches(provided, expected);
}
