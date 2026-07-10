import { describe, it, expect } from 'vitest';
import { deriveMailboxGuardState, type MailboxGuardInput } from '../freshStart';

const base: MailboxGuardInput = {
	loading: false,
	hasMailbox: false,
	reservedAddress: null,
	externalAllowed: false,
};

describe('deriveMailboxGuardState — reserved / external-allowed / dead-end', () => {
	it('is loading while the status query is unresolved (wins over everything)', () => {
		expect(
			deriveMailboxGuardState({
				...base,
				loading: true,
				hasMailbox: true,
				reservedAddress: 'me@acme.test',
				externalAllowed: true,
			})
		).toBe('loading');
	});

	it('is ready when a live mailbox exists', () => {
		expect(deriveMailboxGuardState({ ...base, hasMailbox: true })).toBe('ready');
	});

	it('a live mailbox wins over an unclaimed reservation', () => {
		expect(
			deriveMailboxGuardState({
				...base,
				hasMailbox: true,
				reservedAddress: 'me@acme.test',
			})
		).toBe('ready');
	});

	it('is reserved when a hosted mailbox is reserved but unclaimed', () => {
		expect(deriveMailboxGuardState({ ...base, reservedAddress: 'me@acme.test' })).toBe('reserved');
	});

	it('a reservation wins over the external escape hatch', () => {
		expect(
			deriveMailboxGuardState({
				...base,
				reservedAddress: 'me@acme.test',
				externalAllowed: true,
			})
		).toBe('reserved');
	});

	it('is external-allowed when no mailbox/reservation but external is enabled', () => {
		expect(deriveMailboxGuardState({ ...base, externalAllowed: true })).toBe('external-allowed');
	});

	it('is a dead-end when nothing is possible without an admin', () => {
		expect(deriveMailboxGuardState(base)).toBe('dead-end');
	});

	it('treats an empty reservation string as no reservation', () => {
		expect(deriveMailboxGuardState({ ...base, reservedAddress: '' })).toBe('dead-end');
	});
});
