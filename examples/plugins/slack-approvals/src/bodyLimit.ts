/**
 * Request-body size cap, enforced BEFORE any signature work on either inbound
 * surface (the Slack callback and the Owlat hook).
 *
 * A forged request is unauthenticated, yet both verifiers would otherwise
 * SHA-256/HMAC and JSON.parse the whole attacker-supplied body before the
 * signature comparison rejects it — an unauthenticated work amplifier. Rejecting
 * an over-cap body up front (fail closed: a typed `body_too_large`, which the
 * callers map to 401 / a held gate) bounds that work to the cap, never the
 * attacker's chosen length.
 *
 * This is defence in depth: the HTTP host in front of the app MUST ALSO cap the
 * request body (most frameworks do by default). This in-app cap models the
 * defence and protects the reference even behind a permissive host.
 */

/** Maximum accepted raw request body, in UTF-8 bytes (64 KiB). */
export const MAX_RAW_BODY_BYTES = 64 * 1024;

/**
 * True when `rawBody` encodes to at most {@link MAX_RAW_BODY_BYTES} UTF-8 bytes.
 *
 * Counts bytes directly from UTF-16 code units (runtime-neutral — no
 * `TextEncoder` allocation) and EARLY-EXITS the moment the cap is crossed, so an
 * oversized body is rejected after inspecting at most ~cap characters. The
 * expensive hashing/parsing never runs on an over-cap forged body.
 */
export function isRawBodyWithinLimit(rawBody: string): boolean {
	let bytes = 0;
	for (let index = 0; index < rawBody.length; index += 1) {
		const code = rawBody.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			// High surrogate: a surrogate pair encodes to 4 UTF-8 bytes; skip the
			// paired low surrogate so it is not counted again.
			bytes += 4;
			index += 1;
		} else {
			bytes += 3;
		}
		if (bytes > MAX_RAW_BODY_BYTES) return false;
	}
	return true;
}
