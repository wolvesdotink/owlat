/**
 * The pre-send checks engine: the HTML and Blocks in, the list the panel shows
 * out. Asserted through the real English catalog, so a check that names the
 * wrong key, or a key that lost its words, fails here.
 */
import { describe, expect, it } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { DEFAULT_EMAIL_THEME } from '@owlat/shared/emailDefaults';
import { createTestI18n, localizedWith } from '~/__tests__/i18n';
import {
	buildPresendChecks,
	estimateDeliveredBytes,
	scanForPresend,
	summarizePresend,
} from '../checks';
import type { PresendInput } from '../input';
import type { PresendRemote, PresendRemoteResult } from '../remote';
import type { PresendCheck, PresendCheckId } from '../types';

const i18n = createTestI18n();
const words = localizedWith(i18n.global.t);

const ADDRESS = '<p>Owlat GmbH, Hauptstraße 5, 10115 Berlin</p>';

function block(id: string, type: string, content: Record<string, unknown>): EditorBlock {
	return { id, type, content } as unknown as EditorBlock;
}

const text = (id: string, html: string, extra: Record<string, unknown> = {}) =>
	block(id, 'text', { html, blockType: 'paragraph', fontSize: 16, textColor: '#333333', ...extra });

const image = (id: string, src: string, alt = 'A photo') =>
	block(id, 'image', { src, alt, width: 600, align: 'center' });

function doc(body: string): string {
	return `<!doctype html><html><head><style>p{margin:0}</style></head><body>${body}</body></html>`;
}

function done(result: Partial<PresendRemoteResult> = {}): PresendRemote {
	return {
		status: 'done',
		result: {
			links: [],
			images: [],
			screening: {
				status: 'ready',
				verdict: { enabled: true, verdict: 'accept', sizeLimitKb: 500 },
			},
			...result,
		},
	};
}

function run(html: string, overrides: Partial<PresendInput> = {}): PresendCheck[] {
	return buildPresendChecks(
		{
			blocks: [],
			subject: 'What shipped this week',
			theme: DEFAULT_EMAIL_THEME,
			remote: done(),
			...overrides,
		},
		scanForPresend(html)
	);
}

const find = (checks: PresendCheck[], id: PresendCheckId) => {
	const check = checks.find((c) => c.id === id);
	if (!check) throw new Error(`no ${id} check`);
	return check;
};

describe('size (Gmail clipping)', () => {
	it('passes a small email and states the estimate as delivered', () => {
		const check = find(run(doc(`<p>Hello</p>${ADDRESS}`)), 'size');
		expect(check.status).toBe('pass');
		expect(words(check.summary)).toMatch(/^About \d+ KB as delivered, under Gmail's 102 KB/);
	});

	it('warns near the limit and when Gmail will clip', () => {
		const near = find(run(doc(`<p>${'x'.repeat(92 * 1024)}</p>`)), 'size');
		expect(near.status).toBe('warning');
		expect(words(near.summary)).toContain('close to Gmail');

		const clipped = find(run(doc(`<p>${'x'.repeat(110 * 1024)}</p>`)), 'size');
		expect(clipped.status).toBe('warning');
		expect(words(clipped.summary)).toContain('Gmail clips messages above 102 KB');
	});

	it('counts what the send path adds: tracking per link, the footer only for topics', () => {
		const scanned = scanForPresend(doc('<a href="https://example.com/a">a</a>')).html;
		const topic = estimateDeliveredBytes(scanned, 'topic');
		const segment = estimateDeliveredBytes(scanned, 'segment');
		expect(topic).toBeGreaterThan(segment);
		expect(segment).toBeGreaterThan(scanned.bytes + 130);
	});
});

describe('links', () => {
	const html = doc(
		'<a href="https://example.com/ok">ok</a><a href="https://example.com/gone">gone</a>' +
			'<a href="https://example.com/p?u={{contactId}}">personal</a>' +
			'<a href="https://{{domain}}/x">host tag</a>'
	);

	it('waits for the server, then lists the broken ones with "Show me"', () => {
		const blocks = [text('t1', '<p><a href="https://example.com/gone">gone</a></p>')];
		expect(find(run(html, { remote: { status: 'pending' } }), 'links').status).toBe('pending');

		const checks = run(html, {
			blocks,
			remote: done({
				links: [
					{ url: 'https://example.com/ok', status: 'ok', httpStatus: 200 },
					{ url: 'https://example.com/gone', status: 'broken', httpStatus: 404 },
					{ url: 'https://example.com/p?u=', status: 'unverified', httpStatus: 403 },
				],
			}),
		});
		const links = find(checks, 'links');
		expect(links.status).toBe('warning');
		expect(links.items).toEqual([
			{
				label: 'https://example.com/gone',
				reason: expect.anything(),
				blockId: 't1',
			},
		]);
		expect(words(links.items[0]!.reason)).toBe('the site answers 404');
		// The host-tag link is not probed, the refused one is not verified.
		expect(words(links.note!)).toContain('Not verified: 2');
	});

	it('probes a query-string merge tag without the tag, never a host tag', () => {
		const scan = scanForPresend(html);
		expect([...scan.links.probes.keys()]).toEqual([
			'https://example.com/ok',
			'https://example.com/gone',
			'https://example.com/p?u=',
		]);
		expect(scan.links.notProbed).toBe(1);
	});

	it('says so when the server half could not run', () => {
		const links = find(run(html, { remote: { status: 'failed' } }), 'links');
		expect(links.status).toBe('skipped');
		expect(words(links.summary)).toContain('Check again');
	});

	it('flags addresses that cannot work, wherever they are', () => {
		const checks = run(
			doc(
				'<a href="">empty</a><a href="#">hash</a><a href="mailto:not-an-address">mail</a>' +
					'<a href="mailto:hello@example.com">ok mail</a><a href="www.example.com">bare</a>' +
					'<a href="https://example.com/{{firstName">tag</a><a href="tel:+491234">call</a>'
			)
		);
		const syntax = find(checks, 'linkSyntax');
		expect(syntax.status).toBe('warning');
		expect(syntax.items.map((item) => words(item.reason))).toEqual([
			'the link has no address',
			'the link points to “#” and goes nowhere',
			'not a valid email address',
			'not a full web address; start it with https://',
			"a merge tag isn't closed or isn't valid",
		]);
	});
});

describe('images', () => {
	it('finds missing alt text on image Blocks, honouring "decorative"', () => {
		const blocks = [
			image('i1', 'https://cdn.example/a.png', ''),
			block('i2', 'image', {
				src: 'https://cdn.example/b.png',
				alt: '',
				decorative: true,
				width: 600,
			}),
		];
		const html = doc(
			'<img src="https://cdn.example/a.png" alt="" width="600"><img src="https://cdn.example/b.png" alt="" width="600">'
		);
		const alt = find(run(html, { blocks }), 'imageAlt');
		expect(alt.items).toEqual([
			{ label: expect.anything(), reason: expect.anything(), blockId: 'i1' },
		]);
		expect(words(alt.items[0]!.label)).toBe('Image block');
	});

	it('flags an <img> with no alt attribute at all and one without a width', () => {
		const blocks = [block('r1', 'rawHtml', { html: '<img src="https://cdn.example/raw.png">' })];
		const checks = run(doc('<img src="https://cdn.example/raw.png">'), { blocks });
		expect(find(checks, 'imageAlt').items[0]).toMatchObject({ label: 'raw.png', blockId: 'r1' });
		expect(find(checks, 'imageWidth').items[0]).toMatchObject({ label: 'raw.png', blockId: 'r1' });
		expect(
			find(run(doc('<img src="x.png" alt="" style="width:100px">')), 'imageWidth').status
		).toBe('pass');
	});

	it('reports heavy and broken images from the probes', () => {
		const html = doc(
			'<img src="https://cdn.example/hero.jpg" alt="Hero" width="600"><img src="https://cdn.example/x.png" alt="X" width="10">'
		);
		const check = find(
			run(html, {
				remote: done({
					images: [
						{ url: 'https://cdn.example/hero.jpg', status: 'ok', bytes: 2.4 * 1024 * 1024 },
						{ url: 'https://cdn.example/x.png', status: 'broken', httpStatus: 404 },
					],
				}),
			}),
			'imageLoad'
		);
		expect(check.items.map((item) => `${words(item.label)}: ${words(item.reason)}`)).toEqual([
			'hero.jpg: 2.4 MB, keep images under 1.0 MB',
			'x.png: the site answers 404',
		]);
	});
});

describe('contrast', () => {
	it('measures text against the nearest background in light mode', () => {
		const blocks = [
			block('c1', 'container', {
				backgroundColor: '#ffffff',
				items: [text('t1', '<p>pale</p>', { textColor: '#dddddd' })],
			}),
			text('t2', '<p>fine</p>'),
			block('b1', 'button', {
				text: 'Buy',
				url: 'https://example.com',
				backgroundColor: '#ffcc00',
				textColor: '#ffffff',
			}),
			block('b2', 'button', {
				text: 'Go',
				url: 'https://example.com',
				backgroundColor: '#1d4ed8',
				textColor: '#ffffff',
			}),
		];
		const light = find(run(doc(ADDRESS), { blocks }), 'contrastLight');
		expect(light.items.map((item) => item.blockId)).toEqual(['t1', 'b1']);
		expect(light.items[0]).toMatchObject({ label: '#dddddd / #ffffff', blockId: 't1' });
		expect(words(light.items[0]!.reason)).toBe('contrast 1.3:1, needs 4.5:1');
	});

	it('catches light text on a light fill without a dark-mode background', () => {
		const blocks = [
			block('c1', 'container', { backgroundColor: '#ffffff', items: [text('t1', '<p>a</p>')] }),
			block('c2', 'container', {
				backgroundColor: '#ffffff',
				darkBackgroundColor: '#1f1f1f',
				items: [text('t2', '<p>b</p>')],
			}),
		];
		const dark = find(run(doc(ADDRESS), { blocks }), 'contrastDark');
		expect(dark.items.map((item) => item.blockId)).toEqual(['t1']);
	});

	it("checks the theme's own dark-mode colours", () => {
		const dark = find(
			run(doc(ADDRESS), {
				theme: { ...DEFAULT_EMAIL_THEME, darkModeTextColor: '#333333' },
			}),
			'contrastDark'
		);
		expect(dark.items[0]).toMatchObject({ label: '#333333 / #121212' });
		expect(dark.items[0]!.blockId).toBeUndefined();
	});
});

describe('content screening', () => {
	it('passes with the spam score, and is skipped where it cannot run', () => {
		const scored = done({
			screening: {
				status: 'ready',
				verdict: {
					enabled: true,
					verdict: 'accept',
					sizeLimitKb: 500,
					spam: { score: 2.04, threshold: 15 },
				},
			},
		});
		expect(words(find(run(doc(ADDRESS), { remote: scored }), 'screening').summary)).toBe(
			'Accepted by content screening. Spam score 2.0 (rejected at 15).'
		);
		const off = done({
			screening: {
				status: 'ready',
				verdict: { enabled: false, verdict: 'accept', sizeLimitKb: 500 },
			},
		});
		expect(find(run(doc(ADDRESS), { remote: off }), 'screening').status).toBe('skipped');
		const none = done({ screening: { status: 'unavailable' } });
		expect(find(run(doc(ADDRESS), { remote: none }), 'screening').status).toBe('skipped');
	});

	it('says an email too large to screen is too large, not that the server is missing', () => {
		const big = find(
			run(doc(ADDRESS), { remote: done({ screening: { status: 'too_large' } }) }),
			'screening'
		);
		expect(big.status).toBe('skipped');
		expect(words(big.summary)).toBe('This email is too large for the content screening to check.');
	});

	it('warns, never blocks, on a rejection, pointing at the blocked link', () => {
		const html = doc(`<a href="https://bad.example/offer">Offer</a>${ADDRESS}`);
		const blocks = [text('t1', '<p><a href="https://bad.example/offer">Offer</a></p>')];
		const check = find(
			run(html, {
				blocks,
				remote: done({
					screening: {
						status: 'ready',
						verdict: {
							enabled: true,
							verdict: 'reject',
							reason: 'blocked_url',
							blockedPattern: 'bad.example',
							sizeLimitKb: 500,
						},
					},
				}),
			}),
			'screening'
		);
		expect(check.status).toBe('warning');
		expect(check.items[0]).toMatchObject({ label: 'https://bad.example/offer', blockId: 't1' });
	});
});

describe('subject, unsubscribe and postal address', () => {
	it('flags a long or shouting subject', () => {
		const long = find(run(doc(ADDRESS), { subject: 'a'.repeat(80) }), 'subject');
		expect(words(long.items[0]!.reason)).toBe('80 characters; Gmail shows about 70');
		expect(find(run(doc(ADDRESS), { subject: 'HUGE SALE NOW' }), 'subject').status).toBe('warning');
		expect(find(run(doc(ADDRESS), { subject: 'Hello there' }), 'subject').status).toBe('pass');
	});

	it('needs an own unsubscribe link only for a segment campaign', () => {
		expect(find(run(doc(ADDRESS), { audienceKind: 'topic' }), 'unsubscribe').status).toBe('pass');
		expect(find(run(doc(ADDRESS), { audienceKind: 'segment' }), 'unsubscribe').status).toBe(
			'warning'
		);
		const own = doc(`<a href="https://example.com/u">Unsubscribe</a>${ADDRESS}`);
		expect(find(run(own, { audienceKind: 'segment' }), 'unsubscribe').status).toBe('pass');
	});

	it('looks for a postal address and does not mistake a copyright year for one', () => {
		expect(find(run(doc(ADDRESS)), 'postalAddress').status).toBe('pass');
		expect(
			find(run(doc('<p>500 Fifth Avenue, New York, NY 10110</p>')), 'postalAddress').status
		).toBe('pass');
		expect(find(run(doc('<p>© 2026 Acme. All rights reserved.</p>')), 'postalAddress').status).toBe(
			'warning'
		);
	});
});

describe('sending and the summary', () => {
	it('shows the refusal the send already makes as the one blocking item', () => {
		const blocked = find(run(doc(ADDRESS), { blockedReason: 'Domain not verified' }), 'sending');
		expect(blocked).toMatchObject({ status: 'blocking', summary: 'Domain not verified' });
		expect(find(run(doc(ADDRESS), { blockedReason: null }), 'sending').status).toBe('pass');
		expect(run(doc(ADDRESS)).some((check) => check.id === 'sending')).toBe(false);
	});

	it('changes its signature with the warnings, so a review goes stale', () => {
		const a = summarizePresend(run(doc('<p>no address</p>')));
		const b = summarizePresend(run(doc('<p>no address</p><a href="#">x</a>')));
		expect(a.warnings).toBe(1);
		expect(b.warnings).toBe(2);
		expect(a.signature).not.toBe(b.signature);
		expect(summarizePresend(run(doc('<p>no address</p>'))).signature).toBe(a.signature);
	});

	it('un-reviews a warning that got worse, but not one whose number moved', () => {
		const signature = (kb: number) =>
			summarizePresend(run(doc(`<p>${'x'.repeat(kb * 1024)}</p>${ADDRESS}`))).signature;
		expect(signature(92)).toBe(signature(93));
		expect(signature(110)).not.toBe(signature(92));
	});
});
