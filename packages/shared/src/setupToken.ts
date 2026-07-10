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

import { timingSafeEqual, createHash } from 'node:crypto';
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
 * Constant-time equality of `provided` against `expected`. Both are hashed to
 * SHA-256 first so `timingSafeEqual`'s equal-length precondition always holds
 * and the comparison leaks neither length nor content via timing. Fails closed
 * when either side is missing or empty — an unconfigured token can never be
 * satisfied. Mirrors the `safeCompare` pattern in
 * `apps/web/server/utils/updater.ts`.
 */
export function isValidSetupToken(
	provided: string | null | undefined,
	expected: string | null | undefined
): boolean {
	if (!provided || !expected) return false;
	const hashProvided = createHash('sha256').update(provided).digest();
	const hashExpected = createHash('sha256').update(expected).digest();
	return timingSafeEqual(hashProvided, hashExpected);
}
