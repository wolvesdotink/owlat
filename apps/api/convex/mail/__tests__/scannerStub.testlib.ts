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
 * Read a stubbed `/scan/attachment` call the way the runtime and the MTA would.
 *
 * THROWS for a header value `fetch` would have thrown on, which is the point.
 */
export function readScanRequest(url: RequestInfo | URL, init?: RequestInit): ScanStubRequest {
	// Validates every name and value exactly as the platform's own `fetch` does.
	const headers = new Headers(init?.headers as HeadersInit | undefined);
	const filenameHeader = headers.get('X-Filename') ?? '';
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
