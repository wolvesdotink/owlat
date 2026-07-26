import { describe, it, expect } from 'vitest';
import {
	planSeedHygiene,
	shouldRemindSeedRotation,
	SEED_CLICK_PROBABILITY,
	SEED_ROTATION_INTERVAL_MS,
} from '@owlat/shared/seedPlacement';

const DAY = 24 * 60 * 60 * 1000;

/**
 * (d) Seed hygiene is part of the feature, not a follow-up: a seed that never
 * opens anything trains the provider to distrust us.
 */
describe('planSeedHygiene — probes are marked read', () => {
	it('marks a delivered probe read', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: false,
				alreadyClicked: false,
				clickRoll: 0.9,
			})
		).toEqual({ markRead: true, click: false });
	});

	it('marks a probe read wherever it landed — spam and tabs included', () => {
		for (const placement of ['spam', 'category'] as const) {
			expect(
				planSeedHygiene({
					placement,
					alreadyMarkedRead: false,
					alreadyClicked: false,
					clickRoll: 0.99,
				}).markRead
			).toBe(true);
		}
	});

	it('is idempotent — an already-read probe is not marked again', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: true,
				alreadyClicked: false,
				clickRoll: 0.99,
			}).markRead
		).toBe(false);
	});

	it('cannot open a probe that was never found', () => {
		expect(
			planSeedHygiene({
				placement: 'missing',
				alreadyMarkedRead: false,
				alreadyClicked: false,
				clickRoll: 0,
			})
		).toEqual({ markRead: false, click: false });
	});
});

describe('planSeedHygiene — the occasional click', () => {
	it('fires below the click probability', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: false,
				alreadyClicked: false,
				clickRoll: SEED_CLICK_PROBABILITY - 0.01,
			}).click
		).toBe(true);
	});

	it('does not fire at or above it — the click is OCCASIONAL, not every probe', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: false,
				alreadyClicked: false,
				clickRoll: SEED_CLICK_PROBABILITY,
			}).click
		).toBe(false);
	});

	it('never double-clicks the same probe', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: true,
				alreadyClicked: true,
				clickRoll: 0,
			})
		).toEqual({ markRead: false, click: false });
	});

	it('keeps the click rate a minority of probes', () => {
		expect(SEED_CLICK_PROBABILITY).toBeGreaterThan(0);
		expect(SEED_CLICK_PROBABILITY).toBeLessThan(0.5);
	});
});

/** (d) The rotation reminder surfaces on schedule — and is only ever a nudge. */
describe('shouldRemindSeedRotation', () => {
	const connectedAt = 1_700_000_000_000;

	it('stays quiet on a freshly connected seed', () => {
		expect(shouldRemindSeedRotation({ connectedAt, now: connectedAt + 30 * DAY })).toBe(false);
	});

	it('fires once the rotation interval has elapsed since connection', () => {
		expect(
			shouldRemindSeedRotation({ connectedAt, now: connectedAt + SEED_ROTATION_INTERVAL_MS })
		).toBe(true);
	});

	it('restarts the clock from the last reminder, so it does not nag', () => {
		const lastRemindedAt = connectedAt + SEED_ROTATION_INTERVAL_MS;
		expect(
			shouldRemindSeedRotation({ connectedAt, lastRemindedAt, now: lastRemindedAt + DAY })
		).toBe(false);
		expect(
			shouldRemindSeedRotation({
				connectedAt,
				lastRemindedAt,
				now: lastRemindedAt + SEED_ROTATION_INTERVAL_MS,
			})
		).toBe(true);
	});

	it('does not fire on clock skew (a "now" before the connection)', () => {
		expect(shouldRemindSeedRotation({ connectedAt, now: connectedAt - DAY })).toBe(false);
	});
});
