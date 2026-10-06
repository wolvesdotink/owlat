import { describe, expect, it } from 'vitest';
import { isForwardedPart, referencedContentIds } from '../attachments';

describe('which received parts a forward carries', () => {
	const html = '<p>Hi</p><img src="cid:logo@x"><img src=\'CID:%3Cchart@y%3E\'>';
	const referenced = referencedContentIds(html);

	it('reads the cid references of the body, normalized', () => {
		expect([...referenced].sort()).toEqual(['chart@y', 'logo@x']);
	});

	it('carries plain files and parts marked as attachments, not inline images the body shows', () => {
		expect(isForwardedPart({}, referenced)).toBe(true);
		expect(isForwardedPart({ contentId: '<logo@x>' }, referenced)).toBe(false);
		expect(isForwardedPart({ contentId: '<chart@y>' }, referenced)).toBe(false);
		// A Content-ID the body never shows is a file.
		expect(isForwardedPart({ contentId: '<invoice@z>' }, referenced)).toBe(true);
		// Content-ID plus disposition attachment: a file, even when referenced.
		expect(isForwardedPart({ contentId: '<logo@x>', disposition: 'attachment' }, referenced)).toBe(
			true
		);
	});
});
