import { describe, it, expect } from 'vitest';
import { classifySmtpResponse } from '../intelligence/smtpClassifier.js';

describe('Enhanced SMTP response classifier', () => {
	describe('provider feedback signatures', () => {
		it.each([
			['gmail', '421 4.7.28 Gmail rate limited', '4.7.28', 'gmail_rate_limited', 1_800_000],
			['gmail', '421 4.7.23 Missing PTR', '4.7.23', 'gmail_ip_identity', 3_600_000],
			['gmail', '421 4.7.29 TLS required', '4.7.29', 'gmail_tls_required', 2_700_000],
			['yahoo', '421 TS03 temporarily deferred', undefined, 'yahoo_ts03', 1_800_000],
			['yahoo', '421 TSS04 temporarily deferred', undefined, 'yahoo_tss04', 3_600_000],
			[
				'microsoft',
				'451 4.3.2 temporary system problem',
				'4.3.2',
				'microsoft_resource_throttle',
				1_200_000,
			],
		])(
			'classifies %s with a tuned delay and dashboard annotation',
			(provider, response, enhanced, category, delay) => {
				const result = classifySmtpResponse(421, response, enhanced, provider);
				expect(result.category).toBe(category);
				expect(result.suggestedDelayMs).toBe(delay);
				expect(result.annotation).toBeTruthy();
			}
		);

		it.each([
			['gmail', '421 4.7.28 Gmail rate limited', '4.7.28'],
			['yahoo', '421 TS03 temporarily deferred', undefined],
			['microsoft', '451 4.3.2 temporary system problem', '4.3.2'],
		] as const)(
			'does not apply a %s signature to an unknown or different provider',
			(provider, response, enhanced) => {
				expect(classifySmtpResponse(421, response, enhanced, 'other').category).not.toContain(
					provider
				);
				const differentProvider = provider === 'gmail' ? 'yahoo' : 'gmail';
				expect(
					classifySmtpResponse(421, response, enhanced, differentProvider).category
				).not.toContain(provider);
			}
		);

		it('prefers the parsed enhanced code when response text conflicts', () => {
			const result = classifySmtpResponse(421, '421 4.7.28 rate limit text', '4.7.23', 'gmail');
			expect(result.category).toBe('gmail_ip_identity');
		});
	});
	describe('greylisting detection', () => {
		it('should detect greylisting responses', () => {
			const result = classifySmtpResponse(
				450,
				'450 4.7.1 Greylisted, please try again in 120 seconds'
			);
			expect(result.category).toBe('greylisted');
			expect(result.retryable).toBe(true);
			expect(result.countAsBounce).toBe(false);
		});

		it('should detect "try again later" as greylisting', () => {
			const result = classifySmtpResponse(421, '421 Please try again later');
			expect(result.category).toBe('greylisted');
			expect(result.retryable).toBe(true);
		});

		it('should extract delay from greylisting response', () => {
			const result = classifySmtpResponse(450, '450 Greylisted, try again in 300 seconds');
			expect(result.category).toBe('greylisted');
			expect(result.suggestedDelayMs).toBe(300_000);
		});

		it('should extract delay in minutes', () => {
			const result = classifySmtpResponse(450, '450 Temporarily deferred, try again in 5 minutes');
			expect(result.category).toBe('greylisted');
			expect(result.suggestedDelayMs).toBe(300_000);
		});

		it('should use default delay when no time specified', () => {
			const result = classifySmtpResponse(450, '450 Temporarily rejected');
			expect(result.category).toBe('greylisted');
			expect(result.suggestedDelayMs).toBe(120_000);
		});
	});

	describe('rate limiting detection', () => {
		it('should detect "too many connections"', () => {
			const result = classifySmtpResponse(421, '421 4.7.0 Too many connections from your IP');
			expect(result.category).toBe('rate_limited');
			expect(result.retryable).toBe(true);
			expect(result.suggestedDelayMs).toBe(900_000);
		});

		it('should detect "rate limit exceeded"', () => {
			const result = classifySmtpResponse(421, '421 Rate limit exceeded, slow down');
			expect(result.category).toBe('rate_limited');
		});

		it('should detect "too many messages"', () => {
			const result = classifySmtpResponse(452, '452 Too many messages, try later');
			expect(result.category).toBe('rate_limited');
		});

		it('should detect throttling', () => {
			const result = classifySmtpResponse(421, '421 Connection throttled');
			expect(result.category).toBe('rate_limited');
		});
	});

	describe('content rejection detection', () => {
		it('should detect spam rejection', () => {
			const result = classifySmtpResponse(550, '550 Message rejected as spam');
			expect(result.category).toBe('content_rejected');
			expect(result.retryable).toBe(false);
			expect(result.countAsBounce).toBe(true);
		});

		it('should detect phishing rejection', () => {
			const result = classifySmtpResponse(550, '550 Suspected phishing content');
			expect(result.category).toBe('content_rejected');
		});

		it('should detect URL blocklist rejection', () => {
			const result = classifySmtpResponse(550, '550 URL blacklisted by SURBL');
			expect(result.category).toBe('content_rejected');
		});

		it('should detect DNSBL listing', () => {
			const result = classifySmtpResponse(550, '550 Your IP is listed on Spamhaus');
			expect(result.category).toBe('content_rejected');
		});
	});

	describe('policy rejection detection', () => {
		it('should detect SPF failure', () => {
			const result = classifySmtpResponse(550, '550 5.7.1 SPF fail - sender not authorized');
			expect(result.category).toBe('policy_rejected');
			expect(result.retryable).toBe(false);
		});

		it('should detect DMARC failure', () => {
			const result = classifySmtpResponse(550, '550 5.7.1 DMARC fail - message rejected');
			expect(result.category).toBe('policy_rejected');
		});

		it('should detect reverse DNS rejection', () => {
			const result = classifySmtpResponse(550, '550 5.7.1 Reverse DNS lookup failure');
			expect(result.category).toBe('policy_rejected');
		});

		it('should detect PTR record rejection', () => {
			const result = classifySmtpResponse(550, '550 No PTR record found for your IP');
			expect(result.category).toBe('policy_rejected');
		});
	});

	describe('mailbox full detection', () => {
		it('should detect mailbox full with 5.2.2', () => {
			const result = classifySmtpResponse(552, '552 5.2.2 Mailbox full', '5.2.2');
			expect(result.category).toBe('mailbox_full');
			expect(result.retryable).toBe(true);
			expect(result.countAsBounce).toBe(false);
		});

		it('should detect "over quota"', () => {
			const result = classifySmtpResponse(452, '452 4.2.2 Over quota');
			expect(result.category).toBe('mailbox_full');
			expect(result.retryable).toBe(true);
		});

		it('should detect "insufficient storage"', () => {
			const result = classifySmtpResponse(452, '452 Insufficient storage');
			expect(result.category).toBe('mailbox_full');
		});
	});

	describe('authentication required', () => {
		it('should detect STARTTLS required', () => {
			const result = classifySmtpResponse(530, '530 STARTTLS required');
			expect(result.category).toBe('auth_required');
			expect(result.retryable).toBe(true);
		});

		it('should detect authentication required', () => {
			const result = classifySmtpResponse(530, '530 Authentication required');
			expect(result.category).toBe('auth_required');
		});
	});

	describe('fallback behavior', () => {
		it('should classify unknown 5xx as non-retryable', () => {
			const result = classifySmtpResponse(550, '550 Something went wrong');
			expect(result.category).toBe('unknown');
			expect(result.retryable).toBe(false);
			expect(result.countAsBounce).toBe(true);
		});

		it('should classify unknown 4xx as retryable', () => {
			const result = classifySmtpResponse(450, '450 Something temporarily wrong');
			expect(result.category).toBe('unknown');
			expect(result.retryable).toBe(true);
			expect(result.suggestedDelayMs).toBe(30_000);
		});

		it('should classify connection errors as network errors', () => {
			const result = classifySmtpResponse(undefined, 'ECONNREFUSED');
			expect(result.category).toBe('network_error');
			expect(result.retryable).toBe(true);
		});
	});
});
