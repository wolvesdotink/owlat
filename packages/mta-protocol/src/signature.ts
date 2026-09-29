/**
 * The MTA -> API request signature, stated once for both ends.
 *
 * Every request the MTA sends to a Convex HTTP route (feedback events, raw
 * inbound messages, TLS reports, app-password checks) carries two headers:
 *
 *   X-MTA-Timestamp: <unix seconds, ASCII digits>
 *   X-MTA-Signature: hex(HMAC-SHA256(MTA_WEBHOOK_SECRET, `${timestamp}.${body}`))
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

/** The two signed-request headers, keyed by their canonical names. */
export type MtaSignatureHeaders = {
	readonly [MTA_TIMESTAMP_HEADER]: string;
	readonly [MTA_SIGNATURE_HEADER]: string;
};

/** The exact string both ends feed to HMAC-SHA256. */
export function mtaSigningInput(timestamp: string, body: string): string {
	return `${timestamp}.${body}`;
}
