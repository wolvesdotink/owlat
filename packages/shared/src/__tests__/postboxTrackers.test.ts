import { describe, it, expect } from 'vitest';
import {
	elementTrackingHints,
	isTrackingResource,
	isTrackingPixelTag,
	remoteResourceHost,
	stripRemoteImages,
} from '../postboxTrackers';

/**
 * How much longer 4n units of hostile input take than n: per call, the
 * fastest of three samples each, after a warm-up. A sample repeats the call
 * for at least 10 ms so a cheap input is not timed at the clock's resolution.
 * Linear code measures about 4, quadratic about 16. A ratio rather than a
 * wall-clock budget, which a busy CI runner misses.
 */
function scalingRatio(build: (n: number) => string, n: number, run: (input: string) => unknown) {
	const perCall = (input: string) => {
		const started = performance.now();
		let calls = 0;
		do {
			run(input);
			calls++;
		} while (performance.now() - started < 10);
		return (performance.now() - started) / calls;
	};
	const fastest = (input: string) => Math.min(perCall(input), perCall(input), perCall(input));
	const small = build(n);
	const large = build(4 * n);
	fastest(small); // warm-up: JIT
	return fastest(large) / fastest(small);
}

/** Linear stays near 4x; the quadratic tag regex this guards measures far higher. */
const LINEAR_RATIO = 8;

const PIXEL_1X1 = '<img src="https://tracker.example.com/open.gif" width="1" height="1" alt="">';
const HIDDEN_IMG = '<img src="https://tracker.example.net/o.png" style="display:none">';
const PHOTO =
	'<img src="https://cdn.example.com/photo.jpg" width="600" height="400" alt="A photo">';
const KNOWN_HOST = '<img src="https://click.list-manage.com/track/open.php?u=abc" alt="">';

describe('isTrackingResource', () => {
	const NO_HINTS = elementTrackingHints({ width: null, height: null, style: '' });

	it('flags a 1x1 resource and names its host', () => {
		expect(isTrackingPixelTag(PIXEL_1X1)).toBe(true);
		expect(remoteResourceHost('https://tracker.example.com/open.gif')).toBe('tracker.example.com');
	});

	it('flags a zero-size element declared via inline style', () => {
		expect(
			isTrackingResource(
				'https://t.example.org/p.gif',
				elementTrackingHints({ width: null, height: null, style: 'width:0;height:0' })
			)
		).toBe(true);
	});

	it('flags a display:none element', () => {
		expect(isTrackingPixelTag(HIDDEN_IMG)).toBe(true);
	});

	it('does not flag a regular photo', () => {
		expect(isTrackingPixelTag(PHOTO)).toBe(false);
	});

	it('flags a known tracker host even at full size', () => {
		expect(isTrackingPixelTag(KNOWN_HOST)).toBe(true);
	});

	it('does not flag an unrelated host that merely contains a pattern substring', () => {
		// evil-list-manage.com is NOT a subdomain of list-manage.com
		const html = '<img src="https://evil-list-manage.com/logo.png" width="200" height="80">';
		expect(isTrackingPixelTag(html)).toBe(false);
	});

	it('never flags data:/cid: resources (no network fetch, cannot track)', () => {
		const pixel = elementTrackingHints({ width: '1', height: '1', style: '' });
		expect(isTrackingResource('data:image/gif;base64,R0lGOD', pixel)).toBe(false);
		expect(isTrackingResource('cid:inline-part', pixel)).toBe(false);
	});

	it('reads a URL the way the browser parser does (tabs, newlines, controls)', () => {
		const tracker = 'click.list-manage.com';
		for (const url of [
			`https:\t//${tracker}/open.gif`,
			`https:/\n/${tracker}/open.gif`,
			`\u0001\u001f https://${tracker}/open.gif\r\n`,
			`https://click.list-\tmanage.com/open.gif`,
		]) {
			expect(remoteResourceHost(url)).toBe(tracker);
			expect(isTrackingResource(url, NO_HINTS)).toBe(true);
		}
	});

	it('decodes character references in a tag string before classifying', () => {
		expect(isTrackingPixelTag('<img src="https:&#9;//click.list-manage.com/open.gif">')).toBe(true);
		expect(isTrackingPixelTag('<img src="https&colon;&Tab;//click.list-manage.com/o">')).toBe(true);
	});

	it('reads a reference named after an Object.prototype member as text', () => {
		// `&constructor;` is no named reference: it reads as its own text, the
		// same as the escaped `&amp;constructor;`.
		const size = 'width="600" height="400"';
		expect(isTrackingPixelTag(`<img src="https://cdn.example&constructor;/a" ${size}>`)).toBe(
			isTrackingPixelTag(`<img src="https://cdn.example&amp;constructor;/a" ${size}>`)
		);
	});

	it('matches a tracker host written with a trailing root dot', () => {
		const url = 'https://click.list-manage.com./open.gif';
		expect(remoteResourceHost(url)).toBe('click.list-manage.com');
		expect(
			isTrackingResource(url, elementTrackingHints({ width: '600', height: '200', style: '' }))
		).toBe(true);
		expect(remoteResourceHost('https://CDN.Example.COM./a.png')).toBe('cdn.example.com');
	});

	it('treats a remote reference it cannot read as a tracker', () => {
		expect(isTrackingResource('open.gif', NO_HINTS)).toBe(true);
		expect(isTrackingResource('ftp://files.example/a.gif', NO_HINTS)).toBe(true);
		expect(remoteResourceHost('open.gif')).toBeNull();
	});

	it('classifies a CSS background by the element it sits on', () => {
		const url = 'https://t.example.org/bg.gif';
		expect(
			isTrackingResource(url, elementTrackingHints({ width: '1', height: '1', style: '' }))
		).toBe(true);
		expect(
			isTrackingResource(url, elementTrackingHints({ width: '600', height: null, style: '' }))
		).toBe(false);
		expect(isTrackingResource(url, NO_HINTS)).toBe(false);
	});
});

describe('isTrackingPixelTag', () => {
	it('requires both declared dimensions to be pixel-sized when one is large', () => {
		// A 1px-wide by 400px-tall spacer/border image is not a tracking pixel.
		expect(
			isTrackingPixelTag('<img src="https://cdn.example.com/border.gif" width="1" height="400">')
		).toBe(false);
	});

	it('flags a bare 1px width with no other dimension', () => {
		expect(isTrackingPixelTag('<img src="https://x.example.com/p" width="1">')).toBe(true);
	});
});

describe('stripRemoteImages', () => {
	const INLINE_DATA = '<img src="data:image/png;base64,iVBOR" alt="inline">';
	const INLINE_CID = '<img src="cid:logo@corp" alt="logo">';

	it('strips a 1x1 remote tracking pixel', () => {
		const out = stripRemoteImages(`<p>Hi</p>${PIXEL_1X1}`);
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).not.toContain('<img');
		expect(out.html).toContain('<p>Hi</p>');
	});

	it('strips a display:none hidden remote pixel', () => {
		const out = stripRemoteImages(`<div>Body${HIDDEN_IMG}</div>`);
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).not.toContain('tracker.example.net');
	});

	it('strips a known-tracker-host image', () => {
		const out = stripRemoteImages(KNOWN_HOST);
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).toBe('');
	});

	it('strips a full-size remote photo (all remote images, not only pixels)', () => {
		const out = stripRemoteImages(PHOTO);
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).toBe('');
	});

	it('strips a remote image whose src hides its scheme behind a tab', () => {
		const out = stripRemoteImages('<img src="https:&#9;//evil.example/beacon.gif"><p>x</p>');
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).toBe('<p>x</p>');
	});

	it('strips a protocol-relative remote image', () => {
		const out = stripRemoteImages('<img src="//evil.example/beacon.gif">');
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).toBe('');
	});

	it('leaves inline data:/cid: images and text content untouched', () => {
		const html = `<p>Hello there</p>${INLINE_DATA}${INLINE_CID}`;
		const out = stripRemoteImages(html);
		expect(out.strippedRemoteImages).toBe(0);
		expect(out.html).toBe(html);
	});

	it('strips remote images but keeps inline ones in a mixed body', () => {
		const out = stripRemoteImages(`${INLINE_CID}${PIXEL_1X1}<p>x</p>`);
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).toContain('cid:logo@corp');
		expect(out.html).not.toContain('tracker.example.com');
	});

	it('stays linear on a flood of unterminated <img tags', () => {
		// No `>` anywhere: `<img\b[^>]*>` retried every start to the end.
		const flood = (n: number) => `<img src="https://evil.example/p.gif">${'<img src=x '.repeat(n)}`;
		expect(scalingRatio(flood, 12_500, stripRemoteImages)).toBeLessThan(LINEAR_RATIO);

		const out = stripRemoteImages(flood(50_000));
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).toBe('<img src=x '.repeat(50_000));
	});

	it('strips a remote image with `>` inside a quoted attribute value', () => {
		for (const tag of [
			'<img alt=">" src="https://cdn.example/a">',
			"<img alt='>' src='https://cdn.example/a'>",
			'<img src="https://cdn.example/a" alt="a > b">',
			"<img src='https://cdn.example/a' alt='a > b'>",
		]) {
			const out = stripRemoteImages(`<p>before</p>${tag}<p>after</p>${INLINE_CID}`);
			expect(out.strippedRemoteImages, tag).toBe(1);
			expect(out.html, tag).toBe(`<p>before</p><p>after</p>${INLINE_CID}`);
		}
	});

	it('keeps an inline image whose quoted attribute holds a `>`', () => {
		const html = '<img alt="1 > 0" src="cid:chart@corp"><p>x</p>';
		const out = stripRemoteImages(html);
		expect(out.strippedRemoteImages).toBe(0);
		expect(out.html).toBe(html);
	});

	it('does not treat an apostrophe inside an unquoted value or a name as a quote', () => {
		const out = stripRemoteImages(
			"<img alt=it's src=https://cdn.example/a><p>x</p><img data-o'k src=//cdn.example/b><p>y</p>"
		);
		expect(out.strippedRemoteImages).toBe(2);
		expect(out.html).toBe('<p>x</p><p>y</p>');
	});

	it('reads src as the browser does, not from inside another attribute', () => {
		for (const tag of [
			'<img alt=\'>src="cid:logo@corp"\' src="https://cdn.example/a">',
			'<img data-src="cid:logo@corp" src="https://cdn.example/a">',
			'<img src = "https://cdn.example/a" src="cid:logo@corp">',
		]) {
			const out = stripRemoteImages(`${tag}<p>x</p>`);
			expect(out.strippedRemoteImages, tag).toBe(1);
			expect(out.html, tag).toBe('<p>x</p>');
		}
		const inline = '<img alt="src=https://cdn.example/a" src="cid:logo@corp">';
		expect(stripRemoteImages(inline)).toEqual({ html: inline, strippedRemoteImages: 0 });
		expect(isTrackingPixelTag('<img alt="1>0" src="https://cdn.example/p.gif" width="1">')).toBe(
			true
		);
	});

	it('reads an unterminated quote to the end once and stays linear over it', () => {
		// The open quote swallows the rest of the input, so none of the later
		// `<img` starts is a tag to the browser; rescanning quote-aware from each
		// would be quadratic. The first-`>` floor still drops what it reads as a
		// remote image, the truncated tag that opens the quote included.
		const flood = (n: number) =>
			`<img src="https://evil.example/p.gif"><p>x</p><img alt="open ${'<img src=https://evil.example/q.gif>'.repeat(n)}`;
		expect(scalingRatio(flood, 12_500, stripRemoteImages)).toBeLessThan(LINEAR_RATIO);

		const out = stripRemoteImages(flood(50_000));
		expect(out.strippedRemoteImages).toBe(50_001);
		expect(out.html).toBe('<p>x</p>');
	});

	it('re-reads its output when a removal joins the text around it into a tag', () => {
		const joined = '<<img src="https://cdn.example/a">img src="https://cdn.example/b"><p>x</p>';
		expect(stripRemoteImages(joined)).toEqual({ html: '<p>x</p>', strippedRemoteImages: 2 });

		// Nesting deeper than the rounds go: every `<img` left becomes text.
		const deep = `${'<'.repeat(12)}${'img src=https://cdn.example/a>'.repeat(13)}`;
		const out = stripRemoteImages(deep);
		expect(out.strippedRemoteImages).toBeGreaterThan(0);
		expect(out.html).not.toMatch(/<img/i);
		expect(out.html).toContain('&lt;img');
	});

	it('does not read an `<img` inside a comment or another tag as a tag', () => {
		const real = '<img alt=">" src="https://cdn.example/a">';
		for (const before of [
			'<!-- <img alt=" -->',
			'<!-- <img alt=" --!>',
			'<!-->',
			'<!--->',
			'<a title="<img alt=\'">',
			"<p data-x='<img alt=\"' >",
			'</p title="<img alt=\'">',
			'<!DOCTYPE x "<img alt=\'">',
			'<?php <img alt=" ?>',
			'</ <img alt=" >',
		]) {
			const out = stripRemoteImages(`${before} ${real}<p>x</p>`);
			expect(out.strippedRemoteImages, before).toBe(1);
			expect(out.html, before).toBe(`${before} <p>x</p>`);
		}
	});

	it('does not read an `<img` inside raw-text content as a tag', () => {
		const real = '<img alt=">" src="https://cdn.example/a">';
		for (const element of [
			'<style>p[title="<img alt=\'"] { color: red }</style>',
			'<STYLE>a::after { content: "<img alt=\'" }</Style >',
			'<title><img alt="</title>',
			"<textarea><img alt='</textarea>",
			'<script>var s = "<img alt=\'";</script>',
		]) {
			const out = stripRemoteImages(`${element}${real}<p>x</p>`);
			expect(out.strippedRemoteImages, element).toBe(1);
			expect(out.html, element).toBe(`${element}<p>x</p>`);
		}
	});

	it('reads a tag named after an Object.prototype member as an ordinary tag', () => {
		const img = '<img src=https://cdn.example/a>';
		expect(stripRemoteImages(`<constructor>${img}<p>x</p>`)).toEqual({
			html: '<constructor><p>x</p>',
			strippedRemoteImages: 1,
		});
		expect(stripRemoteImages(`${img}<p>x</p><Constructor>`)).toEqual({
			html: '<p>x</p><Constructor>',
			strippedRemoteImages: 1,
		});
	});

	it('still drops what the first-`>` scan sees where the tokenizer model stops', () => {
		// Outlook renders the content of a conditional comment.
		const conditional = '<!--[if mso]><img src="https://cdn.example/a"><![endif]-->';
		expect(stripRemoteImages(conditional)).toEqual({
			html: '<!--[if mso]><![endif]-->',
			strippedRemoteImages: 1,
		});
		// In SVG a CDATA section runs to `]]>`, not to its first `>`.
		const cdata =
			'<svg><![CDATA[ a > b <img alt=" ]]></svg><img src="https://cdn.example/a" alt="y"><p>x</p>';
		const out = stripRemoteImages(cdata);
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).not.toContain('cdn.example');
	});

	it('turns an `<img` it does not read as a tag into text when SVG or MathML is present', () => {
		// Removing the breakout `<img>` leaves the `<title>` inside MathML,
		// where it holds markup, so the `<img` in it would become a tag.
		const html =
			'<math><img src="https://cdn.example/c"><title><img alt=">" src="https://cdn.example/b">';
		expect(stripRemoteImages(html)).toEqual({
			html: '<math><title>&lt;img alt=">" src="https://cdn.example/b">',
			strippedRemoteImages: 1,
		});
		// A tag it does read keeps its form, and without SVG/MathML nothing changes.
		const inline = `<svg viewBox="0 0 1 1"></svg>${INLINE_CID}<!-- <img alt="x"> -->`;
		expect(stripRemoteImages(inline).html).toBe(
			`<svg viewBox="0 0 1 1"></svg>${INLINE_CID}<!-- &lt;img alt="x"> -->`
		);
		const plain = `${INLINE_CID}<!-- <img alt="x"> -->`;
		expect(stripRemoteImages(plain).html).toBe(plain);
	});

	it('stays linear over floods of comments and raw-text elements', () => {
		for (const unit of [
			'<!-- <img alt=" -->',
			'<style><img alt="</style>',
			'<!--x--x-',
			'<title>',
		]) {
			const flood = (n: number) => `${unit.repeat(n)}<img src="https://cdn.example/a">`;
			expect(scalingRatio(flood, 12_500, stripRemoteImages), unit).toBeLessThan(LINEAR_RATIO);
		}
	});

	it('fails soft on non-string input', () => {
		const out = stripRemoteImages(undefined as unknown as string);
		expect(out.strippedRemoteImages).toBe(0);
	});
});
