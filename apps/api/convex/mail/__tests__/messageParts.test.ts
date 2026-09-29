/**
 * Per-part attachment storage (plan 3.5) — the pure halves.
 *
 *   - `pickStoredPart` must pick the part `extractAttachmentAt` would pick out
 *     of the raw message, for every index/filename a reader can send, or a
 *     stored download would hand over a different file than the fallback.
 *   - The sealed-blob proxy caches only a token minted cacheable, privately,
 *     and never past the token's own expiry.
 *   - The cacheable flag is signed: it cannot be added to, or removed from, a
 *     token minted the other way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAttachmentAt, extractAttachments } from '@owlat/shared/mailMime';
import { pickStoredPart } from '../messageParts';
import { cacheControlFor, sealedBlobUrl, verifyBlobToken } from '../../lib/sealedBlob';
import type { Id } from '../../_generated/dataModel';

function leaf(name: string, body: string, disposition = 'attachment'): string[] {
	return [
		'--bb',
		`Content-Type: text/plain; name="${name}"`,
		`Content-Disposition: ${disposition}; filename="${name}"`,
		'Content-Transfer-Encoding: base64',
		'',
		Buffer.from(body).toString('base64'),
		'',
	];
}

/** Three leaves, two of them sharing a filename, one inline. */
const RAW = [
	'From: bob@example.com',
	'To: alice@example.com',
	'Subject: parts',
	'Content-Type: multipart/mixed; boundary="bb"',
	'',
	'--bb',
	'Content-Type: text/plain',
	'',
	'body text',
	'',
	...leaf('a.txt', 'first a'),
	...leaf('logo.png', 'logo bytes', 'inline'),
	...leaf('a.txt', 'second a'),
	'--bb--',
	'',
].join('\r\n');

describe('pickStoredPart', () => {
	const leaves = extractAttachments(RAW);
	const stored = leaves.map((part, index) => ({ filename: part.filename, index }));

	const cases: Array<[string, string | undefined]> = [
		['0', 'a.txt'],
		['1', 'logo.png'],
		['2', 'a.txt'],
		['0', undefined],
		// Index and name disagree: the name wins, first match.
		['1', 'a.txt'],
		['0', 'logo.png'],
		// Out of range: the name alone.
		['7', 'logo.png'],
		['7', 'a.txt'],
		// Nothing resolves.
		['7', 'missing.bin'],
		['7', undefined],
		// Unknown name, index in range: the index anyway.
		['2', 'renamed.txt'],
		['-1', undefined],
		['abc', 'logo.png'],
	];

	it.each(cases)('partIndex %s / filename %s matches extractAttachmentAt', (idx, name) => {
		const expected = extractAttachmentAt(RAW, idx, name);
		const picked = pickStoredPart(stored, idx, name);
		if (expected === null) {
			expect(picked).toBeNull();
			return;
		}
		expect(picked).not.toBeNull();
		expect(picked!.filename).toBe(expected.filename);
		expect(new TextDecoder().decode(leaves[picked!.index]!.bytes)).toBe(
			new TextDecoder().decode(expected.bytes)
		);
	});
});

describe('cacheControlFor', () => {
	const now = 1_000_000;

	it('answers no-store for a token that was not minted cacheable', () => {
		expect(cacheControlFor({ cacheable: false, expiresAt: now + 3_600_000 }, now)).toBe('no-store');
	});

	it('lets the browser keep a cacheable part privately until the token expires', () => {
		expect(cacheControlFor({ cacheable: true, expiresAt: now + 3_600_000 }, now)).toBe(
			'private, max-age=3600, immutable'
		);
		expect(cacheControlFor({ cacheable: true, expiresAt: now + 90_500 }, now)).toBe(
			'private, max-age=90, immutable'
		);
	});

	it('never caches an answer for a token about to lapse', () => {
		expect(cacheControlFor({ cacheable: true, expiresAt: now + 400 }, now)).toBe('no-store');
	});
});

describe('cacheable capability tokens', () => {
	const storage = { getUrl: async () => null };
	const id = 'kg2abc' as Id<'_storage'>;

	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'message-parts-test-secret-at-least-32-chars');
		vi.stubEnv('CONVEX_SITE_URL', 'https://deploy.convex.site');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function params(url: string | null) {
		const p = new URL(url!).searchParams;
		return [p.get('id'), p.get('ct'), p.get('exp'), p.get('sig'), p.get('c')] as const;
	}

	it('verifies a cacheable token as cacheable and a plain one as not', async () => {
		const cacheable = params(
			await sealedBlobUrl(storage, id, 'application/pdf', { cacheable: true })
		);
		const plain = params(await sealedBlobUrl(storage, id, 'application/pdf'));
		expect(cacheable[4]).toBe('1');
		expect(plain[4]).toBeNull();
		expect((await verifyBlobToken(...cacheable))?.cacheable).toBe(true);
		expect((await verifyBlobToken(...plain))?.cacheable).toBe(false);
	});

	it('refuses the flag bolted onto a plain token, or stripped from a cacheable one', async () => {
		const [pid, pct, pexp, psig] = params(await sealedBlobUrl(storage, id, 'application/pdf'));
		expect(await verifyBlobToken(pid, pct, pexp, psig, '1')).toBeNull();

		const [cid, cct, cexp, csig] = params(
			await sealedBlobUrl(storage, id, 'application/pdf', { cacheable: true })
		);
		expect(await verifyBlobToken(cid, cct, cexp, csig, null)).toBeNull();
	});
});
