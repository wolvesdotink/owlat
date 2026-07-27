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
export function buildVerpAddressWithKey(
	messageId: string,
	returnPathDomain: string,
	key: string | undefined,
	now: number
): string {
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
export function parseVerpAddressWithKey(
	address: string,
	key: string | undefined,
	now: number
): string | null {
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
