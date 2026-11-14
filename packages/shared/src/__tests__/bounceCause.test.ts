import { describe, expect, it } from 'vitest';
import {
	causeCodeOf,
	enhancedCodeCause,
	relayBounceCause,
	smtpReplyEnhancedCode,
} from '../bounceCause';

describe('enhancedCodeCause', () => {
	it.each([
		['5.1.1', 'recipient'],
		['5.2.2', 'recipient'],
		['5.1.7', 'sender'],
		['5.7.1', 'sender'],
		['4.7.26', 'sender'],
		['5.7.13', 'recipient'],
		['5.0.0', undefined],
		['4.4.7', undefined],
		['not-a-code', undefined],
	] as const)('%s → %s', (code, cause) => {
		expect(enhancedCodeCause(code)).toBe(cause);
	});
});

describe('smtpReplyEnhancedCode', () => {
	it.each([
		['smtp; 550 5.1.1 user unknown', '5.1.1'],
		['smtp;554 5.7.1 blocked', '5.7.1'],
		['550-5.7.26 unauthenticated', '5.7.26'],
		['452 4.2.2 over quota', '4.2.2'],
		['smtp; 550 user unknown', undefined],
		// A code in the prose, not after the reply code, is not read.
		['Your message to x was rejected (see 5.7.1)', undefined],
		['X-Postfix; unknown user', undefined],
	])('%s → %s', (diagnostic, code) => {
		expect(smtpReplyEnhancedCode(diagnostic)).toBe(code);
	});
});

describe('causeCodeOf', () => {
	it('keeps a specific Status', () => {
		expect(causeCodeOf('5.1.1', 'smtp; 550 5.7.1 blocked')).toBe('5.1.1');
	});

	it('reads the remote reply behind a generic X.0.0 Status', () => {
		expect(causeCodeOf('5.0.0', 'smtp; 554 5.7.1 blocked')).toBe('5.7.1');
		expect(causeCodeOf('5.0.0', 'smtp; 550 user unknown')).toBe('5.0.0');
		expect(causeCodeOf(undefined, 'smtp; 550 5.1.1 user unknown')).toBe('5.1.1');
	});
});

describe('relayBounceCause', () => {
	it("keeps the relay's own verdict on a named party", () => {
		expect(relayBounceCause('sender', '5.1.1')).toBe('sender');
		expect(relayBounceCause('recipient', '5.7.1')).toBe('recipient');
	});

	it('lets a code that names a party decide the rest', () => {
		expect(relayBounceCause('address-failed', '5.7.1')).toBe('sender');
		expect(relayBounceCause('unattributed', '4.2.2')).toBe('recipient');
	});

	it('blames the address only when the relay reported it failed', () => {
		expect(relayBounceCause('address-failed', '5.0.0')).toBe('recipient');
		expect(relayBounceCause('unattributed', undefined)).toBe('sender');
	});
});
