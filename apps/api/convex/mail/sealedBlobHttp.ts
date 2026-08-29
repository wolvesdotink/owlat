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
import { corsHeaders } from '../lib/cors';

/**
 * Content types safe to render INLINE in a browser. A sealed blob's content-type
 * is attacker-influenceable (it was chosen by whoever composed the sealed
 * message), so anything outside this narrow allowlist is served as an
 * `attachment` download with `nosniff`, never rendered in the reader's origin.
 * Images and PDFs are the two kinds the Postbox reader displays inline; both are
 * handled by the browser's own sandboxed viewers. Everything else — most
 * dangerously `text/html`, `image/svg+xml` (scriptable), and any wildcard
 * catch-all type a caller might smuggle — downloads instead of executing.
 */
function isInlineContentType(contentType: string): boolean {
	const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	// SVG is an image but is scriptable, so it is deliberately NOT inline.
	if (base === 'image/svg+xml') return false;
	return base.startsWith('image/') || base === 'application/pdf';
}

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
		const inline = isInlineContentType(verified.contentType);
		return new Response(body, {
			status: 200,
			headers: {
				'Content-Type': verified.contentType,
				'Cache-Control': 'no-store',
				// The content-type is attacker-influenceable, so never let the browser
				// sniff a different one, and only render the two kinds the reader shows
				// inline (image/*, application/pdf). Anything else downloads.
				'X-Content-Type-Options': 'nosniff',
				'Content-Disposition': inline ? 'inline' : 'attachment',
				// Belt-and-suspenders: even a served-inline blob must not execute
				// script or navigate; a sandbox CSP neutralises an HTML/SVG type that
				// slipped the allowlist.
				'Content-Security-Policy': "default-src 'none'; sandbox",
				// The Postbox web reader fetches this cross-origin (the app origin →
				// the `.convex.site` HTTP-actions host). Scope the grant to the app
				// origin(s) rather than `*`; the capability token remains the access
				// control, this just stops any other origin from reading the bytes
				// through the victim's browser.
				...corsHeaders('GET, OPTIONS', request.headers.get('Origin')),
			},
		});
	} catch (err) {
		// A sealed blob that fails to decrypt (tamper / key mismatch) must not leak
		// ciphertext or 200 — surface a 500 and log for the operator.
		logError(`[sealedBlob] failed to serve ${verified.storageId}: ${String(err)}`);
		return errorResponse('internal', 'Internal Server Error');
	}
});
