import { describe, expect, it } from 'vitest';
import { discoverSenderLogo, type SenderLogoDeps } from '../senderLogos/discover';

const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type Served = { body: BodyInit; type: string; status?: number; url?: string };

/**
 * DNS and HTTP from tables. Records every URL asked for, so a test can say
 * what was NOT fetched. A response's `url` is where the redirects ended.
 */
function fakeDeps(txt: Record<string, string[]>, pages: Record<string, Served>) {
	const fetched: string[] = [];
	const deps: SenderLogoDeps = {
		async resolveTxt(name) {
			const records = txt[name];
			if (!records) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
			return records.map((record) => [record]);
		},
		async fetch(url) {
			fetched.push(url);
			const served = pages[url];
			if (!served) return new Response('missing', { status: 404 });
			const response = new Response(served.body, {
				status: served.status ?? 200,
				headers: { 'content-type': served.type },
			});
			Object.defineProperty(response, 'url', { value: served.url ?? url });
			return response;
		},
	};
	return { deps, fetched };
}

const ENFORCING = { '_dmarc.acme-bank.com': ['v=DMARC1; p=reject'] };
const BIMI = { 'default._bimi.acme-bank.com': ['v=BIMI1; l=https://cdn.acme-bank.com/bimi.svg'] };
const HOME = 'https://acme-bank.com/';

describe('discoverSenderLogo', () => {
	it('takes the BIMI logo of a domain that enforces DMARC', async () => {
		const { deps } = fakeDeps(
			{ ...ENFORCING, ...BIMI },
			{ 'https://cdn.acme-bank.com/bimi.svg': { body: SVG, type: 'image/svg+xml' } }
		);
		const found = await discoverSenderLogo('acme-bank.com', deps);
		expect(found).toMatchObject({ source: 'bimi', mimeType: 'image/svg+xml' });
	});

	it('ignores BIMI at p=none and falls back to the site icon', async () => {
		const { deps, fetched } = fakeDeps(
			{ '_dmarc.acme-bank.com': ['v=DMARC1; p=none'], ...BIMI },
			{
				[HOME]: {
					body: '<html><head><link rel="apple-touch-icon" href="/touch.png"></head></html>',
					type: 'text/html; charset=utf-8',
				},
				'https://acme-bank.com/touch.png': { body: PNG, type: 'image/png' },
			}
		);
		const found = await discoverSenderLogo('acme-bank.com', deps);
		expect(found).toMatchObject({ source: 'icon', mimeType: 'image/png' });
		expect(fetched).not.toContain('https://cdn.acme-bank.com/bimi.svg');
	});

	it('falls back to /favicon.ico when the page declares no icon', async () => {
		const { deps } = fakeDeps(
			{},
			{
				[HOME]: { body: '<html><head></head></html>', type: 'text/html' },
				'https://acme-bank.com/favicon.ico': {
					body: new Uint8Array([0, 0, 1, 0, 1, 0]),
					type: 'image/x-icon',
				},
			}
		);
		expect(await discoverSenderLogo('acme-bank.com', deps)).toMatchObject({
			source: 'icon',
			mimeType: 'image/x-icon',
		});
	});

	it('still tries /favicon.ico after every declared icon failed', async () => {
		const { deps } = fakeDeps(
			{},
			{
				[HOME]: {
					body:
						'<link rel="apple-touch-icon" href="/a.png"><link rel="icon" href="/b.png">' +
						'<link rel="icon" href="/c.png">',
					type: 'text/html',
				},
				'https://acme-bank.com/favicon.ico': {
					body: new Uint8Array([0, 0, 1, 0, 1, 0]),
					type: 'image/x-icon',
				},
			}
		);
		expect(await discoverSenderLogo('acme-bank.com', deps)).toMatchObject({
			mimeType: 'image/x-icon',
		});
	});

	it('does not use the icons of a site the homepage redirects away to', async () => {
		const { deps, fetched } = fakeDeps(
			{},
			{
				[HOME]: {
					body: '<link rel="icon" href="https://parked.example.net/icon.png">',
					type: 'text/html',
					url: 'https://parked.example.net/',
				},
			}
		);
		await discoverSenderLogo('acme-bank.com', deps);
		expect(fetched).not.toContain('https://parked.example.net/icon.png');
	});

	it('refuses an image whose bytes are not what it claims', async () => {
		const { deps } = fakeDeps(
			{ ...ENFORCING, ...BIMI },
			{
				'https://cdn.acme-bank.com/bimi.svg': {
					body: SVG.replace('<rect', '<script>alert(1)</script><rect'),
					type: 'image/svg+xml',
				},
				[HOME]: { body: '<link rel="icon" href="/i.png">', type: 'text/html' },
				'https://acme-bank.com/i.png': { body: '<html>not an image</html>', type: 'image/png' },
			}
		);
		expect(await discoverSenderLogo('acme-bank.com', deps)).toBeNull();
	});

	it('refuses an icon past the size cap', async () => {
		const huge = new Uint8Array(200 * 1024);
		huge.set(PNG);
		const { deps } = fakeDeps(
			{},
			{
				[HOME]: { body: '<link rel="icon" href="/big.png">', type: 'text/html' },
				'https://acme-bank.com/big.png': { body: huge, type: 'image/png' },
			}
		);
		expect(await discoverSenderLogo('acme-bank.com', deps)).toBeNull();
	});

	it('answers null when every request fails', async () => {
		const deps: SenderLogoDeps = {
			resolveTxt: () => Promise.reject(new Error('SERVFAIL')),
			fetch: () => Promise.reject(new Error('blocked')),
		};
		expect(await discoverSenderLogo('acme-bank.com', deps)).toBeNull();
	});
});
