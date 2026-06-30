/**
 * Send composition (module) — tracking URL leaf.
 *
 * Single V8-pure implementation of `getTrackingPixelUrl` / `getTrackedLinkUrl`
 * usable from both Convex V8 runtimes and `'use node'` actions. Replaces the
 * pre-deepening Node-only `Buffer.toString('base64url')` variant in
 * `emailWorker.ts` and the parallel `stringToBase64Url` in
 * `delivery/tracking.ts`.
 *
 * The decode side lives in `delivery/trackingHttp.ts` (it imports the V8
 * APIs directly for `base64url → string`). Both halves now share this single
 * format definition, locking the encode/decode contract by construction.
 */

function stringToBase64Url(str: string): string {
	const bytes = new TextEncoder().encode(str);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte !== undefined) {
			binary += String.fromCharCode(byte);
		}
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function getTrackingPixelUrl(convexSiteUrl: string, emailSendId: string): string {
	return `${convexSiteUrl}/t/o/${emailSendId}`;
}

/**
 * NOTE: currently has no callers — the live encode path is the inlined
 * link-wrapper in `transform.ts`, which HMAC-signs each target as
 * `/t/c/{id}/{encodedUrl}/{sig}`. The click handler (`trackingHttp.ts`) REQUIRES
 * a valid signature, so the unsigned URL this helper produces would be rejected
 * (redirect to `/`). If you revive it, sign the target the same way transform.ts
 * does — emitting an unsigned tracking link re-opens the open-redirect vector.
 */
export function getTrackedLinkUrl(
	convexSiteUrl: string,
	emailSendId: string,
	originalUrl: string,
): string {
	const encodedUrl = stringToBase64Url(originalUrl);
	return `${convexSiteUrl}/t/c/${emailSendId}/${encodedUrl}`;
}
