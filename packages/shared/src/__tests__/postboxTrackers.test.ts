import { describe, it, expect } from 'vitest';
import {
	detectTrackers,
	stripTrackerPixels,
	stripRemoteImages,
	isTrackingPixelTag,
	trackerPixelLabel,
} from '../postboxTrackers';

const PIXEL_1X1 = '<img src="https://tracker.example.com/open.gif" width="1" height="1" alt="">';
const HIDDEN_IMG = '<img src="https://tracker.example.net/o.png" style="display:none">';
const PHOTO = '<img src="https://cdn.example.com/photo.jpg" width="600" height="400" alt="A photo">';
const KNOWN_HOST = '<img src="https://click.list-manage.com/track/open.php?u=abc" alt="">';

describe('detectTrackers', () => {
	it('counts a 1x1 pixel', () => {
		const result = detectTrackers(`<p>Hello</p>${PIXEL_1X1}`);
		expect(result.pixelCount).toBe(1);
		expect(result.trackerHosts).toEqual(['tracker.example.com']);
	});

	it('counts a zero-size pixel declared via inline style', () => {
		const html = '<img src="https://t.example.org/p.gif" style="width:0;height:0">';
		expect(detectTrackers(html).pixelCount).toBe(1);
	});

	it('counts a display:none image', () => {
		const result = detectTrackers(HIDDEN_IMG);
		expect(result.pixelCount).toBe(1);
		expect(result.trackerHosts).toEqual(['tracker.example.net']);
	});

	it('does not count a regular photo', () => {
		const result = detectTrackers(PHOTO);
		expect(result.pixelCount).toBe(0);
		expect(result.trackerHosts).toEqual([]);
	});

	it('lists the host of a known tracker even at full size', () => {
		const result = detectTrackers(`${KNOWN_HOST}${PHOTO}`);
		expect(result.pixelCount).toBe(1);
		expect(result.trackerHosts).toEqual(['click.list-manage.com']);
	});

	it('does not flag an unrelated host that merely contains a pattern substring', () => {
		// evil-list-manage.com is NOT a subdomain of list-manage.com
		const html = '<img src="https://evil-list-manage.com/logo.png" width="200" height="80">';
		expect(detectTrackers(html).pixelCount).toBe(0);
	});

	it('never flags data:/cid: images (no network fetch, cannot track)', () => {
		const html =
			'<img src="data:image/gif;base64,R0lGOD" width="1" height="1">' +
			'<img src="cid:inline-part" width="1" height="1">';
		expect(detectTrackers(html).pixelCount).toBe(0);
	});

	it('dedupes and sorts tracker hosts across multiple pixels', () => {
		const html = `${PIXEL_1X1}${PIXEL_1X1}${HIDDEN_IMG}`;
		const result = detectTrackers(html);
		expect(result.pixelCount).toBe(3);
		expect(result.trackerHosts).toEqual(['tracker.example.com', 'tracker.example.net']);
	});

	it('fails soft on non-string input', () => {
		// Simulates an unexpected caller bug — must not throw.
		const result = detectTrackers(undefined as unknown as string);
		expect(result).toEqual({ pixelCount: 0, trackerHosts: [] });
	});
});

describe('stripTrackerPixels ("show images" keeps pixels stripped)', () => {
	it('removes tracking pixels but keeps real images', () => {
		const html = `<p>Hi</p>${PIXEL_1X1}${PHOTO}${HIDDEN_IMG}${KNOWN_HOST}`;
		const stripped = stripTrackerPixels(html);
		expect(stripped).toContain('photo.jpg');
		expect(stripped).not.toContain('tracker.example.com');
		expect(stripped).not.toContain('tracker.example.net');
		expect(stripped).not.toContain('list-manage.com');
		expect(stripped).toContain('<p>Hi</p>');
	});

	it('returns tracker-free HTML unchanged', () => {
		const html = `<p>Hello</p>${PHOTO}`;
		expect(stripTrackerPixels(html)).toBe(html);
	});

	it('fails soft on non-string input', () => {
		expect(() => stripTrackerPixels(undefined as unknown as string)).not.toThrow();
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

describe('trackerPixelLabel', () => {
	it('pluralizes the shared banner/badge copy', () => {
		expect(trackerPixelLabel(1)).toBe('1 tracking pixel');
		expect(trackerPixelLabel(3)).toBe('3 tracking pixels');
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
