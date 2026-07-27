/**
 * VERP (Variable Envelope Return-Path) token core — ONE scheme, two callers.
 *
 * The encoding, the BATV-style truncated HMAC and the coarse time window all
 * shipped inside the MTA (`apps/mta/src/bounce/verp.ts`). The relay arm of the
 * transport comparison now has to stamp the SAME envelope sender so a bounce
 * that a third-party relay generates still reaches our own bounce server and
 * attributes to the same send the direct-MX path would have attributed it to.
 *
 * Two implementations of one token grammar would be a silent attribution
 * outage the first time either side changed, so the core lives here and both
 * the MTA and the Convex relay adapter call it. The MTA wrapper keeps the
 * env/clock defaults it always had; Convex passes its key explicitly (direct
 * `process.env` reads are blocked outside `lib/env.ts`).
 *
 * Signed format:  bounce+{base64url(messageId)}+{hmac}@{returnPathDomain}
 *   hmac = base64url( HMAC-SHA256(base64url(id) || ':' || window, key) )[:MAC_LEN]
 *
 * This module is PURE: no env reads, no ambient clock. Key and `now` are
 * parameters.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Length (chars) of the base64url-encoded truncated HMAC carried in the token. */
export const VERP_MAC_B64URL_LEN = 14; // ~84 bits

/** Window granularity: one bucket per day. */
export const VERP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many *past* windows verification accepts in addition to the current one.
 * 6 prior days + today ≈ 7-day acceptance, covering the RFC 5321 §4.5.4.1
 * retry horizon plus clock skew / late forwards.
 */
export const VERP_WINDOW_TOLERANCE = 6;

/** Local-part prefix every VERP address carries. */
export const VERP_LOCAL_PART_PREFIX = 'bounce';

/**
 * Minimum signing-key length. The MTA rejects anything shorter at startup
 * (`apps/mta/src/config.ts`), so a shorter key on the Convex side would mint
 * tokens the MTA can never verify — the same floor has to hold on both sides.
 */
export const VERP_KEY_MIN_BYTES = 32;

/**
 * Normalise a configured VERP signing key: trim surrounding whitespace, treat
 * blank as unset.
 *
 * ONE definition, because the key is ONE secret with two independent readers
 * that must derive the SAME HMAC key from the SAME configured value. A quoted
 * `.env` value, a docker-compose `environment:` entry or a dashboard paste with
 * a trailing newline all carry surrounding whitespace; if one side trimmed it
 * and the other did not, the two sides would sign with different keys and every
 * relay-stamped token would fail verification at the MTA — failing safe (the
 * transport merely grades unsupported) but for an invisible reason.
 */
export function normalizeVerpKey(key: string | undefined): string | undefined {
	const normalized = key?.trim();
	return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

/**
 * Is this a key both sides will accept? A short/typo'd copy is not.
 *
 * Measured AFTER {@link normalizeVerpKey}, so surrounding whitespace can never
 * pad a too-short key over the floor on one side of the wire.
 */
export function isUsableVerpKey(key: string | undefined): key is string {
	const normalized = normalizeVerpKey(key);
	return normalized !== undefined && Buffer.byteLength(normalized, 'utf8') >= VERP_KEY_MIN_BYTES;
}

/**
 * Normalise a configured return-path domain: trim, drop a trailing root dot
 * (an absolute FQDN is legal in DNS config and illegal in an address), and
 * treat blank as unset. One definition — the MTA, the relay adapter and the
 * capability probe must all build the SAME address for the same configuration.
 */
export function normalizeReturnPathDomain(value: string | undefined): string | undefined {
	const normalized = value?.trim().replace(/\.$/, '');
	return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

/** Current coarse time bucket (UTC day number). */
function verpWindow(now: number): number {
	return Math.floor(now / VERP_WINDOW_MS);
}

/**
 * Truncated, base64url-encoded MAC over `encodedId || ':' || window`. Signing
 * the *already base64url-encoded* id keeps the MAC input free of `@`/`+`/`=`
 * so the token grammar stays unambiguous.
 */
function computeVerpMac(encodedId: string, window: number, key: string): string {
	return createHmac('sha256', key)
		.update(`${encodedId}:${window}`)
		.digest('base64url')
		.slice(0, VERP_MAC_B64URL_LEN);
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
 * Build a VERP return-path address encoding `messageId`.
 *
 * A key produces the production HMAC token; omitting it produces the legacy
 * unsigned form, which exists only for isolated compatibility tests (both
 * production callers require a key).
 */
export function buildVerpAddress(
	messageId: string,
	returnPathDomain: string,
	rawKey: string | undefined,
	now: number
): string {
	// Normalise HERE as well as at the config seams: this is the one place both
	// sides' HMAC input is assembled, so it is the one place that can guarantee
	// a whitespace-padded copy of the same secret signs identically.
	const key = normalizeVerpKey(rawKey);
	const encoded = Buffer.from(messageId).toString('base64url');
	if (!key) {
		return `${VERP_LOCAL_PART_PREFIX}+${encoded}@${returnPathDomain}`;
	}
	const mac = computeVerpMac(encoded, verpWindow(now), key);
	return `${VERP_LOCAL_PART_PREFIX}+${encoded}+${mac}@${returnPathDomain}`;
}

/**
 * Parse a VERP address back to its message id, or `null` when the address is
 * not a VERP address, is unsigned while a key is configured, was tampered
 * with, or its MAC falls outside the accepted window range. `null` means the
 * report is unattributable and MUST NOT suppress a recipient.
 */
export function parseVerpAddress(
	address: string,
	rawKey: string | undefined,
	now: number
): string | null {
	const key = normalizeVerpKey(rawKey);
	// Grammar: bounce+<encodedId>[+<mac>]@… — `+` separates id and mac, so the
	// encodedId capture must be `+`-free; the mac (when present) follows it.
	const match = address.match(/^bounce\+([A-Za-z0-9_-]+)(?:\+([A-Za-z0-9_-]+))?@/);
	if (!match?.[1]) return null;

	const encodedId = match[1];
	const presentedMac = match[2];

	if (key) {
		// A token with no MAC carries no proof of origin → reject. Any tamper of
		// the id changes the MAC input, so a tampered id fails here too.
		if (!presentedMac) return null;
		const base = verpWindow(now);
		let verified = false;
		for (let i = 0; i <= VERP_WINDOW_TOLERANCE; i++) {
			if (macsEqual(computeVerpMac(encodedId, base - i, key), presentedMac)) {
				verified = true;
				break;
			}
		}
		if (!verified) return null;
	}

	try {
		const decoded = Buffer.from(encodedId, 'base64url').toString('utf-8');
		return decoded.length > 0 ? decoded : null;
	} catch {
		return null;
	}
}
