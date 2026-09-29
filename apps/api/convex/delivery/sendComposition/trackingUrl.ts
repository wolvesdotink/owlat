/**
 * Send composition (module) — tracking URL leaf.
 *
 * The one definition of the open-pixel URL and of the click-tracking link
 * codec. V8-pure (Web APIs only), so both runtimes share it:
 *
 *   - the encode side, `transform.ts` (`'use node'`), wraps each href as
 *     `/t/c/{emailSendId}/{encodeTrackedTarget(href)}/{sig}`, where `sig` is
 *     HMAC-SHA256 (UNSUBSCRIBE_SECRET, base64url) over
 *     `trackedLinkSigningInput(emailSendId, encodedUrl)`;
 *   - the decode side, `delivery/trackingHttp.ts` (V8), recomputes that
 *     signature over the same signing input and, only when it matches, turns the
 *     segment back into the target with `decodeTrackedTarget`.
 *
 * The target segment is the unpadded base64url of the href's UTF-8 bytes, the
 * shape Node's `Buffer.from(href, 'utf-8').toString('base64url')` produced
 * before this codec existed, so links already sent keep decoding and verifying.
 * Decoding goes back through UTF-8: a Latin-1 read of those bytes would send an
 * IDN host such as `bücher.de` to a different hostname.
 */

import { base64UrlToBytes, bytesToBase64Url } from '../../lib/bytes';

export function getTrackingPixelUrl(convexSiteUrl: string, emailSendId: string): string {
	return `${convexSiteUrl}/t/o/${emailSendId}`;
}

/** The `{encodedUrl}` path segment for a tracked href. */
export function encodeTrackedTarget(url: string): string {
	return bytesToBase64Url(new TextEncoder().encode(url));
}

/** The href a `{encodedUrl}` path segment carries. */
export function decodeTrackedTarget(segment: string): string {
	return new TextDecoder().decode(base64UrlToBytes(segment));
}

/**
 * The string the click signature is computed over. It binds the target to its
 * send, so a recipient cannot graft their own valid signature onto a different
 * target (open redirect).
 */
export function trackedLinkSigningInput(emailSendId: string, encodedUrl: string): string {
	return `${emailSendId}.${encodedUrl}`;
}

/** The full signed click-tracking URL, as the click handler parses it. */
export function trackedLinkPath(
	siteUrl: string,
	emailSendId: string,
	encodedUrl: string,
	signature: string
): string {
	return `${siteUrl}/t/c/${emailSendId}/${encodedUrl}/${signature}`;
}
