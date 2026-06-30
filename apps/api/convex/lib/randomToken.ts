// Alphanumeric alphabet for human-pasteable secrets (no ambiguous symbols).
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a cryptographically-random token of `length` alphanumeric
 * characters, with an optional fixed prefix.
 *
 * Single source for the API-key (`lm_live_…`), webhook-secret (`whsec_…`), and
 * account-deletion cancellation tokens, which previously each hand-rolled the
 * same `getRandomValues` + modulo-into-alphabet loop.
 */
export function randomToken(length: number, prefix = ''): string {
	const randomValues = new Uint32Array(length);
	crypto.getRandomValues(randomValues);
	let out = '';
	for (let i = 0; i < length; i++) {
		out += TOKEN_CHARS.charAt(randomValues[i]! % TOKEN_CHARS.length);
	}
	return prefix + out;
}
