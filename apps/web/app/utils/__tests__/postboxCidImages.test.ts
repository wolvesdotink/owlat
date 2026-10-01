import { describe, it, expect } from 'vitest';
import {
	MAX_CID_IMAGE_BYTES,
	cidReferences,
	inlineImageParts,
	normalizeContentId,
	resolveCidImages,
	type CidAttachment,
} from '../postboxCidImages';

const logo: CidAttachment = {
	filename: 'logo.png',
	contentType: 'image/png',
	size: 2_000,
	partIndex: '2',
	contentId: '<Logo@Sender.example>',
};

describe('normalizeContentId', () => {
	it('drops angle brackets, decodes the URL form and lowercases', () => {
		expect(normalizeContentId('<Logo@Sender.example>')).toBe('logo@sender.example');
		expect(normalizeContentId('part%401.2')).toBe('part@1.2');
	});

	it('keeps an id with a stray percent sign as written', () => {
		expect(normalizeContentId('100%off')).toBe('100%off');
	});
});

describe('cidReferences', () => {
	it('collects every cid: an <img> points at, in either quote style', () => {
		const html = `<img src="cid:logo@sender.example"><p>x</p><img alt="b" src='cid:BADGE'><img src="https://a.example/x.png">`;
		expect([...cidReferences(html)]).toEqual(['logo@sender.example', 'badge']);
	});

	it('ignores cid: outside an img src', () => {
		expect(cidReferences('<a href="cid:logo">x</a> cid:logo').size).toBe(0);
		expect(cidReferences(undefined).size).toBe(0);
	});
});

describe('inlineImageParts', () => {
	it('returns the referenced image parts, each once', () => {
		const html = '<img src="cid:logo@sender.example"><img src="cid:logo@sender.example">';
		const parts = inlineImageParts([logo, { ...logo, partIndex: '3' }], html);
		expect(parts).toEqual([logo]);
	});

	it('skips unreferenced, non-image, id-less and oversized parts', () => {
		const html = '<img src="cid:a"><img src="cid:b"><img src="cid:c">';
		const parts = inlineImageParts(
			[
				{ ...logo, contentId: 'a', contentType: 'application/pdf' },
				{ ...logo, contentId: 'b', size: MAX_CID_IMAGE_BYTES + 1 },
				{ ...logo, contentId: undefined },
				{ ...logo, contentId: 'unused' },
			],
			html
		);
		expect(parts).toEqual([]);
	});
});

describe('resolveCidImages', () => {
	it('points resolved references at their data: URL and leaves the rest', () => {
		const html = '<img alt="Logo" src="cid:Logo@Sender.example" width="10"><img src="cid:missing">';
		const out = resolveCidImages(
			html,
			new Map([['logo@sender.example', 'data:image/png;base64,AAA']])
		);
		expect(out).toBe(
			'<img alt="Logo" src="data:image/png;base64,AAA" width="10"><img src="cid:missing">'
		);
	});

	it('is a no-op with nothing resolved', () => {
		const html = '<img src="cid:logo">';
		expect(resolveCidImages(html, new Map())).toBe(html);
	});
});
