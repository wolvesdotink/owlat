import { describe, it, expect } from 'vitest';
import {
	isTrackingResource,
	isTrackingPixelTag,
	remoteResourceHost,
	stripRemoteImages,
} from '../postboxTrackers';

const PIXEL_1X1 = '<img src="https://tracker.example.com/open.gif" width="1" height="1" alt="">';
const HIDDEN_IMG = '<img src="https://tracker.example.net/o.png" style="display:none">';
const PHOTO =
	'<img src="https://cdn.example.com/photo.jpg" width="600" height="400" alt="A photo">';
const KNOWN_HOST = '<img src="https://click.list-manage.com/track/open.php?u=abc" alt="">';

describe('isTrackingResource', () => {
	const NO_HINTS = { width: null, height: null, style: '' };

	it('flags a 1x1 resource and names its host', () => {
		expect(isTrackingPixelTag(PIXEL_1X1)).toBe(true);
		expect(remoteResourceHost('https://tracker.example.com/open.gif')).toBe('tracker.example.com');
	});

	it('flags a zero-size element declared via inline style', () => {
		expect(
			isTrackingResource('https://t.example.org/p.gif', {
				...NO_HINTS,
				style: 'width:0;height:0',
			})
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
		const pixel = { width: '1', height: '1', style: '' };
		expect(isTrackingResource('data:image/gif;base64,R0lGOD', pixel)).toBe(false);
		expect(isTrackingResource('cid:inline-part', pixel)).toBe(false);
	});

	it('classifies a CSS background by the element it sits on', () => {
		const url = 'https://t.example.org/bg.gif';
		expect(isTrackingResource(url, { width: '1', height: '1', style: '' })).toBe(true);
		expect(isTrackingResource(url, { width: '600', height: null, style: '' })).toBe(false);
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

	it('fails soft on non-string input', () => {
		const out = stripRemoteImages(undefined as unknown as string);
		expect(out.strippedRemoteImages).toBe(0);
	});
});
