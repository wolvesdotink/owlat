/**
 * The MTA's side of the request signature described in `./signature.ts`.
 *
 * NODE-ONLY: uses `node:crypto`. Exposed via the `@owlat/mta-protocol/signer`
 * subpath and never from the barrel, which the Convex isolate imports. The API
 * verifies these headers with Web Crypto (`apps/api/convex/webhooks/mtaSignature.ts`).
 */

import { createHmac } from 'node:crypto';
import {
	MTA_SIGNATURE_HEADER,
	MTA_TIMESTAMP_HEADER,
	mtaSigningInput,
	type MtaSignatureHeaders,
} from './signature';

/**
 * Sign `body` for a request to the API. Pass the EXACT string sent as the
 * request body: the signature covers those characters, so re-serialising the
 * payload after signing breaks verification. Sign each attempt afresh; the
 * API only accepts a recent timestamp.
 */
export function signMtaRequest(
	secret: string,
	body: string,
	nowMs: number = Date.now()
): MtaSignatureHeaders {
	const timestamp = String(Math.floor(nowMs / 1000));
	const signature = createHmac('sha256', secret)
		.update(mtaSigningInput(timestamp, body))
		.digest('hex');
	return { [MTA_TIMESTAMP_HEADER]: timestamp, [MTA_SIGNATURE_HEADER]: signature };
}
