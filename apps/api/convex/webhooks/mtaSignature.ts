/**
 * Verification of the MTA's signed requests, for every route that takes them.
 *
 * The MTA signs each request it sends to this backend with
 * `signMtaRequest` from `@owlat/mta-protocol/signer`: an `X-MTA-Timestamp`
 * header and an `X-MTA-Signature` over `${timestamp}.${body}` under
 * `MTA_WEBHOOK_SECRET`. The routes that receive them verify through here:
 *
 *   /webhooks/mta-mailbox, /webhooks/mta-inbound   `adapters/mtaRawRoute.ts`
 *   /webhooks/mta-tls-report                       `domains/tlsReportsHttp.ts`
 *   /webhooks/mta-verify-credential                `mail/authHttp.ts`
 *
 * `/webhooks/mta` is a provider-feedback surface and goes through the verifier
 * registry (`providerVerifierRegistry.ts`) with a declared `hmac-timestamp-body`
 * verifier instead; it applies the same timestamp rules from `./security.ts`
 * with {@link MTA_EVENT_TOLERANCE_SECONDS}.
 *
 * The timestamp must be ASCII digits (`isUnixSecondsTimestamp`) and within the
 * route's window in both directions. Every caller states its window; there is
 * no default, so a route cannot drift to someone else's by omission.
 */

import {
	MTA_LENGTH_SIGNATURE_HEADER,
	MTA_SIGNATURE_HEADER,
	MTA_TIMESTAMP_HEADER,
	mtaLengthSigningInput,
	mtaSigningInput,
} from '@owlat/mta-protocol/signature';
import {
	constantTimeEqual,
	hmacSha256Hex,
	isUnixSecondsTimestamp,
	isWithinTimestampTolerance,
} from './security';

/**
 * Window for event deliveries (feedback events and raw inbound messages). The
 * MTA re-signs every retry with a fresh timestamp, so this only has to absorb
 * clock skew and queueing between signing and arrival.
 */
export const MTA_EVENT_TOLERANCE_SECONDS = 300;

/**
 * Window for the request/response calls (app-password checks, TLS reports),
 * which the MTA signs immediately before sending and does not queue.
 */
export const MTA_REQUEST_TOLERANCE_SECONDS = 60;

export type MtaSignatureFailure = 'missing_headers' | 'invalid_timestamp' | 'invalid_signature';

export type MtaSignatureVerdict = { ok: true } | { ok: false; reason: MtaSignatureFailure };

interface MtaSignatureWindow {
	toleranceSeconds: number;
	/** Clock override for tests. */
	nowMs?: number;
}

/**
 * The header half of the check: both headers present, the timestamp digits
 * only and inside the window. Needs no body and no secret, so a route can
 * refuse a stale or malformed request before reading anything.
 */
export function readMtaSignatureHeaders(
	request: Request,
	{ toleranceSeconds, nowMs = Date.now() }: MtaSignatureWindow
):
	| { ok: true; timestamp: string; signature: string }
	| { ok: false; reason: Exclude<MtaSignatureFailure, 'invalid_signature'> } {
	const signature = request.headers.get(MTA_SIGNATURE_HEADER);
	const timestamp = request.headers.get(MTA_TIMESTAMP_HEADER);
	if (!signature || !timestamp) return { ok: false, reason: 'missing_headers' };
	if (
		!isUnixSecondsTimestamp(timestamp) ||
		!isWithinTimestampTolerance(timestamp, toleranceSeconds, nowMs)
	) {
		return { ok: false, reason: 'invalid_timestamp' };
	}
	return { ok: true, timestamp, signature };
}

/**
 * Verify an MTA-signed request whose body has already been read as `bodyText`
 * (the exact text the signature covers).
 */
export async function verifyMtaSignedRequest(
	request: Request,
	bodyText: string,
	options: MtaSignatureWindow & { secret: string }
): Promise<MtaSignatureVerdict> {
	const headers = readMtaSignatureHeaders(request, options);
	if (!headers.ok) return headers;
	const expected = await hmacSha256Hex(
		options.secret,
		mtaSigningInput(headers.timestamp, bodyText)
	);
	return constantTimeEqual(headers.signature, expected)
		? { ok: true }
		: { ok: false, reason: 'invalid_signature' };
}

/**
 * The body length the MTA attested to in `X-MTA-Length-Signature`, or `null`
 * when the header is absent, the timestamp is outside the window, the request
 * declares no plain `Content-Length`, the length exceeds `maxBytes`, or the
 * signature does not match.
 *
 * Needs no body, so a route can tell a large signed delivery from unsigned
 * traffic before reading anything. It proves only that the MTA signed a request
 * of this length at this time: the caller must still read at most the returned
 * number of bytes and verify `X-MTA-Signature` over them.
 */
export async function verifyMtaDeclaredLength(
	request: Request,
	options: MtaSignatureWindow & { secret: string; maxBytes: number }
): Promise<number | null> {
	const lengthSignature = request.headers.get(MTA_LENGTH_SIGNATURE_HEADER);
	if (!lengthSignature) return null;
	const headers = readMtaSignatureHeaders(request, options);
	if (!headers.ok) return null;
	const declared = request.headers.get('content-length')?.trim() ?? '';
	if (!/^\d{1,12}$/.test(declared)) return null;
	const byteLength = Number(declared);
	if (byteLength > options.maxBytes) return null;
	const expected = await hmacSha256Hex(
		options.secret,
		mtaLengthSigningInput(headers.timestamp, byteLength)
	);
	return constantTimeEqual(lengthSignature, expected) ? byteLength : null;
}
