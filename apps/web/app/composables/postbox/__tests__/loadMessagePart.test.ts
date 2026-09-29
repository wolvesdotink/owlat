// @vitest-environment happy-dom
/**
 * `createMessagePartLoader` — one attachment of a Postbox message, fetched on
 * its own instead of inside the whole raw `.eml` (plan 3.5).
 *
 * Proven here:
 *   - a stored part comes back as a Blob of its own bytes and type
 *   - the minted URL is reused until shortly before its token expires, so the
 *     browser's private cache of that URL can answer a second open
 *   - `null` from the mint (no stored part) and a non-OK fetch both resolve to
 *     null, which is the caller's cue to use the raw `.eml`; the bad URL is
 *     forgotten so the next open mints a fresh one
 *   - a part served as octet-stream takes the row's own content type
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMessagePartLoader } from '../loadMessagePart';
import type { AttachmentMeta } from '~/utils/attachmentMeta';

const HOUR = 3_600_000;
const pdf: AttachmentMeta = {
	filename: 'agenda.pdf',
	contentType: 'application/pdf',
	size: 10,
	partIndex: '0',
};

let clock: number;
let mints: Array<[string, AttachmentMeta]>;
let fetched: string[];
let status: number;
let servedType: string;
let originalFetch: typeof globalThis.fetch;

function partUrl(exp: number): string {
	return `https://deploy.convex.site/sealed-blob?id=s1&ct=application%2Fpdf&exp=${exp}&sig=x&c=1`;
}

function loader(mintUrl: () => string | null = () => partUrl(clock + HOUR)) {
	return createMessagePartLoader(
		async (messageId, att) => {
			mints.push([messageId, att]);
			return mintUrl();
		},
		() => clock
	);
}

beforeEach(() => {
	clock = 1_000_000;
	mints = [];
	fetched = [];
	status = 200;
	servedType = 'application/pdf';
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		fetched.push(String(input));
		return new Response(status === 200 ? 'pdf bytes' : 'error page', {
			status,
			headers: { 'Content-Type': servedType },
		});
	}) as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('createMessagePartLoader', () => {
	it('returns the stored part as a Blob of its own bytes and type', async () => {
		const blob = await loader()('msg_1', pdf);

		expect(blob).not.toBeNull();
		expect(await blob!.text()).toBe('pdf bytes');
		expect(blob!.type).toBe('application/pdf');
		expect(mints).toEqual([['msg_1', pdf]]);
	});

	it('reuses the minted URL until shortly before the token expires', async () => {
		const load = loader();
		await load('msg_1', pdf);
		clock += HOUR / 2;
		await load('msg_1', pdf);

		// Same URL both times: the second fetch is one the HTTP cache can answer.
		expect(mints).toHaveLength(1);
		expect(fetched).toHaveLength(2);
		expect(fetched[0]).toBe(fetched[1]);

		clock += HOUR / 2 - 30_000;
		await load('msg_1', pdf);
		expect(mints).toHaveLength(2);
	});

	it('resolves null when the part is not stored on its own', async () => {
		const blob = await loader(() => null)('msg_old', pdf);

		expect(blob).toBeNull();
		expect(fetched).toEqual([]);
	});

	it('resolves null on a non-OK answer and mints afresh next time', async () => {
		const load = loader();
		status = 404;
		expect(await load('msg_1', pdf)).toBeNull();

		status = 200;
		expect(await load('msg_1', pdf)).not.toBeNull();
		expect(mints).toHaveLength(2);
	});

	it('labels an octet-stream answer with the row content type', async () => {
		servedType = 'application/octet-stream';
		const blob = await loader()('msg_1', pdf);

		expect(blob!.type).toBe('application/pdf');
	});
});
