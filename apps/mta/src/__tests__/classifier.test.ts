import { describe, it, expect } from 'vitest';
import { classifyBounce } from '../bounce/classifier.js';

describe('Bounce classifier', () => {
	describe('hard bounces', () => {
		it('should classify "user unknown" as hard bounce', () => {
			const result = classifyBounce('550 5.1.1 The email account that you tried to reach does not exist. User unknown.');
			expect(result.bounceType).toBe('hard');
			expect(result.type).toBe('bounced');
		});

		it('should classify "no such user" as hard bounce', () => {
			const result = classifyBounce('550 No such user - abc@example.com');
			expect(result.bounceType).toBe('hard');
		});

		it('should classify "mailbox not found" as hard bounce', () => {
			const result = classifyBounce('550 5.1.1 Mailbox not found');
			expect(result.bounceType).toBe('hard');
		});

		it('should classify "account disabled" as hard bounce', () => {
			const result = classifyBounce('550 Account has been disabled');
			expect(result.bounceType).toBe('hard');
		});

		it('should classify "recipient rejected" as hard bounce', () => {
			const result = classifyBounce('550 Recipient rejected');
			expect(result.bounceType).toBe('hard');
		});

		it('should classify "relay denied" as hard bounce', () => {
			const result = classifyBounce('550 Relay denied');
			expect(result.bounceType).toBe('hard');
		});
	});

	describe('soft bounces', () => {
		it('should classify "mailbox full" as soft bounce', () => {
			const result = classifyBounce('452 4.2.2 Mailbox full');
			expect(result.bounceType).toBe('soft');
		});

		it('should classify "try again later" as soft bounce', () => {
			const result = classifyBounce('421 Try again later');
			expect(result.bounceType).toBe('soft');
		});

		it('should classify "too many connections" as soft bounce', () => {
			const result = classifyBounce('421 Too many connections from your IP');
			expect(result.bounceType).toBe('soft');
		});

		it('should classify "rate limit" as soft bounce', () => {
			const result = classifyBounce('421 Rate limit exceeded');
			expect(result.bounceType).toBe('soft');
		});

		it('should classify "greylisted" as soft bounce', () => {
			const result = classifyBounce('450 Greylisted, please try again in 60 seconds');
			expect(result.bounceType).toBe('soft');
		});

		it('should treat 5.2.2 (mailbox full) as soft despite 5xx class', () => {
			const result = classifyBounce('552 5.2.2 Quota exceeded');
			expect(result.bounceType).toBe('soft');
		});
	});

	describe('complaints', () => {
		it('should classify ARF feedback report as complaint', () => {
			const result = classifyBounce('This is a feedback-report of type abuse', undefined, 'multipart/report');
			expect(result.type).toBe('complained');
		});

		it('should classify spam complaint as complaint', () => {
			const result = classifyBounce('Feedback-Type: abuse');
			expect(result.type).toBe('complained');
		});
	});

	describe('defaults', () => {
		it('should default to soft bounce for unknown responses', () => {
			const result = classifyBounce('Some unknown error message from a remote server');
			expect(result.bounceType).toBe('soft');
			expect(result.type).toBe('bounced');
		});
	});

	describe('enhanced status codes', () => {
		it('should classify 5.1.x as hard bounce', () => {
			const result = classifyBounce('550 5.1.1 User unknown');
			expect(result.bounceType).toBe('hard');
			expect(result.diagnosticCode).toBe('5.1.1');
		});

		it('should classify 5.7.x as hard bounce (policy)', () => {
			const result = classifyBounce('550 5.7.1 Message rejected due to security policy');
			expect(result.bounceType).toBe('hard');
			expect(result.diagnosticCode).toBe('5.7.1');
		});

		it('should classify 4.x.x as soft bounce', () => {
			const result = classifyBounce('421 4.7.0 Connection rate limited');
			expect(result.bounceType).toBe('soft');
			expect(result.diagnosticCode).toBe('4.7.0');
		});
	});

	describe('truncation', () => {
		it('should truncate long messages', () => {
			const longMessage = 'x'.repeat(1000);
			const result = classifyBounce(longMessage);
			expect(result.message.length).toBeLessThanOrEqual(503); // 500 + "..."
		});
	});
});
