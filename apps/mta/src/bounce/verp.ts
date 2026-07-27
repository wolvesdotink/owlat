/**
 * VERP (Variable Envelope Return-Path) encoding/decoding with a signed token.
 *
 * Encodes the message ID into the return-path address so bounce DSNs can be
 * correlated back to the original send without external state. The encoded id
 * is additionally authenticated with a truncated HMAC (BATV-style signature,
 * draft-levine-smtp-batv) so a forged DSN cannot poison the suppression list.
 *
 * Threat model (RFC 5321: anyone may submit a DSN to a null-sender envelope;
 * `onMailFrom` skips SPF for the empty return-path that real DSNs use): without
 * a signature an attacker who guesses or leaks a `messageId` can send a
 * hand-crafted `bounce+<b64url(id)>@bounces.owlat.com` DSN and have a healthy
 * recipient blocklisted. The HMAC makes the token unforgeable: the MTA only
 * attributes (and therefore only suppresses on) tokens it actually signed.
 *
 * The token grammar, the MAC and the acceptance window now live in
 * `@owlat/shared/verp` because the Convex relay adapter has to stamp the SAME
 * envelope sender on relayed sends (otherwise the relay arm produces no bounce
 * data of its own and the transport comparison is biased toward whichever side
 * reports fewer bounces). This module is the MTA-side wrapper: it keeps the
 * env-resolved key and the ambient clock the existing MTA call sites rely on.
 * Behaviour is unchanged.
 *
 * Signed format:  bounce+{base64url(messageId)}+{hmac}@bounces.owlat.com
 *
 * The legacy/unsigned format (`bounce+{base64url(id)}@`) remains available only
 * to isolated compatibility tests that deliberately omit a key. Production
 * startup requires BOUNCE_VERP_KEY, and the DSN/ARF parsers never accept the
 * unsigned helper result as attribution evidence.
 */

import {
	buildVerpAddress as buildVerpAddressWithKey,
	parseVerpAddress as parseVerpAddressWithKey,
} from '@owlat/shared/verp';

/**
 * Resolve the VERP signing key. Reading the env here (rather than threading it
 * through every caller) keeps `buildVerpAddress`/`parseVerpAddress` drop-in for
 * the existing call sites; tests pass the key explicitly. An empty/undefined
 * key enables the unsigned compatibility helper used only by isolated tests;
 * production startup rejects that configuration.
 */
function resolveVerpKey(explicit?: string): string | undefined {
	const key = explicit ?? process.env['BOUNCE_VERP_KEY'];
	return key && key.length > 0 ? key : undefined;
}

/**
 * Whether VERP token signing/verification is active for this deployment.
 *
 * When this is true, attribution of a bounce/complaint to a send MUST come from
 * a `parseVerpAddress`-verified signed token — the unauthenticated
 * `X-Owlat-Message-Id` header-scrape fallbacks in the DSN/ARF parsers are
 * attacker-controllable (genuine DSNs echo our outbound headers back, and a
 * forged null-sender report can carry an arbitrary value) and must NOT be used
 * to suppress a recipient once a key is configured.
 *
 * @param key optional explicit key (defaults to BOUNCE_VERP_KEY)
 */
export function isVerpSigningEnabled(key?: string): boolean {
	return resolveVerpKey(key) !== undefined;
}

/**
 * Build a VERP return-path address encoding the message ID.
 *
 * A signing key produces the production HMAC token. Omitting it produces the
 * legacy unsigned form only for isolated compatibility tests; production
 * startup requires BOUNCE_VERP_KEY.
 *
 * @param messageId        the send's stored providerMessageId
 * @param returnPathDomain the bounce domain (e.g. `bounces.owlat.com`)
 * @param key              optional signing key (defaults to BOUNCE_VERP_KEY)
 * @param now              optional clock injection for the window (tests)
 */
export function buildVerpAddress(
	messageId: string,
	returnPathDomain: string,
	key?: string,
	now: number = Date.now()
): string {
	return buildVerpAddressWithKey(messageId, returnPathDomain, resolveVerpKey(key), now);
}

/**
 * Parse a VERP address to extract the message ID.
 *
 * Returns null if the address is not a valid VERP address, or — when a signing
 * key is configured — if the token is unsigned, the id was tampered with, or
 * the MAC does not verify within the accepted window range. A null result means
 * the DSN is unattributable and MUST NOT be used to suppress a recipient.
 *
 * @param address the SMTP envelope recipient the DSN was addressed to
 * @param key     optional signing key (defaults to BOUNCE_VERP_KEY)
 * @param now     optional clock injection for the window (tests)
 */
export function parseVerpAddress(
	address: string,
	key?: string,
	now: number = Date.now()
): string | null {
	return parseVerpAddressWithKey(address, resolveVerpKey(key), now);
}
