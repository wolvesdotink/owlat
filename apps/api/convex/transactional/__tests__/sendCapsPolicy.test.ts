/**
 * The transactional send caps without the database: the defaults when nothing
 * is stored, the bounds an admin may set, and the verdict for one more send.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TRANSACTIONAL_SEND_CAPS,
	capVerdict,
	describeWindow,
	effectiveSendCaps,
	sendCapsInputError,
} from '../sendCapsPolicy';

const HOUR = 60 * 60 * 1000;

describe('effectiveSendCaps', () => {
	it('runs with 5 per hour per recipient and 50,000 per key and day until an admin saves', () => {
		expect(effectiveSendCaps(undefined)).toEqual({
			perRecipient: { isEnabled: true, count: 5, windowMs: HOUR },
			perApiKeyDaily: { isEnabled: true, count: 50_000 },
		});
	});

	it('uses what the admin saved', () => {
		const stored = {
			perRecipient: { isEnabled: false, count: 9, windowMs: 2 * HOUR },
			perApiKeyDaily: { isEnabled: true, count: 10 },
			updatedAt: 1,
			updatedBy: 'admin',
		};
		expect(effectiveSendCaps(stored)).toEqual({
			perRecipient: stored.perRecipient,
			perApiKeyDaily: stored.perApiKeyDaily,
		});
	});
});

describe('sendCapsInputError', () => {
	const caps = DEFAULT_TRANSACTIONAL_SEND_CAPS;

	it('accepts the defaults and a cap switched off with its count kept', () => {
		expect(sendCapsInputError(caps)).toBeNull();
		expect(
			sendCapsInputError({ ...caps, perApiKeyDaily: { isEnabled: false, count: 50_000 } })
		).toBeNull();
	});

	it('refuses a zero, a fraction, a negative or an absurd count, also on a cap that is off', () => {
		for (const count of [0, 1.5, -3, 1_001]) {
			expect(
				sendCapsInputError({ ...caps, perRecipient: { ...caps.perRecipient, count } })
			).toMatch(/per-recipient cap/);
		}
		expect(sendCapsInputError({ ...caps, perApiKeyDaily: { isEnabled: false, count: 0 } })).toMatch(
			/daily cap/
		);
		expect(
			sendCapsInputError({ ...caps, perApiKeyDaily: { isEnabled: true, count: 10_000_001 } })
		).toMatch(/daily cap/);
	});

	it('takes a window of whole minutes from one minute to seven days', () => {
		const withWindow = (windowMs: number) =>
			sendCapsInputError({ ...caps, perRecipient: { ...caps.perRecipient, windowMs } });
		expect(withWindow(60_000)).toBeNull();
		expect(withWindow(7 * 24 * HOUR)).toBeNull();
		expect(withWindow(30_000)).toMatch(/window/);
		expect(withWindow(90_500)).toMatch(/window/);
		expect(withWindow(8 * 24 * HOUR)).toMatch(/window/);
	});
});

describe('capVerdict', () => {
	it('admits a send while usage stays within the cap', () => {
		expect(capVerdict({ used: 4, cap: 5, drainPerMs: 5 / HOUR, msUntilWindowEnds: 0 })).toEqual({
			ok: true,
		});
	});

	it('waits for a draining allowance to free one send', () => {
		expect(capVerdict({ used: 5, cap: 5, drainPerMs: 5 / HOUR, msUntilWindowEnds: 0 })).toEqual({
			ok: false,
			retryAfterMs: HOUR / 5,
		});
	});

	it('waits out the usage above a cap that was lowered', () => {
		// Usage of five must drain to one before another send fits a cap of two:
		// four sends at two an hour. The rate is a float, so the wait is rounded
		// up to the next whole millisecond.
		expect(capVerdict({ used: 5, cap: 2, drainPerMs: 2 / HOUR, msUntilWindowEnds: 0 })).toEqual({
			ok: false,
			retryAfterMs: expect.closeTo(2 * HOUR, -1),
		});
	});

	it('sends a spent daily cap to the end of its window', () => {
		expect(capVerdict({ used: 10, cap: 10, drainPerMs: null, msUntilWindowEnds: 3_000 })).toEqual({
			ok: false,
			retryAfterMs: 3_000,
		});
	});
});

describe('describeWindow', () => {
	it('names a window the way a refusal reads it', () => {
		expect(describeWindow(HOUR)).toBe('hour');
		expect(describeWindow(6 * HOUR)).toBe('6 hours');
		expect(describeWindow(24 * HOUR)).toBe('day');
		expect(describeWindow(10 * 60_000)).toBe('10 minutes');
	});
});
