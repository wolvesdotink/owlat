import sanitizeHtml from 'sanitize-html';
import { describe, it, expect } from 'vitest';
import { POSTBOX_SANITIZE_CONFIG } from '../postboxSanitize';

/**
 * M1 coverage: confirm `data:` URIs are stripped from CSS background-image
 * (only `cid:` and `http(s):` schemes are kept), and that script tags / event
 * handlers / dangerous href schemes remain blocked.
 *
 * sanitize-html doesn't expose a "value too long" callback, so the
 * size-cap defense lives at the save boundary in mail/signatures.ts.
 */

function clean(html: string): string {
	return sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG);
}

describe('POSTBOX_SANITIZE_CONFIG background-image', () => {
	it('strips data: URIs in CSS background-image', () => {
		const dirty =
			'<div style="background-image: url(data:image/png;base64,AAAA)">x</div>';
		const out = clean(dirty);
		expect(out).not.toContain('data:image/png');
	});

	it('keeps https URLs in background-image', () => {
		const dirty =
			'<div style="background-image: url(https://example.com/bg.png)">x</div>';
		const out = clean(dirty);
		expect(out).toContain('https://example.com/bg.png');
	});

	it('keeps cid: URLs (inline attachments)', () => {
		const dirty = '<div style="background-image: url(cid:bg1)">x</div>';
		const out = clean(dirty);
		expect(out).toContain('cid:bg1');
	});

	it('still strips javascript: in href', () => {
		const dirty = '<a href="javascript:alert(1)">x</a>';
		const out = clean(dirty);
		expect(out.toLowerCase()).not.toContain('javascript:');
	});

	it('still strips script tags', () => {
		const dirty = '<p>hi<script>alert(1)</script></p>';
		const out = clean(dirty);
		expect(out).not.toContain('<script');
	});

	it('still strips event-handler attributes', () => {
		const dirty = '<img src="https://x/x.png" onerror="alert(1)">';
		const out = clean(dirty);
		expect(out.toLowerCase()).not.toContain('onerror');
	});
});
