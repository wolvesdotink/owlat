/**
 * Reading a submitted JSON body safely.
 *
 * Submission is open to the world and unauthenticated (the attestation's own
 * signature is the credential, plan §4.1), so the body is read with a hard byte
 * cap and the cap is enforced on the *stream*, not on `Content-Length`: a
 * declared length is a claim by the sender, and a chunked request makes no such
 * claim at all. The declared length is still checked first, because rejecting
 * before reading is cheaper for both ends.
 */
import { badRequest, payloadTooLarge, unsupportedMediaType } from './errors.js';

/** Default ceiling on a submitted body. A real attestation is ~1 KiB. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

const JSON_MEDIA_TYPES = new Set(['application/json', 'text/json', 'application/ostr+json']);

function assertJsonContentType(request: Request): void {
	const header = request.headers.get('content-type');
	// Absent is tolerated: the body is parsed as JSON either way, and a curl
	// one-liner that forgot the header is not worth a rejection.
	if (header === null || header === '') return;
	const mediaType = header.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	if (!JSON_MEDIA_TYPES.has(mediaType)) {
		throw unsupportedMediaType(`content-type ${mediaType} is not JSON`);
	}
}

async function readCappedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
	const declared = request.headers.get('content-length');
	if (declared !== null && declared !== '') {
		const length = Number(declared);
		if (!Number.isFinite(length) || length < 0) throw badRequest('malformed content-length');
		if (length > maxBytes) throw payloadTooLarge(`body must be at most ${maxBytes} bytes`);
	}

	const stream = request.body;
	if (stream === null) return new Uint8Array(0);

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > maxBytes) throw payloadTooLarge(`body must be at most ${maxBytes} bytes`);
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
		// Abandoning a body mid-flight leaves the connection unusable; cancelling
		// tells the peer we are done with it. Failure here is not the caller's.
		if (total > maxBytes) await stream.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks);
}

/**
 * The request body parsed as JSON, or a thrown {@link HttpError}: 413 when it
 * exceeds `maxBytes`, 415 for a non-JSON content type, 400 when it is empty or
 * not JSON. The value is `unknown` on purpose — validating it is the log's job
 * (`RegistryLog.submit`), and a shape assertion here would be a second,
 * drifting copy of `@owlat/ostr-core`'s validator.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
	assertJsonContentType(request);
	const bytes = await readCappedBody(request, maxBytes);
	if (bytes.byteLength === 0) throw badRequest('request body must not be empty');
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw badRequest('request body must be UTF-8');
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw badRequest('request body must be valid JSON');
	}
}
