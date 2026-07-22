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
 * Signed format:  bounce+{base64url(messageId)}+{hmac}@bounces.owlat.com
 *   hmac = base64url( HMAC-SHA256(base64url(id) || ':' || window, key) )[:MAC_B64URL_LEN]
 *
 * `window` is a coarse, monotonically-increasing time bucket so that a captured
 * token does not stay replayable forever. Verification accepts the current
 * window and a bounded number of recent windows to cover the days-long DSN
 * delivery delay (RFC 5321 §4.5.4.1 retry horizon is 4–5 days).
 *
 * The legacy/unsigned format (`bounce+{base64url(id)}@`) remains available only
 * to isolated compatibility tests that deliberately omit a key. Production
 * startup requires BOUNCE_VERP_KEY, and the DSN/ARF parsers never accept the
 * unsigned helper result as attribution evidence.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Length (chars) of the base64url-encoded truncated HMAC carried in the token. */
const MAC_B64URL_LEN = 14; // ~84 bits — comfortably above the audit's 10-char floor

/** Window granularity: one bucket per day. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many *past* windows verification will accept in addition to the current
 * one. 6 prior days + today ≈ 7-day acceptance, covering the 4–5 day retry
 * horizon plus clock skew / late forwards. Tokens older than this no longer
 * verify and the bounce is dropped as unattributed.
 */
const WINDOW_TOLERANCE = 6;

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

/** Current coarse time bucket (UTC day number). Injectable for tests. */
function currentWindow(now: number): number {
	return Math.floor(now / WINDOW_MS);
}

/**
 * Compute the truncated, base64url-encoded MAC over `encodedId || ':' || window`.
 * Signing the *already base64url-encoded* id (not the raw id) keeps the MAC
 * input free of `@`/`+`/`=` so the token grammar is unambiguous.
 */
function computeMac(encodedId: string, window: number, key: string): string {
	return createHmac('sha256', key)
		.update(`${encodedId}:${window}`)
		.digest('base64url')
		.slice(0, MAC_B64URL_LEN);
}

/** Constant-time string compare that never throws on length mismatch. */
function macsEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
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
	const encoded = Buffer.from(messageId).toString('base64url');
	const signingKey = resolveVerpKey(key);
	if (!signingKey) {
		return `bounce+${encoded}@${returnPathDomain}`;
	}
	const mac = computeMac(encoded, currentWindow(now), signingKey);
	return `bounce+${encoded}+${mac}@${returnPathDomain}`;
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
	// Grammar: bounce+<encodedId>[+<mac>]@... — `+` separates id and mac, so the
	// encodedId capture must be `+`-free; the mac (when present) follows it.
	const match = address.match(/^bounce\+([A-Za-z0-9_-]+)(?:\+([A-Za-z0-9_-]+))?@/);
	if (!match?.[1]) return null;

	const encodedId = match[1];
	const presentedMac = match[2];
	const signingKey = resolveVerpKey(key);

	if (signingKey) {
		// Signed mode: a token with no MAC is unforgeable-proof-of-origin missing
		// → reject (forged unsigned DSN). Otherwise verify the MAC across the
		// accepted window range; any tamper of the id changes the encodedId the
		// MAC was computed over, so a wrong MAC and a tampered id both fail here.
		if (!presentedMac) return null;
		const base = currentWindow(now);
		let verified = false;
		for (let i = 0; i <= WINDOW_TOLERANCE; i++) {
			const expected = computeMac(encodedId, base - i, signingKey);
			if (macsEqual(expected, presentedMac)) {
				verified = true;
				break;
			}
		}
		if (!verified) return null;
	}

	// Decode the (now-authenticated, when signed) id back to the messageId.
	try {
		const decoded = Buffer.from(encodedId, 'base64url').toString('utf-8');
		return decoded.length > 0 ? decoded : null;
	} catch {
		return null;
	}
}
