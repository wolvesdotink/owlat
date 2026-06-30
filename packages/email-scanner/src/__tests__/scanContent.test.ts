import { describe, it, expect } from 'vitest';
import { scanContent } from '../content/index.js';

describe('scanContent', () => {
	it('returns clean for normal email content', () => {
		const result = scanContent(
			'Welcome to our newsletter',
			'<html><body><p>Thanks for signing up! Here is your weekly update.</p></body></html>'
		);

		expect(result.level).toBe('clean');
		expect(result.pass).toBe(true);
		expect(result.score).toBeLessThan(15);
		expect(result.flags).toHaveLength(0);
	});

	it('detects spam keywords in subject and body', () => {
		const result = scanContent(
			'FREE MONEY - Get Rich Quick!!!',
			'<html><body><p>Make money fast! Double your investment guaranteed!</p></body></html>'
		);

		expect(result.level).not.toBe('clean');
		expect(result.pass).toBe(false);
		expect(result.flags.some(f => f.type === 'spam_keywords')).toBe(true);
	});

	it('detects phishing URLs', () => {
		const result = scanContent(
			'Important account update',
			'<html><body><a href="https://paypa1.fake.xyz/login">Click here to verify</a></body></html>'
		);

		expect(result.flags.some(f => f.type === 'phishing_url')).toBe(true);
	});

	it('detects URL shorteners', () => {
		const result = scanContent(
			'Check this out',
			'<html><body><a href="https://bit.ly/abc123">Click here</a></body></html>'
		);

		expect(result.flags.some(f => f.type === 'url_shortener')).toBe(true);
	});

	it('detects anchor text / href mismatch', () => {
		const result = scanContent(
			'Security alert',
			'<html><body><a href="https://evil-site.com/steal">paypal.com</a></body></html>'
		);

		expect(result.flags.some(f => f.type === 'url_mismatch')).toBe(true);
	});

	it('detects dangerous URI schemes', () => {
		const result = scanContent(
			'Test',
			'<html><body><a href="javascript:alert(1)">Click</a></body></html>'
		);

		expect(result.flags.some(f => f.type === 'phishing_url' && f.severity === 'high')).toBe(true);
	});

	it('detects ALL CAPS subject abuse', () => {
		const result = scanContent(
			'THIS IS AN ALL CAPS SUBJECT LINE WITH LOTS OF SHOUTING',
			'<html><body><p>Normal content</p></body></html>'
		);

		expect(result.flags.some(f => f.type === 'caps_abuse')).toBe(true);
	});

	it('detects excessive punctuation', () => {
		const result = scanContent(
			'Amazing offer!!! Act now!!!',
			'<html><body><p>Normal content</p></body></html>'
		);

		expect(result.flags.some(f => f.type === 'excessive_punctuation')).toBe(true);
	});

	it('detects prohibited content (advance fee fraud)', () => {
		const result = scanContent(
			'Urgent message',
			'<html><body><p>I am a Nigerian prince and I need your help with a wire transfer immediately.</p></body></html>'
		);

		expect(result.flags.some(f => f.type === 'prohibited_content')).toBe(true);
	});

	it('detects credential phishing', () => {
		const result = scanContent(
			'Verify your account',
			'<html><body><p>Please confirm your password to continue.</p></body></html>'
		);

		expect(result.flags.some(f => f.type === 'prohibited_content')).toBe(true);
	});

	it('caps score at 100', () => {
		// Load up tons of flags
		const result = scanContent(
			'FREE MONEY VIAGRA GET RICH QUICK!!!',
			`<html><body>
				<a href="javascript:alert(1)">paypal.com</a>
				<a href="https://paypa1.fake.xyz">amazon.com</a>
				<a href="https://bit.ly/x">click</a>
				<a href="https://evil.com">google.com</a>
				<p>Nigerian prince wire transfer immediately. Confirm your password. Provide your credit card number.</p>
				<p>Congratulations you have won! Double your money guaranteed returns!</p>
			</body></html>`
		);

		expect(result.score).toBeLessThanOrEqual(100);
		expect(result.level).toBe('blocked');
	});

	it('correctly strips HTML for keyword scanning', () => {
		const result = scanContent(
			'Normal subject',
			'<html><body><style>.spam { display: none; }</style><p>Normal &amp; safe content</p></body></html>'
		);

		expect(result.level).toBe('clean');
	});
});
