import { describe, it, expect } from 'vitest';
import {
	detectTrackers,
	stripTrackerPixels,
	isTrackingPixelTag,
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
