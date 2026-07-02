import { describe, it, expect } from 'vitest';
import {
	applyLinkTransparency,
	stripTrackingParams,
	textClaimedHost,
} from '../postboxLinkTransparency';

describe('applyLinkTransparency — destination tooltip', () => {
	it('adds a title with the real destination host', () => {
		const html = '<a href="https://example.com/page">Click here</a>';
		expect(applyLinkTransparency(html)).toContain('title="example.com"');
	});

	it('replaces a sender-supplied title (it could lie)', () => {
		const html = '<a href="https://evil.example/x" title="paypal.com">Click</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('title="evil.example"');
		expect(out).not.toContain('title="paypal.com"');
	});

	it('keeps existing target/rel attributes intact', () => {
		const html =
			'<a href="https://example.com/" target="_blank" rel="noreferrer noopener">x</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noreferrer noopener"');
	});

	it('leaves mailto/tel/relative/href-less anchors unchanged', () => {
		for (const html of [
			'<a href="mailto:a@b.com">mail</a>',
			'<a href="tel:+123">call</a>',
			'<a href="/relative">rel</a>',
			'<a name="anchor">no href</a>',
		]) {
			expect(applyLinkTransparency(html)).toBe(html);
		}
	});
});

describe('applyLinkTransparency — text-vs-href mismatch marker', () => {
	it('flags an anchor whose visible URL text names a different host', () => {
		const html = '<a href="https://evil.example/login">https://paypal.com/secure</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('→ evil.example');
		expect(out).toMatch(/<span style="[^"]*">→ evil\.example<\/span>/);
	});

	it('flags bare-domain visible text pointing elsewhere', () => {
		const html = '<a href="https://phish.example/x">paypal.com</a>';
		expect(applyLinkTransparency(html)).toContain('→ phish.example');
	});

	it('does not flag when text host matches href host', () => {
		const html = '<a href="https://example.com/page">https://example.com/page</a>';
		expect(applyLinkTransparency(html)).not.toContain('→');
	});

	it('treats www.host and host as the same destination', () => {
		const html = '<a href="https://www.example.com/">example.com</a>';
		expect(applyLinkTransparency(html)).not.toContain('→');
	});

	it('does not flag plain (non-URL) link text', () => {
		const html = '<a href="https://example.com/">Read the full announcement</a>';
		expect(applyLinkTransparency(html)).not.toContain('→');
	});

	it('does not flag version-number-looking text', () => {
		const html = '<a href="https://example.com/">v2.10 release notes</a>';
		expect(applyLinkTransparency(html)).not.toContain('→');
	});
});

describe('applyLinkTransparency — tracking param stripping', () => {
	it('strips utm params but keeps other params, host, and path', () => {
		const html =
			'<a href="https://example.com/p?utm_source=nl&amp;id=42&amp;utm_medium=email">x</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('href="https://example.com/p?id=42"');
		expect(out).not.toContain('utm_source');
		expect(out).not.toContain('utm_medium');
	});

	it('strips fbclid/gclid/mc_eid', () => {
		const html =
			'<a href="https://example.com/?fbclid=a&amp;gclid=b&amp;mc_eid=c&amp;keep=1">x</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('href="https://example.com/?keep=1"');
	});

	it('leaves http (non-https) hrefs unrewritten but still adds the tooltip', () => {
		const html = '<a href="http://example.com/?utm_source=x">y</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('utm_source=x');
		expect(out).toContain('title="example.com"');
	});
});

describe('applyLinkTransparency — attribute-value spoofing', () => {
	it('ignores a literal href= inside another attribute value (forged tooltip)', () => {
		const html =
			'<a name="x href=https://trusted-bank.com" href="https://evil.example/steal">trusted-bank.com</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('title="evil.example"');
		expect(out).not.toContain('title="trusted-bank.com');
		// The mismatch marker must disclose the REAL destination.
		expect(out).toContain('→ evil.example');
		expect(out).toContain('href="https://evil.example/steal"');
	});

	it('ignores a literal href= inside a sender-supplied title value', () => {
		const html =
			'<a title="href=https://apple.com/" href="https://evil.example/">Verify your Apple ID</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('title="evil.example"');
		expect(out).not.toContain('apple.com');
	});

	it('does not mangle an anchor whose other attribute value contains title=', () => {
		const html = '<a name="a title=b" href="https://real.com">hi</a>';
		const out = applyLinkTransparency(html);
		expect(out).toContain('name="a title=b"');
		expect(out).toContain('href="https://real.com"');
		expect(out).toContain('title="real.com"');
	});
});

describe('applyLinkTransparency — fail-soft', () => {
	it('returns non-anchor HTML unchanged', () => {
		const html = '<p>Hello <b>world</b></p>';
		expect(applyLinkTransparency(html)).toBe(html);
	});

	it('leaves an anchor with an unparseable href unchanged', () => {
		const html = '<a href="https://exa mple .com/%zz">broken</a>';
		expect(applyLinkTransparency(html)).toBe(html);
	});

	it('does not throw on empty input', () => {
		expect(applyLinkTransparency('')).toBe('');
	});
});

describe('stripTrackingParams', () => {
	it('strips only tracking params', () => {
		expect(
			stripTrackingParams('https://example.com/a?utm_campaign=x&page=2#frag')
		).toBe('https://example.com/a?page=2#frag');
	});

	it('drops the dangling ? when all params were tracking noise', () => {
		expect(stripTrackingParams('https://example.com/a?utm_source=x')).toBe(
			'https://example.com/a'
		);
	});

	it('never touches host or path', () => {
		const out = stripTrackingParams('https://sub.example.com/deep/path?gclid=1&x=y');
		expect(out.startsWith('https://sub.example.com/deep/path?')).toBe(true);
	});

	it('returns non-https URLs unchanged', () => {
		expect(stripTrackingParams('http://example.com/?utm_source=x')).toBe(
			'http://example.com/?utm_source=x'
		);
		expect(stripTrackingParams('mailto:a@b.com?utm_source=x')).toBe(
			'mailto:a@b.com?utm_source=x'
		);
	});

	it('returns a malformed URL unchanged', () => {
		expect(stripTrackingParams('https://')).toBe('https://');
	});
});

describe('textClaimedHost', () => {
	it('parses a full URL', () => {
		expect(textClaimedHost('https://www.paypal.com/secure')).toBe('paypal.com');
	});

	it('parses a bare domain with a path', () => {
		expect(textClaimedHost('example.co.uk/path?q=1')).toBe('example.co.uk');
	});

	it('rejects plain words and numbers', () => {
		expect(textClaimedHost('Click here')).toBeNull();
		expect(textClaimedHost('v2.10')).toBeNull();
		expect(textClaimedHost('1.5')).toBeNull();
		expect(textClaimedHost('')).toBeNull();
	});
});
