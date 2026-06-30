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
		const out = buildQuotedReply({ ...base, htmlBodyInline: '<p>Hi there</p>' });
		expect(out).toContain('gmail_quote');
		expect(out).toContain('Sara &lt;sara@example.com&gt; wrote:');
		expect(out).toContain('<blockquote');
		expect(out).toContain('<p>Hi there</p>');
	});

	it('falls back to a <pre>-wrapped, escaped text body', () => {
		const out = buildQuotedReply({ ...base, textBodyInline: 'a < b & c' });
		expect(out).toContain('<pre');
		expect(out).toContain('a &lt; b &amp; c');
	});

	it('sanitizes attacker-controlled inbound HTML (no DOM-XSS into the composer)', () => {
		const out = buildQuotedReply({
			...base,
			htmlBodyInline: '<img src=x onerror="alert(1)"><script>alert(2)</script><p>ok</p>',
		});
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('<script');
		expect(out).toContain('<p>ok</p>');
	});
});

describe('buildForwardedBody', () => {
	it('prepends a forwarded-message header with the original recipients', () => {
		const out = buildForwardedBody({ ...base, htmlBodyInline: '<p>original</p>' });
		expect(out).toContain('Forwarded message');
		expect(out).toContain('From: Sara &lt;sara@example.com&gt;');
		expect(out).toContain('Subject: Lunch?');
		expect(out).toContain('To: me@example.com, team@example.com');
		expect(out).toContain('<p>original</p>');
	});
});
