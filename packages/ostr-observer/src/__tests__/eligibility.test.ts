import { describe, expect, it } from 'vitest';
import { OBSERVER_MIN_MAILBOXES, assertObserverEligible } from '../eligibility.js';

describe('assertObserverEligible (§7.4)', () => {
	it('defaults to off: an opted-out instance is never an observer', () => {
		expect(assertObserverEligible({ enabled: false, mailboxCount: 5000 })).toEqual({
			eligible: false,
			reason: 'disabled',
			minMailboxes: OBSERVER_MIN_MAILBOXES,
		});
	});

	it('hard-disables a single-mailbox instance — the observer IS the user', () => {
		expect(assertObserverEligible({ enabled: true, mailboxCount: 1 })).toEqual({
			eligible: false,
			reason: 'below-mailbox-threshold',
			minMailboxes: OBSERVER_MIN_MAILBOXES,
		});
		for (let count = 0; count < OBSERVER_MIN_MAILBOXES; count++) {
			expect(assertObserverEligible({ enabled: true, mailboxCount: count }).eligible).toBe(false);
		}
	});

	it('admits an opted-in instance at or above the threshold', () => {
		expect(assertObserverEligible({ enabled: true, mailboxCount: OBSERVER_MIN_MAILBOXES })).toEqual(
			{
				eligible: true,
				mailboxCount: OBSERVER_MIN_MAILBOXES,
				minMailboxes: OBSERVER_MIN_MAILBOXES,
			}
		);
	});

	it('treats an unknown mailbox count as ineligible', () => {
		for (const mailboxCount of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
			expect(assertObserverEligible({ enabled: true, mailboxCount })).toEqual({
				eligible: false,
				reason: 'unknown-mailbox-count',
				minMailboxes: OBSERVER_MIN_MAILBOXES,
			});
		}
		expect(
			assertObserverEligible({
				enabled: true,
				mailboxCount: undefined as unknown as number,
			}).eligible
		).toBe(false);
	});

	it('lets an operator raise the floor but never lower it', () => {
		expect(assertObserverEligible({ enabled: true, mailboxCount: 20, minMailboxes: 50 })).toEqual({
			eligible: false,
			reason: 'below-mailbox-threshold',
			minMailboxes: 50,
		});
		expect(assertObserverEligible({ enabled: true, mailboxCount: 2, minMailboxes: 1 })).toEqual({
			eligible: false,
			reason: 'below-mailbox-threshold',
			minMailboxes: OBSERVER_MIN_MAILBOXES,
		});
	});
});
