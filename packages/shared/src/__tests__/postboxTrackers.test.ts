import { describe, it, expect } from 'vitest';
import {
	elementTrackingHints,
	isTrackingResource,
	isTrackingPixelTag,
	remoteResourceHost,
	stripRemoteImages,
	type ScanWork,
} from '../postboxTrackers';
import {
	SKIPPED_CONTEXT_FLOODS,
	UNTERMINATED_IMG_FLOOD,
	UNTERMINATED_QUOTE,
	type HostileShape,
} from './postboxTrackersHostileFixtures';

const PIXEL_1X1 = '<img src="https://tracker.example.com/open.gif" width="1" height="1" alt="">';
const HIDDEN_IMG = '<img src="https://tracker.example.net/o.png" style="display:none">';
const PHOTO =
	'<img src="https://cdn.example.com/photo.jpg" width="600" height="400" alt="A photo">';
const KNOWN_HOST = '<img src="https://click.list-manage.com/track/open.php?u=abc" alt="">';

/** Characters read plus steps taken by one metered strip. */
function strippingWork(html: string): number {
	const work: ScanWork = { chars: 0, steps: 0 };
	stripRemoteImages(html, work);
	return work.chars + work.steps;
}

// Each strip round runs two passes (the tokenizer and the first-`>` floor) of
// about two reads per character, and these bodies take two rounds plus the
// foreign-content check: about 4 to 9.3 reads per character as measured. A
// quadratic rescan multiplies that by the unit count (12,500 here).
const MAX_WORK_PER_CHAR = 12;
// Linear work at 4n is 4 times the work at n.
const MAX_GROWTH_AT_4N = 5;

/**
 * The guard for hostile input: count the work instead of timing it, so a
 * loaded runner cannot fail it. The work must be nonzero, bounded per input
 * character at n and 4n, grow about fourfold from n to 4n, and leave the
 * result unchanged next to an unmetered call.
 */
function expectLinearStripping(shape: HostileShape): void {
	const sizes = [shape.n, 4 * shape.n];
	const [small, large] = sizes.map((n) => {
		const html = shape.build(n);
		const work = strippingWork(html);
		expect(work, `${shape.name} at ${n}`).toBeGreaterThan(0);
		expect(work, `${shape.name} at ${n}`).toBeLessThanOrEqual(MAX_WORK_PER_CHAR * html.length);
		return work;
	}) as [number, number];
	expect(large / small, shape.name).toBeLessThan(MAX_GROWTH_AT_4N);
	const html = shape.build(shape.n);
	expect(stripRemoteImages(html, { chars: 0, steps: 0 }), shape.name).toEqual(
		stripRemoteImages(html)
	);
}

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
		expectLinearStripping(UNTERMINATED_IMG_FLOOD);

		const out = stripRemoteImages(UNTERMINATED_IMG_FLOOD.build(50_000));
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
		expectLinearStripping(UNTERMINATED_QUOTE);

		// The first-`>` floor still drops what it reads as a remote image, the
		// truncated tag that opens the quote included.
		const out = stripRemoteImages(UNTERMINATED_QUOTE.build(50_000));
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
		for (const shape of SKIPPED_CONTEXT_FLOODS) expectLinearStripping(shape);
	});

	it('meters every round and the foreign-content pass', () => {
		// Two rounds (the second finds nothing left), then the SVG check reads
		// the whole output, tokenizes it and scans it for `<img` starts. The
		// second round's two passes and the check's three each read the output.
		const html = '<svg></svg><img src="https://cdn.example/a"><p>x</p>';
		const work: ScanWork = { chars: 0, steps: 0 };
		expect(stripRemoteImages(html, work).strippedRemoteImages).toBe(1);
		// Two rounds plus the one tag handed to the replacer in the first.
		expect(work.steps).toBe(3);
		expect(work.chars).toBeGreaterThanOrEqual(5 * '<svg></svg><p>x</p>'.length);
	});

	it('fails soft on non-string input', () => {
		const out = stripRemoteImages(undefined as unknown as string);
		expect(out.strippedRemoteImages).toBe(0);
	});
});
