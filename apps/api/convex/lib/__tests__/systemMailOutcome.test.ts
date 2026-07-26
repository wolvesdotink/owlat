import { describe, expect, it } from 'vitest';
import { EmailErrorCode } from '../sendProviders';
import { systemMailRetryDisposition } from '../systemMailOutcome';

describe('system mail retry disposition', () => {
	it.each([
		['mta', 'safe_to_retry'],
		['resend', 'safe_to_retry'],
		['ses', 'terminal'],
		['plugin-transport', 'terminal'],
	] as const)(
		'classifies an ambiguous %s action boundary from transport deduplication guarantees',
		(provider, expected) => {
			expect(
				systemMailRetryDisposition(
					provider,
					'stable-idempotency-key',
					EmailErrorCode.AMBIGUOUS_TIMEOUT
				)
			).toBe(expected);
		}
	);

	it('keeps a known pre-accept SES server failure retryable', () => {
		expect(
			systemMailRetryDisposition('ses', 'stable-idempotency-key', EmailErrorCode.SERVER_ERROR)
		).toBe('safe_to_retry');
	});

	it('keeps an SES timeout terminal even when the caller supplied an idempotency key', () => {
		expect(
			systemMailRetryDisposition('ses', 'stable-idempotency-key', EmailErrorCode.AMBIGUOUS_TIMEOUT)
		).toBe('terminal');
	});
});
