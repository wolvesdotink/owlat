import { describe, it, expect } from 'vitest';
import {
	applySignatureToBody,
	bodyHasSignatureBlock,
	stripSignatureBlock,
	wrapSignatureBlock,
} from '../usePostboxSignatureBody';

const SIG_A = '<p>— Marcel</p>';
const SIG_B = '<p>— Marcel | Work</p>';

describe('wrapSignatureBlock', () => {
	it('wraps the html in a marked block with leading spacing', () => {
		const out = wrapSignatureBlock(SIG_A);
		expect(out).toContain('data-postbox-signature');
		expect(out).toContain(SIG_A);
		expect(out.startsWith('<br><br>')).toBe(true);
	});
});

describe('bodyHasSignatureBlock', () => {
	it('detects a previously applied signature block', () => {
		expect(bodyHasSignatureBlock(wrapSignatureBlock(SIG_A))).toBe(true);
	});

	it('returns false for plain body content', () => {
		expect(bodyHasSignatureBlock('<p>hello</p>')).toBe(false);
	});
});

describe('applySignatureToBody', () => {
	it('appends a signature to an empty body', () => {
		const out = applySignatureToBody('', SIG_A);
		expect(out).toContain(SIG_A);
		expect(bodyHasSignatureBlock(out)).toBe(true);
	});

	it('swaps an existing signature without clobbering fresh content above it', () => {
		const withA = '<p>Hi there</p>' + wrapSignatureBlock(SIG_A);
		const out = applySignatureToBody(withA, SIG_B);
		expect(out).toContain('<p>Hi there</p>');
		expect(out).toContain(SIG_B);
		expect(out).not.toContain(SIG_A);
		// Exactly one signature block remains.
		expect(out.match(/data-postbox-signature/g)?.length).toBe(1);
	});

	it('removes the signature block when applying an empty signature', () => {
		const withA = '<p>Hi</p>' + wrapSignatureBlock(SIG_A);
		const out = applySignatureToBody(withA, '');
		expect(out).toContain('<p>Hi</p>');
		expect(bodyHasSignatureBlock(out)).toBe(false);
	});

	it('appends to typed content that has no signature yet', () => {
		const out = applySignatureToBody('<p>Draft text</p>', SIG_A);
		expect(out).toContain('<p>Draft text</p>');
		expect(out).toContain(SIG_A);
		expect(bodyHasSignatureBlock(out)).toBe(true);
	});
});

describe('stripSignatureBlock', () => {
	it('removes the trailing block and leaves the rest intact', () => {
		const withA = '<p>Body</p>' + wrapSignatureBlock(SIG_A);
		expect(stripSignatureBlock(withA)).toBe('<p>Body</p>');
	});
});
