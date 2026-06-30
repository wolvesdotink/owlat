import { describe, it, expect } from 'vitest';
import { scanContent } from '@owlat/email-scanner';

describe('contentScanner', () => {
	describe('clean content', () => {
		it('should pass legitimate marketing email', () => {
			const result = scanContent(
				'Your weekly newsletter from Acme Inc.',
				'<html><body><h1>Welcome!</h1><p>Here are this week\'s updates from our team.</p><a href="https://acme.com/blog">Read more</a></body></html>'
			);

			expect(result.level).toBe('clean');
			expect(result.pass).toBe(true);
			expect(result.score).toBeLessThan(15);
		});

		it('should pass transactional email content', () => {
			const result = scanContent(
				'Your order #12345 has shipped',
				'<html><body><p>Hi John, your order has been shipped. Track it at <a href="https://shop.com/track/12345">shop.com/track/12345</a></p></body></html>'
			);

			expect(result.level).toBe('clean');
			expect(result.pass).toBe(true);
		});

		it('should pass empty content', () => {
			const result = scanContent('', '');
			expect(result.level).toBe('clean');
			expect(result.pass).toBe(true);
			expect(result.flags).toHaveLength(0);
		});
	});

	describe('spam keyword detection', () => {
		it('should flag pharmaceutical spam', () => {
			const result = scanContent(
				'Buy Viagra online cheap',
				'<html><body><p>Buy cheap viagra and cialis online. Best prices on medications.</p></body></html>'
			);

			expect(result.level).not.toBe('clean');
			expect(result.flags.some(f => f.type === 'spam_keywords')).toBe(true);
		});

		it('should flag financial scam content', () => {
			const result = scanContent(
				'Make money fast - guaranteed returns!',
				'<html><body><p>Double your money with our get rich quick scheme. No investment required!</p></body></html>'
			);

			expect(result.flags.some(f => f.type === 'spam_keywords')).toBe(true);
			expect(result.score).toBeGreaterThan(10);
		});

		it('should flag you have won scam', () => {
			const result = scanContent(
				'Congratulations! You have won!',
				'<html><body><p>Congratulations! You\'ve won a million dollars! Click here to claim.</p></body></html>'
			);

			expect(result.flags.some(f => f.type === 'spam_keywords')).toBe(true);
		});
	});

	describe('URL scanning', () => {
		it('should flag URL shorteners', () => {
			const result = scanContent(
				'Check this out',
				'<html><body><a href="https://bit.ly/abc123">Click here</a></body></html>'
			);

			expect(result.flags.some(f => f.type === 'url_shortener')).toBe(true);
		});

		it('should flag URL text/href mismatches (phishing)', () => {
			const result = scanContent(
				'Update your account',
				'<html><body><a href="https://evil-site.com/phish">paypal.com</a></body></html>'
			);

			expect(result.flags.some(f => f.type === 'url_mismatch')).toBe(true);
		});

		it('should flag suspicious TLDs', () => {
			const result = scanContent(
				'Important update',
				'<html><body><a href="https://login-secure.xyz/account">Verify now</a></body></html>'
			);

			expect(result.flags.some(f => f.type === 'phishing_url')).toBe(true);
		});

		it('should flag javascript: URIs', () => {
			const result = scanContent(
				'Click here',
				'<html><body><a href="javascript:alert(1)">Click</a></body></html>'
			);

			expect(result.flags.some(f => f.type === 'phishing_url')).toBe(true);
		});

		it('should not flag legitimate URLs', () => {
			const result = scanContent(
				'Newsletter',
				'<html><body><a href="https://example.com/article">Read article</a><a href="https://shop.com/products">Browse products</a></body></html>'
			);

			expect(result.flags.filter(f => f.type === 'phishing_url')).toHaveLength(0);
			expect(result.flags.filter(f => f.type === 'url_mismatch')).toHaveLength(0);
		});
	});

	describe('subject line checks', () => {
		it('should flag ALL CAPS subjects', () => {
			const result = scanContent(
				'THIS IS A VERY IMPORTANT MESSAGE FOR YOU',
				'<html><body><p>Normal content here.</p></body></html>'
			);

			expect(result.flags.some(f => f.type === 'caps_abuse')).toBe(true);
		});

		it('should not flag short caps', () => {
			const result = scanContent(
				'NEW: Item',
				'<html><body><p>Content</p></body></html>'
			);

			expect(result.flags.filter(f => f.type === 'caps_abuse')).toHaveLength(0);
		});

		it('should flag excessive exclamation marks', () => {
			const result = scanContent(
				'Amazing deal!!!',
				'<html><body><p>Great offers</p></body></html>'
			);

			expect(result.flags.some(f => f.type === 'excessive_punctuation')).toBe(true);
		});
	});

	describe('prohibited content', () => {
		it('should flag credential phishing', () => {
			const result = scanContent(
				'Verify your account',
				'<html><body><p>Please confirm your password and login credentials immediately.</p></body></html>'
			);

			expect(result.flags.some(f => f.type === 'prohibited_content')).toBe(true);
		});

		it('should flag requests for sensitive information', () => {
			const result = scanContent(
				'Account verification required',
				'<html><body><p>Please provide your social security number to verify your identity.</p></body></html>'
			);

			expect(result.flags.some(f => f.type === 'prohibited_content')).toBe(true);
		});
	});

	describe('scoring and levels', () => {
		it('should score 0 for clean content', () => {
			const result = scanContent(
				'Monthly Report',
				'<html><body><p>Here is your monthly report summary.</p></body></html>'
			);

			expect(result.score).toBe(0);
			expect(result.level).toBe('clean');
		});

		it('should mark highly suspicious content as blocked', () => {
			const result = scanContent(
				'CONGRATULATIONS!!! YOU HAVE WON!!!',
				'<html><body><p>You\'ve won a million dollars! Send your credit card number and social security number to claim. Wire transfer immediately via western union. Buy cheap viagra online.</p><a href="https://paypa1.xyz/login">paypal.com</a></body></html>'
			);

			expect(result.level).toBe('blocked');
			expect(result.score).toBeGreaterThanOrEqual(40);
		});

		it('should cap score at 100', () => {
			// Create extremely spammy content that would exceed 100
			const result = scanContent(
				'FREE MONEY!!! CONGRATULATIONS!!! YOU WON!!!',
				'<html><body><p>Free money! Get rich quick! Guaranteed returns! Double your money! No investment required! Buy viagra cheap! Win big cash prizes! Nigerian prince advance fee! Wire transfer immediately via western union urgently! Confirm your password and login credentials! Send social security number!</p><a href="https://bit.ly/scam">Click here</a><a href="https://paypa1.xyz">paypal.com</a><a href="javascript:alert(1)">Safe link</a></body></html>'
			);

			expect(result.score).toBeLessThanOrEqual(100);
		});
	});
});
