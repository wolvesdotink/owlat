/**
 * When a "Waiting on others" item asks for a nudge (SPEC §7, mail/nudges.ts):
 * past its due date, or 3 business days old with no reply since, a weekend
 * not counting.
 */

import { describe, expect, it } from 'vitest';
import { addBusinessDays, nudgeVerdict } from '../nudges';

const HOUR = 60 * 60 * 1000;
/** Thursday 2026-10-15, 10:00 UTC. */
const THURSDAY = Date.UTC(2026, 9, 15, 10);
const FRIDAY = THURSDAY + 24 * HOUR;
const MONDAY = THURSDAY + 4 * 24 * HOUR;
const TUESDAY = THURSDAY + 5 * 24 * HOUR;

describe('addBusinessDays', () => {
	it('skips the weekend', () => {
		expect(new Date(addBusinessDays(THURSDAY, 3)).toISOString()).toBe('2026-10-20T10:00:00.000Z');
		expect(addBusinessDays(THURSDAY, 3)).toBe(TUESDAY);
	});

	it('counts from a Saturday as from the weekend', () => {
		const saturday = THURSDAY + 2 * 24 * HOUR;
		expect(new Date(addBusinessDays(saturday, 3)).getUTCDay()).toBe(3); // Wednesday
	});
});

describe('nudgeVerdict', () => {
	it('asks once the due date passed', () => {
		const dueAt = FRIDAY;
		expect(nudgeVerdict({ dueAt, askedAt: THURSDAY, now: FRIDAY - HOUR })).toBeNull();
		expect(nudgeVerdict({ dueAt, askedAt: THURSDAY, now: FRIDAY + HOUR })).toEqual({
			reason: 'overdue',
			at: dueAt,
		});
	});

	it('asks after 3 business days, a weekend in between not counting', () => {
		// Four calendar days later, but only two business days.
		expect(nudgeVerdict({ askedAt: THURSDAY, now: MONDAY + HOUR })).toBeNull();
		expect(nudgeVerdict({ askedAt: THURSDAY, now: TUESDAY })).toEqual({
			reason: 'stale',
			at: TUESDAY,
		});
	});

	it('is cancelled by a reply from them', () => {
		expect(
			nudgeVerdict({ askedAt: THURSDAY, lastInboundAt: FRIDAY, now: TUESDAY + HOUR })
		).toBeNull();
		// The message the item was read from is not a reply to it.
		expect(
			nudgeVerdict({ askedAt: THURSDAY, lastInboundAt: THURSDAY, now: TUESDAY + HOUR })
		).not.toBeNull();
	});

	it('keeps an overdue nudge when their last word came before the deadline', () => {
		const dueAt = MONDAY;
		expect(nudgeVerdict({ dueAt, askedAt: THURSDAY, lastInboundAt: FRIDAY, now: TUESDAY })).toEqual(
			{ reason: 'overdue', at: dueAt }
		);
		expect(
			nudgeVerdict({ dueAt, askedAt: THURSDAY, lastInboundAt: MONDAY + HOUR, now: TUESDAY })
		).toBeNull();
	});

	it('waits 3 business days after a message of ours (a nudge already sent)', () => {
		const signals = { askedAt: THURSDAY, lastOwnAt: TUESDAY };
		expect(nudgeVerdict({ ...signals, now: TUESDAY + 2 * 24 * HOUR })).toBeNull();
		expect(nudgeVerdict({ ...signals, now: addBusinessDays(TUESDAY, 3) })?.reason).toBe('stale');
	});
});
