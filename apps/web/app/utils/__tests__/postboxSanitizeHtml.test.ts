import { describe, expect, it } from 'vitest';
import { sanitizePostboxHtml } from '../postboxSanitizeHtml';

describe('sanitizePostboxHtml', () => {
	it('drops <script> tags', () => {
		const out = sanitizePostboxHtml('<p>Hi</p><script>alert(document.cookie)</script>');
		expect(out).not.toContain('<script');
		expect(out).not.toContain('alert(');
		expect(out).toContain('<p>Hi</p>');
	});

	it('strips inline on* event handlers', () => {
		const out = sanitizePostboxHtml('<img src="x" onerror="alert(1)" alt="a">');
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('alert(1)');
	});

	it('removes javascript: hrefs', () => {
		const out = sanitizePostboxHtml('<a href="javascript:alert(1)">click</a>');
		expect(out).not.toContain('javascript:');
		expect(out).toContain('click');
	});

	it('keeps benign markup and safe links', () => {
		const input = '<p><strong>Best,</strong><br><a href="https://example.com">Marcel</a></p>';
		const out = sanitizePostboxHtml(input);
		expect(out).toContain('<strong>Best,</strong>');
		expect(out).toContain('<br');
		expect(out).toContain('href="https://example.com"');
		expect(out).toContain('Marcel');
	});
});
