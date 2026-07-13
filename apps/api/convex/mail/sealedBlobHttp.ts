/**
 * sealedBlobHttp — the decrypt-serving PROXY for sealed storage blobs (Sealed
 * Mail E8b). `GET /sealed-blob?id=&ct=&exp=&sig=` reads the sealed blob named by
 * a capability token, unseals it with the instance blob key, and streams the
 * PLAINTEXT bytes. See `lib/sealedBlob.ts` for the token construction and the
 * reasoning; this handler is the single place a sealed blob is opened for an
 * out-of-process consumer (web reader, IMAP bridge, outbound MTA, raw download).
 *
 * The token was minted only after the caller was authorized at the query site,
 * so verification here is: signature valid under `INSTANCE_SECRET` + not expired.
 * A bad/expired/forged token is a flat 403 — no blob is read, nothing leaks.
 */

import { httpAction } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { isValidConvexId } from '../lib/inputGuards';
import { readSealedBlobBytes, verifyBlobToken } from '../lib/sealedBlob';
import { logError } from '../lib/runtimeLog';
import { errorResponse } from '../lib/httpResponse';

export const serveSealedBlob = httpAction(async (ctx, request) => {
	const url = new URL(request.url);
	const verified = await verifyBlobToken(
		url.searchParams.get('id'),
		url.searchParams.get('ct'),
		url.searchParams.get('exp'),
		url.searchParams.get('sig')
	);
	if (!verified || !isValidConvexId(verified.storageId)) {
		return errorResponse('forbidden', 'Forbidden');
	}
	try {
		const bytes = await readSealedBlobBytes(ctx.storage, verified.storageId as Id<'_storage'>);
		if (bytes === null) return errorResponse('not_found', 'Not found');
		// Copy into a fresh ArrayBuffer-backed view so the Response body type is
		// unambiguous across runtimes.
		const body = new Uint8Array(bytes);
		return new Response(body, {
			status: 200,
			headers: {
				'Content-Type': verified.contentType,
				'Cache-Control': 'no-store',
				// The Postbox web reader fetches this cross-origin (the app origin →
				// the `.convex.site` HTTP-actions host), exactly as it did the Convex
				// signed storage URL this replaces. Allow the read; the capability
				// token is the access control.
				'Access-Control-Allow-Origin': '*',
			},
		});
	} catch (err) {
		// A sealed blob that fails to decrypt (tamper / key mismatch) must not leak
		// ciphertext or 200 — surface a 500 and log for the operator.
		logError(`[sealedBlob] failed to serve ${verified.storageId}: ${String(err)}`);
		return errorResponse('internal', 'Internal Server Error');
	}
});
