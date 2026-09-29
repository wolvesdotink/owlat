/**
 * The MTA -> API request signature, stated once for both ends.
 *
 * Every request the MTA sends to a Convex HTTP route (feedback events, raw
 * inbound messages, TLS reports, app-password checks) carries two headers:
 *
 *   X-MTA-Timestamp: <unix seconds, ASCII digits>
 *   X-MTA-Signature: hex(HMAC-SHA256(MTA_WEBHOOK_SECRET, `${timestamp}.${body}`))
 *
 * A third header, added later, lets the API tell a large signed delivery from
 * unsigned traffic before it reads the body:
 *
 *   X-MTA-Length-Signature: hex(HMAC-SHA256(MTA_WEBHOOK_SECRET,
 *                               `owlat-mta-length-v1.${timestamp}.${byteLength}`))
 *
 * where `byteLength` is the UTF-8 length of the body, which is what the
 * request's `Content-Length` declares. It proves nothing about the body; the
 * API still verifies `X-MTA-Signature` over the bytes it reads, and a backend
 * that predates the header ignores it. An MTA that predates it simply omits it.
 *
 * The MTA signs with `signMtaRequest` (`./signer.ts`, Node only); the API
 * verifies with `verifyMtaSignedRequest` in
 * `apps/api/convex/webhooks/mtaSignature.ts`. Both read the header names and
 * the signing input from here. The format is a wire contract: deployed MTAs and
 * API backends upgrade independently, so neither the header names nor the
 * signing input may change without a versioned successor.
 *
 * Pure and runtime-neutral: the Convex isolate imports this module.
 */

/** Hex HMAC-SHA256 over {@link mtaSigningInput}. */
export const MTA_SIGNATURE_HEADER = 'X-MTA-Signature';

/** Unix seconds, ASCII digits only, as the signer wrote them. */
export const MTA_TIMESTAMP_HEADER = 'X-MTA-Timestamp';

/** Hex HMAC-SHA256 over {@link mtaLengthSigningInput}. */
export const MTA_LENGTH_SIGNATURE_HEADER = 'X-MTA-Length-Signature';

/** The signed-request headers, keyed by their canonical names. */
export type MtaSignatureHeaders = {
	readonly [MTA_TIMESTAMP_HEADER]: string;
	readonly [MTA_SIGNATURE_HEADER]: string;
	readonly [MTA_LENGTH_SIGNATURE_HEADER]: string;
};

/** The exact string both ends feed to HMAC-SHA256. */
export function mtaSigningInput(timestamp: string, body: string): string {
	return `${timestamp}.${body}`;
}

/**
 * The exact string both ends feed to HMAC-SHA256 for the length header. The
 * fixed prefix keeps it distinct from every {@link mtaSigningInput}, whose
 * input starts with the timestamp's digits.
 */
export function mtaLengthSigningInput(timestamp: string, byteLength: number): string {
	return `owlat-mta-length-v1.${timestamp}.${byteLength}`;
}
