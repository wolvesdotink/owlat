// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { buildQuotedReply, buildForwardedBody } from '../usePostboxQuotedText';

const base = {
	fromAddress: 'sara@example.com',
	fromName: 'Sara',
	toAddresses: ['me@example.com', 'team@example.com'],
	subject: 'Lunch?',
	receivedAt: new Date('2026-01-02T12:00:00Z').getTime(),
};

describe('buildQuotedReply', () => {
	it('wraps the original HTML body in an attributed quote block', () => {
		const out = buildQuotedReply({ ...base, htmlBodyInline: '<p>Hi there</p>' }, true);
		expect(out).toContain('gmail_quote');
		expect(out).toContain('Sara &lt;sara@example.com&gt; wrote:');
		expect(out).toContain('<blockquote');
		expect(out).toContain('<p>Hi there</p>');
	});

	it('falls back to a <pre>-wrapped, escaped text body', () => {
		const out = buildQuotedReply({ ...base, textBodyInline: 'a < b & c' }, true);
		expect(out).toContain('<pre');
		expect(out).toContain('a &lt; b &amp; c');
	});

	it('sanitizes attacker-controlled inbound HTML (no DOM-XSS into the composer)', () => {
		const out = buildQuotedReply(
			{
				...base,
				htmlBodyInline: '<img src=x onerror="alert(1)"><script>alert(2)</script><p>ok</p>',
			},
			true
		);
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('<script');
		expect(out).toContain('<p>ok</p>');
	});
});

describe('buildForwardedBody', () => {
	it('prepends a forwarded-message header with the original recipients', () => {
		const out = buildForwardedBody({ ...base, htmlBodyInline: '<p>original</p>' }, true);
		expect(out).toContain('Forwarded message');
		expect(out).toContain('From: Sara &lt;sara@example.com&gt;');
		expect(out).toContain('Subject: Lunch?');
		expect(out).toContain('To: me@example.com, team@example.com');
		expect(out).toContain('<p>original</p>');
	});
});

describe('quoted remote images', () => {
	const html =
		'<p>Hi</p><img src="https://cdn.example/hero.jpg" width="600" height="300">' +
		'<img src="https://track.example/open.gif" width="1" height="1">';

	it('keeps real images but always drops tracking pixels', () => {
		const out = buildQuotedReply({ ...base, htmlBodyInline: html }, true);
		expect(out).toContain('src="https://cdn.example/hero.jpg"');
		expect(out).not.toContain('track.example');
	});

	it('drops every remote image, without a stand-in, when the source would not load them', () => {
		for (const out of [
			buildQuotedReply({ ...base, htmlBodyInline: html }, false),
			buildForwardedBody({ ...base, htmlBodyInline: html }, false),
		]) {
			expect(out).not.toContain('cdn.example');
			expect(out).not.toContain('track.example');
			expect(out).not.toContain('data-blocked-img');
			expect(out).toContain('<p>Hi</p>');
		}
	});
});
