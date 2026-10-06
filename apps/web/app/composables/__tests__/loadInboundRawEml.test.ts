// @vitest-environment happy-dom
/**
 * `loadInboundRawEml` — fetching a team-inbox message's raw `.eml` so the
 * reader can extract an attachment out of it client-side.
 *
 * Proven here:
 *   - a successful fetch returns the body as a binary string (one char per
 *     byte, exactly), so binary and 8-bit parts survive the trip through a
 *     string
 *   - a second call for the same message does NOT re-issue the action
 *   - a null URL — the fail-closed case when the instance has a key but no
 *     proxy origin, or when the bytes were swept — resolves to null instead of
 *     throwing, because the caller renders it as a visible failure
 *   - a rejected fetch evicts the cache entry, so a retry actually retries
 *   - a NON-OK response is not cached as the message: the proxy's error body
 *     would otherwise be decoded as the `.eml` and re-served to every retry
 *   - and the round trip the whole feature rests on: `extractAttachmentAt` over
 *     the decoded text returns the named part's bytes
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { extractAttachmentAt, extractFirstPartByType } from '@owlat/shared/mailMime';

import { loadInboundRawEml } from '../loadInboundRawEml';

const RAW_URL_FN = getFunctionName(api.inbox.rawMessage.getInboundMessageRawUrl);

let actionCalls: string[];
let urlFor: (messageId: string) => string | null;
let fetchBody: (url: string) => Promise<ArrayBuffer>;
let fetchStatus: number;
let originalFetch: typeof globalThis.fetch;

/** A two-part message whose second leaf carries a byte outside ASCII. */
const RAW_EML = [
	'From: bob@example.com',
	'To: inbox@example.com',
	'Subject: parts',
	'Content-Type: multipart/mixed; boundary="bb"',
	'',
	'--bb',
	'Content-Type: text/plain; name="a.txt"',
	'Content-Disposition: attachment; filename="a.txt"',
	'Content-Transfer-Encoding: base64',
	'',
	Buffer.from('first part').toString('base64'),
	'',
	'--bb',
	'Content-Type: application/octet-stream; name="b.txt"',
	'Content-Disposition: attachment; filename="b.txt"',
	'Content-Transfer-Encoding: base64',
	'',
	Buffer.from([0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64, 0xff]).toString('base64'),
	'',
	'--bb--',
	'',
].join('\r\n');

function latin1Buffer(text: string): ArrayBuffer {
	const bytes = Buffer.from(text, 'latin1');
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

beforeEach(() => {
	actionCalls = [];
	urlFor = (messageId) => `https://convex.test/sealed-blob?id=${messageId}`;
	fetchBody = async () => latin1Buffer(RAW_EML);
	originalFetch = globalThis.fetch;

	vi.stubGlobal('requireConvex', () => ({
		action: (fnRef: Parameters<typeof getFunctionName>[0], args: { messageId: string }) => {
			actionCalls.push(getFunctionName(fnRef));
			return Promise.resolve(urlFor(args.messageId));
		},
	}));
	fetchStatus = 200;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		return {
			ok: fetchStatus >= 200 && fetchStatus < 300,
			status: fetchStatus,
			arrayBuffer: async () => await fetchBody(url),
		} as Response;
	}) as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.unstubAllGlobals();
});

describe('loadInboundRawEml', () => {
	it('returns the raw message decoded byte-for-byte', async () => {
		const body = await loadInboundRawEml('msg_decode');

		expect(actionCalls).toEqual([RAW_URL_FN]);
		expect(body).toBe(RAW_EML);
	});

	it('serves a repeat request for the same message from cache', async () => {
		await loadInboundRawEml('msg_cached');
		expect(actionCalls).toHaveLength(1);

		const second = await loadInboundRawEml('msg_cached');

		expect(second).toBe(RAW_EML);
		// No second action call: raw .eml blobs are immutable.
		expect(actionCalls).toHaveLength(1);
	});

	it('resolves null when the URL cannot be minted, rather than throwing', async () => {
		// `sealedBlobUrl` fails CLOSED — a key with no CONVEX_SITE_URL, or a
		// sealed blob on a keyless instance, both yield null.
		urlFor = () => null;

		await expect(loadInboundRawEml('msg_nourl')).resolves.toBeNull();
	});

	it('evicts the cache entry when the fetch fails, so a retry re-fetches', async () => {
		fetchBody = async () => {
			throw new Error('network down');
		};
		await expect(loadInboundRawEml('msg_retry')).rejects.toThrow('network down');
		expect(actionCalls).toHaveLength(1);

		fetchBody = async () => latin1Buffer(RAW_EML);
		await expect(loadInboundRawEml('msg_retry')).resolves.toBe(RAW_EML);
		// A cached rejection would have made this a second failure, not a retry.
		expect(actionCalls).toHaveLength(2);
	});

	it('does not cache a 403 from the blob proxy as the message', async () => {
		// The proxy answers with a BODY on an error, so without a status check
		// the error page IS the `.eml`: extraction returns null, the reader is
		// told the download failed, and the resolved promise stays in the cache
		// — so the retry reads the same page rather than re-fetching.
		fetchStatus = 403;
		fetchBody = async () => latin1Buffer('<html>forbidden</html>');

		await expect(loadInboundRawEml('msg_403')).rejects.toThrow('403');

		fetchStatus = 200;
		fetchBody = async () => latin1Buffer(RAW_EML);
		await expect(loadInboundRawEml('msg_403')).resolves.toBe(RAW_EML);
		expect(actionCalls).toHaveLength(2);
	});

	it('hands the extractor something it can pull a binary part out of', async () => {
		const body = await loadInboundRawEml('msg_extract');

		const part = extractAttachmentAt(body!, '1', 'b.txt');

		expect(part).not.toBeNull();
		expect(part!.filename).toBe('b.txt');
		// The trailing 0xFF is the point: a UTF-8 decode would have replaced it.
		expect(Array.from(part!.bytes)).toEqual([0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64, 0xff]);
	});

	it('keeps bytes 0x80-0x9F of an 8-bit or binary part exactly (#1279)', async () => {
		// `TextDecoder('latin1')` is windows-1252: 0x80 became U+20AC, and the
		// extractor's low byte of that is 0xAC.
		const binary = [0x00, 0x41, 0x80, 0x99, 0x9f, 0xa0, 0xff];
		const encoder = new TextEncoder();
		const message = Uint8Array.from([
			...encoder.encode(
				[
					'Content-Type: multipart/mixed; boundary="b"',
					'',
					'--b',
					'Content-Type: text/plain; charset=utf-8',
					'Content-Transfer-Encoding: 8bit',
					'',
					'Price — “quoted” 5€',
					'--b',
					'Content-Type: application/octet-stream; name="blob.bin"',
					'Content-Disposition: attachment; filename="blob.bin"',
					'Content-Transfer-Encoding: binary',
					'',
					'',
				].join('\r\n')
			),
			...binary,
			...encoder.encode('\r\n--b--\r\n'),
		]);
		fetchBody = async () => message.buffer;

		const body = await loadInboundRawEml('msg_binary');

		expect(Array.from(body!, (c) => c.charCodeAt(0))).toEqual([...message]);
		expect(Array.from(extractAttachmentAt(body!, '0', 'blob.bin')!.bytes)).toEqual(binary);
		const text = extractFirstPartByType(body!, 'text/plain')!;
		expect(new TextDecoder().decode(text.bytes)).toBe('Price — “quoted” 5€');
	});
});
