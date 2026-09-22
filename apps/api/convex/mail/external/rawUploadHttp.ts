import { MAIL_SYNC_MAX_RAW_MESSAGE_BYTES } from '@owlat/shared/mailSyncLimits';
import { BodyTooLargeError, readBodyBytes } from '../../lib/readBody';
/**
 * Raw `.eml` upload for the mail-sync worker.
 *
 * The worker used to hand the whole message to `ingestExternalRaw` as a base64
 * ARGUMENT. Convex caps a function-call request body at 16 MiB, and base64
 * inflates by 4/3, so every message over ~12 MiB of source — an ordinary mail
 * with a few photos attached — was rejected by the backend with
 * `Failed to buffer the request body: length limit exceeded` before any of the
 * repository's code ran. On a real mailbox that was ~5% of messages, silently
 * left behind while the import reported itself finished.
 *
 * HTTP actions do not share that cap (their bodies stream), so the bytes come
 * in here instead and the ingest call carries only a storage id. What is left
 * in the action's arguments — the parsed header fields, the capped bodies, the
 * 64 KiB header block — is bounded by construction, while this endpoint enforces a separate raw-message ceiling.
 *
 * AUTH: the `MAIL_SYNC_API_KEY` shared secret, the same one Convex presents to
 * the worker's own `/send` and `/scan` endpoints. It is deliberately not a new
 * variable: both sides already hold this one, so an instance that updates does
 * not need its environment changed to keep importing. Fails CLOSED — with no
 * key configured there is no way to authenticate a caller, so the route is shut.
 */

import { httpAction } from '../../_generated/server';
import { getOptional } from '../../lib/env';
import { safeCompare } from '../../lib/safeCompare';
import { errorResponse, jsonResponse } from '../../lib/httpResponse';
import { storeSealedBlob } from '../../lib/sealedBlob';
import { logError } from '../../lib/runtimeLog';

/** Buffered sealing must fit in the HTTP action's 64 MiB isolate. */
export const MAX_RAW_MESSAGE_BYTES = MAIL_SYNC_MAX_RAW_MESSAGE_BYTES;
const TOO_LARGE_MESSAGE = `Message exceeds the ${MAIL_SYNC_MAX_RAW_MESSAGE_BYTES / (1024 * 1024)} MiB raw message limit (including attachments)`;

export const handleRawMessageUpload = httpAction(async (ctx, request) => {
	const expected = getOptional('MAIL_SYNC_API_KEY');
	if (!expected) {
		// No configured secret ⇒ no way to tell the worker from anyone else.
		return errorResponse('invalid_state', 'Mail sync is not configured');
	}
	const header = request.headers.get('authorization') ?? '';
	const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
	if (!safeCompare(presented, expected)) {
		return errorResponse('unauthenticated', 'Unauthorized');
	}

	// Content-Length is advisory (a chunked upload has none), so the decoded
	// length is checked again below — this only avoids buffering an obvious
	// over-size body at all.
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_RAW_MESSAGE_BYTES) {
		void request.body?.cancel().catch(() => undefined);
		return errorResponse('limit_reached', TOO_LARGE_MESSAGE);
	}

	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readBodyBytes(request, MAX_RAW_MESSAGE_BYTES));
	} catch (error) {
		if (error instanceof BodyTooLargeError)
			return errorResponse('limit_reached', TOO_LARGE_MESSAGE);
		logError('mail-sync raw upload: unreadable body', error);
		return errorResponse('invalid_input', 'Unreadable body');
	}
	if (bytes.byteLength === 0) return errorResponse('invalid_input', 'Empty body');
	if (bytes.byteLength > MAX_RAW_MESSAGE_BYTES) {
		return errorResponse('limit_reached', TOO_LARGE_MESSAGE);
	}

	// Sealed at rest exactly as the old inline path sealed it, so the reader and
	// the `/sealed-blob` proxy are unaffected by where the bytes came from.
	const size = bytes.byteLength;
	const storageId = await storeSealedBlob(ctx.storage, bytes, 'message/rfc822');
	return jsonResponse({ storageId, size });
});
