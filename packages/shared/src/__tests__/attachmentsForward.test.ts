import { describe, expect, it } from 'vitest';
import { inlineImageContentIds, isForwardedPart } from '../attachments';

describe('which received parts a forward carries, from the row alone', () => {
	const html =
		'<p>Hi, the <a href="cid:invoice@example.com">invoice</a>.</p>' +
		'<img alt="logo" src="cid:logo@x"><IMG SRC=\'CID:%3Cchart@y%3E\'>';
	const inline = inlineImageContentIds(html);

	it('reads only the images the body shows, not cid links', () => {
		expect([...inline].sort()).toEqual(['chart@y', 'logo@x']);
	});

	it('carries everything except an image the body shows inline', () => {
		const pdf = { contentType: 'application/pdf', contentId: '<invoice@example.com>' };
		expect(isForwardedPart(pdf, inline)).toBe(true);
		expect(isForwardedPart({ contentType: 'application/pdf' }, inline)).toBe(true);
		expect(isForwardedPart({ contentType: 'image/png', contentId: '<logo@x>' }, inline)).toBe(
			false
		);
		// An image with a Content-ID the body never shows is a file.
		expect(isForwardedPart({ contentType: 'image/png', contentId: '<scan@z>' }, inline)).toBe(true);
	});

	it('does not stall on a body full of unclosed tags', () => {
		expect(inlineImageContentIds('<img'.repeat(50_000)).size).toBe(0);
	});
});
