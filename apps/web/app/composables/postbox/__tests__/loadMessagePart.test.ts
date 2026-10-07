// @vitest-environment happy-dom
/**
 * `createMessagePartLoader` — one attachment of a Postbox message, fetched on
 * its own instead of inside the whole raw `.eml` (plan 3.5).
 *
 * Proven here:
 *   - a stored part comes back as a Blob of its own bytes and type
 *   - the minted URL is reused for 50 minutes after it arrived, so the
 *     browser's private cache of that URL can answer a second open
 *   - how long is counted on the device's clock alone (#1294): a device clock
 *     behind or ahead of the server's neither reuses an expired URL nor stops
 *     reusing a good one
 *   - a reused URL the proxy refuses is minted once more before giving up
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
/** The server's clock minus the device's. */
let serverSkew: number;
let mints: Array<[string, AttachmentMeta]>;
let fetched: string[];
let status: number;
let servedType: string;
let originalFetch: typeof globalThis.fetch;

function partUrl(exp: number): string {
	return `https://deploy.convex.site/sealed-blob?id=s1&ct=application%2Fpdf&exp=${exp}&sig=x&c=1`;
}

function loader(mintUrl: () => string | null = () => partUrl(clock + serverSkew + HOUR)) {
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
	serverSkew = 0;
	mints = [];
	fetched = [];
	status = 200;
	servedType = 'application/pdf';
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		fetched.push(String(input));
		// The proxy refuses a token past its `exp` by the SERVER's clock.
		const exp = Number(new URL(String(input)).searchParams.get('exp'));
		const answer = status === 200 && exp < clock + serverSkew ? 403 : status;
		return new Response(answer === 200 ? 'pdf bytes' : 'error page', {
			status: answer,
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

	it('reuses the minted URL for 50 minutes after it arrived', async () => {
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

	it('does not reuse an expired URL on a device clock running behind the server', async () => {
		serverSkew = 10 * 60_000;
		const load = loader();
		await load('msg_1', pdf);
		// 52 device minutes on: the token's `exp` is still ahead on the device's
		// clock, but 62 minutes have passed on the server's and it has expired.
		clock += 52 * 60_000;
		const blob = await load('msg_1', pdf);

		expect(blob).not.toBeNull();
		expect(mints).toHaveLength(2);
		expect(fetched).toHaveLength(2);
		expect(fetched[1]).not.toBe(fetched[0]);
	});

	it('keeps reusing URLs on a device clock running more than an hour ahead', async () => {
		serverSkew = -2 * HOUR;
		const load = loader();
		await load('msg_1', pdf);
		clock += 5 * 60_000;
		await load('msg_1', pdf);

		expect(mints).toHaveLength(1);
		expect(fetched[1]).toBe(fetched[0]);
	});

	it('mints once more when the proxy refuses a reused URL', async () => {
		const load = loader();
		await load('msg_1', pdf);
		clock += 10 * 60_000;
		// The server's clock jumped: the URL this device still holds has expired.
		serverSkew = 2 * HOUR;
		const blob = await load('msg_1', pdf);

		expect(await blob!.text()).toBe('pdf bytes');
		expect(mints).toHaveLength(2);
		expect(fetched).toHaveLength(3);
		expect(fetched[1]).toBe(fetched[0]);
		expect(fetched[2]).not.toBe(fetched[0]);
	});

	it('gives up after that one retry and forgets the URL', async () => {
		const load = loader();
		await load('msg_1', pdf);
		status = 500;
		expect(await load('msg_1', pdf)).toBeNull();
		expect(mints).toHaveLength(2);

		status = 200;
		expect(await load('msg_1', pdf)).not.toBeNull();
		expect(mints).toHaveLength(3);
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
