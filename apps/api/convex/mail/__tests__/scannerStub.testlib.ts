/**
 * One honest reader for a stubbed `/scan/attachment` request.
 *
 * WHY IT IS NOT A `Record<string, string>` LOOKUP. Every scanner test in this
 * repo replaced `fetch` with a `vi.fn` and read `init.headers['X-Filename']`
 * off the plain object it was handed. A `vi.fn` validates nothing, so the stub
 * accepted header values the real runtime refuses outright — and `X-Filename`
 * carries a SENDER-CHOSEN filename. An HTTP header value is a ByteString: a
 * Cyrillic or CJK name, a NUL or a CRLF makes undici throw before it opens a
 * socket, the client's catch maps that to `'skipped'`, and the message is never
 * scanned while its download stays live. The suite could not see any of it.
 *
 * Building a real `Headers` here is what closes that: it applies the same
 * validation `fetch` does, so a stub answering a request the runtime would have
 * rejected now fails the test instead of passing it.
 *
 * Mirror of `mail/mtaClient.encodeFilenameHeader` on the read side: the client
 * percent-encodes the name, so a stub that wants the real filename decodes it.
 */
export type ScanStubRequest = {
	url: string;
	/** The filename as the MTA would see it — percent-decoded. */
	filename: string;
	/** The raw header value, before decoding. */
	filenameHeader: string;
	authorization: string | null;
	body: Uint8Array;
};

/**
 * The longest `X-Filename` value a stub will answer, in header characters.
 *
 * `new Headers()` validates CHARACTERS but not SIZE, so a stub alone cannot see
 * the other half of the sender-chosen-filename problem: the MTA serves
 * `/scan/attachment` through `@hono/node-server` on Node's default
 * `--max-http-header-size` of 16 KiB and answers 431 — before the route runs —
 * for anything past it, which the client reads as a fail-open skip and the
 * message goes unscanned. A real `http.createServer` was probed to confirm the
 * 431; this constant is how the suite keeps seeing it.
 *
 * Well under the real 16 KiB, because that limit covers the WHOLE header block
 * and `mtaClient` bounds this one value at 1 KiB anyway.
 */
export const MAX_STUB_FILENAME_HEADER_CHARS = 8 * 1024;

/**
 * Read a stubbed `/scan/attachment` call the way the runtime and the MTA would.
 *
 * THROWS for a header value `fetch` would have thrown on — and for one the
 * MTA's HTTP server would have answered 431 to — which is the point.
 */
export function readScanRequest(url: RequestInfo | URL, init?: RequestInit): ScanStubRequest {
	// Validates every name and value exactly as the platform's own `fetch` does.
	const headers = new Headers(init?.headers as HeadersInit | undefined);
	const filenameHeader = headers.get('X-Filename') ?? '';
	if (filenameHeader.length > MAX_STUB_FILENAME_HEADER_CHARS) {
		throw new Error(
			`X-Filename is ${filenameHeader.length} chars — the MTA's server answers 431 above ` +
				`${MAX_STUB_FILENAME_HEADER_CHARS}, and the client reads that as an unscanned file`
		);
	}
	let filename: string;
	try {
		filename = decodeURIComponent(filenameHeader);
	} catch {
		filename = filenameHeader;
	}
	const rawBody = init?.body;
	return {
		url: typeof url === 'string' ? url : url.toString(),
		filename,
		filenameHeader,
		authorization: headers.get('Authorization'),
		body:
			rawBody instanceof ArrayBuffer
				? new Uint8Array(rawBody)
				: ArrayBuffer.isView(rawBody)
					? new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
					: new Uint8Array(0),
	};
}
