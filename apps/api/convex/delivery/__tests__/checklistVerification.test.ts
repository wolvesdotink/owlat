import { describe, expect, it } from 'vitest';
import { DNS_RETRY_DELAYS_MS } from '../checklistEvidence';
import { isFinalDnsPropagationAttempt } from '../checklistVerification';

describe('deliverability verification propagation window', () => {
	it('does not make an initial regression sweep final', () => {
		expect(isFinalDnsPropagationAttempt(true, undefined, 0)).toBe(false);
		expect(isFinalDnsPropagationAttempt(true, undefined, DNS_RETRY_DELAYS_MS.length)).toBe(false);
	});

	it('becomes final only after the bounded retry chain reaches its last attempt', () => {
		expect(isFinalDnsPropagationAttempt(true, 7, DNS_RETRY_DELAYS_MS.length - 1)).toBe(false);
		expect(isFinalDnsPropagationAttempt(true, 7, DNS_RETRY_DELAYS_MS.length)).toBe(true);
		expect(isFinalDnsPropagationAttempt(false, 7, DNS_RETRY_DELAYS_MS.length)).toBe(false);
	});
});
