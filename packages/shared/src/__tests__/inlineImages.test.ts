import { describe, it, expect } from 'vitest';
import {
	rewriteInlineImageCids,
	isInlineImageReferenced,
	resolveInlineImageSrcs,
} from '../inlineImages';

describe('rewriteInlineImageCids', () => {
	it('rewrites a blob-preview img to a cid: src matching its content-id', () => {
		const { html, referencedCids } = rewriteInlineImageCids(
			'<p>hi</p><img src="blob:https://app/abc" data-inline-cid="cid-1" alt="pic">'
		);
		expect(html).toContain('src="cid:cid-1"');
		expect(html).not.toContain('blob:');
		expect(html).not.toContain('data-inline-cid');
		// Non-cid content (and other attributes) is preserved.
		expect(html).toContain('<p>hi</p>');
		expect(html).toContain('alt="pic"');
		expect(referencedCids).toEqual(['cid-1']);
	});

	it('reports every distinct referenced content-id, de-duplicated', () => {
		const { referencedCids } = rewriteInlineImageCids(
			'<img data-inline-cid="a" src="blob:1">' +
				'<img data-inline-cid="b" src="blob:2">' +
				'<img data-inline-cid="a" src="blob:3">'
		);
		expect(referencedCids.sort()).toEqual(['a', 'b']);
	});

	it('leaves ordinary (non-inline) img tags untouched and unreported', () => {
		const input = '<img src="https://cdn.example/logo.png" width="40">';
		const { html, referencedCids } = rewriteInlineImageCids(input);
		expect(html).toBe(input);
		expect(referencedCids).toEqual([]);
	});

	it('handles single-quoted and unquoted marker values', () => {
		const single = rewriteInlineImageCids("<img data-inline-cid='q1' src='blob:x'>");
		expect(single.html).toContain('src="cid:q1"');
		expect(single.referencedCids).toEqual(['q1']);
		const bare = rewriteInlineImageCids('<img data-inline-cid=q2 src="blob:x">');
		expect(bare.html).toContain('src="cid:q2"');
		expect(bare.referencedCids).toEqual(['q2']);
	});

	it('injects a cid src even when the tag carries no src attribute', () => {
		const { html } = rewriteInlineImageCids('<img data-inline-cid="only">');
		expect(html).toContain('src="cid:only"');
	});
});

describe('isInlineImageReferenced (prune predicate)', () => {
	it('keeps a part whose content-id the body still references', () => {
		expect(isInlineImageReferenced(['a', 'b'], 'a')).toBe(true);
	});

	it('prunes a part the body no longer references (deleted from the body)', () => {
		const { referencedCids } = rewriteInlineImageCids('<p>text only, image removed</p>');
		expect(isInlineImageReferenced(referencedCids, 'orphan')).toBe(false);
	});

	it('treats a part with no content-id as unreferenced', () => {
		expect(isInlineImageReferenced(['a'], undefined)).toBe(false);
	});
});

describe('resolveInlineImageSrcs (#1301)', () => {
	const urls = new Map([
		['logo@owlat', 'https://api.owlat.example/sealed-blob?id=s1&exp=9&sig="x"'],
	]);

	it('points a marked image at the URL resolved for its content-id', () => {
		const html = resolveInlineImageSrcs(
			'<p>hi</p><img data-inline-cid="logo@owlat" alt="logo.png" style="max-width: 100%">',
			(cid) => urls.get(cid)
		);
		expect(html).toBe(
			'<p>hi</p><img src="https://api.owlat.example/sealed-blob?id=s1&amp;exp=9&amp;sig=&quot;x&quot;" alt="logo.png" style="max-width: 100%">'
		);
	});

	it('leaves an image whose URL is not known yet without a src, stale src included', () => {
		const html = resolveInlineImageSrcs(
			'<img src="blob:dead" data-inline-cid="later">',
			() => undefined
		);
		expect(html).toBe('<img>');
	});

	it('leaves ordinary images alone', () => {
		const input = '<img src="https://cdn.example/logo.png" width="40">';
		expect(resolveInlineImageSrcs(input, () => 'https://other.example/x')).toBe(input);
	});
});
