import { describe, it, expect } from 'vitest';
import { classifyBounceMessage } from '../bounceClassification';

describe('classifyBounceMessage', () => {
	it('classifies permanent failures as hard', () => {
		for (const msg of [
			'user unknown',
			'Mailbox not found',
			'account has been disabled',
			'user not found',
			'mailbox unavailable',
			'relay denied',
			'5.1.1 address does not exist',
		]) {
			expect(classifyBounceMessage(msg)).toBe('hard');
		}
	});

	it('classifies temporary failures as soft', () => {
		for (const msg of [
			'mailbox full',
			'over quota',
			'try again later',
			'greylisted',
			'4.2.2 temporarily deferred',
		]) {
			expect(classifyBounceMessage(msg)).toBe('soft');
		}
	});

	it('biases toward soft for ties and unknown text', () => {
		expect(classifyBounceMessage('rejected, try again later')).toBe('soft');
		expect(classifyBounceMessage('something weird happened')).toBe('soft');
		expect(classifyBounceMessage('')).toBe('soft');
	});
});
