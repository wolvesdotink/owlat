import { describe, expect, it } from 'vitest';
import { CAMPAIGN_COMPLAINT_POLICY, CIRCUIT_BREAKER_POLICY } from '../deliverabilityPolicy';

describe('deliverability enforcement policy immutability', () => {
	it('deep-freezes every circuit-breaker policy object', () => {
		expect(Object.isFrozen(CIRCUIT_BREAKER_POLICY)).toBe(true);
		expect(Object.isFrozen(CIRCUIT_BREAKER_POLICY.bounce)).toBe(true);
		expect(Object.isFrozen(CIRCUIT_BREAKER_POLICY.bounce.fast)).toBe(true);
		expect(Object.isFrozen(CIRCUIT_BREAKER_POLICY.bounce.sustained)).toBe(true);
		expect(Object.isFrozen(CIRCUIT_BREAKER_POLICY.complaint)).toBe(true);
		expect(Object.isFrozen(CIRCUIT_BREAKER_POLICY.complaint.fast)).toBe(true);
		expect(Object.isFrozen(CIRCUIT_BREAKER_POLICY.complaint.sustained)).toBe(true);
	});

	it('rejects runtime mutation without changing a breaker threshold', () => {
		const originalThreshold = CIRCUIT_BREAKER_POLICY.bounce.fast.rateExclusiveMax;

		expect(
			Reflect.set(CIRCUIT_BREAKER_POLICY.bounce.fast, 'rateExclusiveMax', originalThreshold + 1)
		).toBe(false);
		expect(CIRCUIT_BREAKER_POLICY.bounce.fast.rateExclusiveMax).toBe(originalThreshold);
	});

	it('freezes and protects the campaign complaint policy', () => {
		const originalThreshold = CAMPAIGN_COMPLAINT_POLICY.rateExclusiveMax;

		expect(Object.isFrozen(CAMPAIGN_COMPLAINT_POLICY)).toBe(true);
		expect(Reflect.set(CAMPAIGN_COMPLAINT_POLICY, 'rateExclusiveMax', originalThreshold + 1)).toBe(
			false
		);
		expect(CAMPAIGN_COMPLAINT_POLICY.rateExclusiveMax).toBe(originalThreshold);
	});
});
