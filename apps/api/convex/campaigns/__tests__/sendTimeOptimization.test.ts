import { describe, expect, it } from 'vitest';
import {
	candidateSlots,
	makeSendTimePlanner,
	resolveSendTimeWindow,
	sendTimeOptimizationFor,
	sendTimeSettingsError,
	type SendTimePlanInput,
} from '../sendTimeOptimization';
import { foldEngagement, type SendTimeHistogram } from '../../analytics/sendTimeProfile';
import { localTimeParts } from '../../lib/emailHelpers';
import { hashFraction } from '../sendVariantSplit';

const HOUR = 3_600_000;
// Wednesday 2026-03-11, 08:00 in Berlin (UTC+1).
const START = Date.UTC(2026, 2, 11, 7, 0);

/** A histogram of `n` opens at one local hour on one weekday. */
function habit(hour: number, n: number, weekday = 3, at = START): SendTimeHistogram {
	let h: SendTimeHistogram | null = null;
	for (let i = 0; i < n; i++) h = foldEngagement(h, { at, kind: 'open', hour, weekday });
	return h!;
}

function input(overrides: Partial<SendTimePlanInput> = {}): SendTimePlanInput {
	return {
		campaignId: 'campaign_1',
		settings: { windowHours: 24, holdoutPercent: 0 },
		window: { startAt: START, endAt: START + 24 * HOUR },
		organization: null,
		defaultTimezone: 'Europe/Berlin',
		startWallClock: { hour: 8, minute: 0 },
		now: START,
		...overrides,
	};
}

describe('send-time settings', () => {
	it('accepts the panel options and refuses anything out of bounds', () => {
		expect(sendTimeSettingsError({ windowHours: 24, holdoutPercent: 10 })).toBeNull();
		expect(sendTimeSettingsError({ windowHours: 72, holdoutPercent: 50 })).toBeNull();
		expect(sendTimeSettingsError({ windowHours: 0, holdoutPercent: 10 })).not.toBeNull();
		expect(sendTimeSettingsError({ windowHours: 73, holdoutPercent: 10 })).not.toBeNull();
		expect(sendTimeSettingsError({ windowHours: 1.5, holdoutPercent: 10 })).not.toBeNull();
		expect(sendTimeSettingsError({ windowHours: 24, holdoutPercent: 51 })).not.toBeNull();
		expect(sendTimeSettingsError({ windowHours: 24, holdoutPercent: -1 })).not.toBeNull();
	});

	it('only optimizes a plain send', () => {
		const campaign = { sendTimeOptimization: { windowHours: 24, holdoutPercent: 10 } };
		expect(sendTimeOptimizationFor(campaign, 'plain')).toEqual(campaign.sendTimeOptimization);
		expect(sendTimeOptimizationFor(campaign, 'ab_test')).toBeUndefined();
		expect(sendTimeOptimizationFor(campaign, 'ab_winner')).toBeUndefined();
		expect(sendTimeOptimizationFor({ ...campaign, isABTest: true }, 'plain')).toBeUndefined();
		expect(sendTimeOptimizationFor({}, 'plain')).toBeUndefined();
	});
});

describe('send-time window', () => {
	it('opens when the campaign started sending', () => {
		expect(
			resolveSendTimeWindow({ sentAt: START, windowHours: 24, now: START + 5 * 60_000 })
		).toEqual({ startAt: START, endAt: START + 24 * HOUR });
	});

	it('starts over from now when a walk outlives its window', () => {
		const now = START + 30 * HOUR;
		expect(resolveSendTimeWindow({ sentAt: START, windowHours: 24, now })).toEqual({
			startAt: now,
			endAt: now + 24 * HOUR,
		});
	});

	it('ends with the day budget so a slice stays in its cap window', () => {
		const midnight = Date.UTC(2026, 2, 12);
		expect(
			resolveSendTimeWindow({
				sentAt: START,
				windowHours: 24,
				now: START,
				dayBudgetEndsAt: midnight,
			})
		).toEqual({ startAt: START, endAt: midnight });
	});
});

describe('candidate slots', () => {
	it('is the start plus every local top of the hour in the window', () => {
		const slots = candidateSlots(
			{ startAt: START + 30 * 60_000, endAt: START + 4 * HOUR },
			'Europe/Berlin'
		);
		expect(slots.map((s) => s.hour)).toEqual([8, 9, 10, 11]);
		expect(slots[0]!.at).toBe(START + 30 * 60_000);
		expect(slots[1]!.at).toBe(START + HOUR);
		expect(slots.every((s) => s.weekday === 3)).toBe(true);
	});

	it('lands on local tops of the hour in a half-hour zone', () => {
		const slots = candidateSlots({ startAt: START, endAt: START + 3 * HOUR }, 'Asia/Kolkata');
		for (const slot of slots.slice(1)) {
			expect(localTimeParts(slot.at, 'Asia/Kolkata').minute).toBe(0);
		}
	});
});

describe('send-time planner', () => {
	it("sends a contact with history at their usual hour, read in the profile's zone", () => {
		const plan = makeSendTimePlanner(input());
		const planned = plan({
			_id: 'contact_a',
			sendTimeProfile: { ...habit(19, 4), timeZone: 'America/New_York' },
		});
		expect(planned.source).toBe('contact');
		expect(planned.group).toBe('optimized');
		expect(localTimeParts(planned.at, 'America/New_York')).toMatchObject({ hour: 19, minute: 0 });
	});

	it('leaves a thin profile to the organization histogram, read in the contact zone', () => {
		const plan = makeSendTimePlanner(input({ organization: habit(12, 40) }));
		const planned = plan({
			_id: 'contact_b',
			timezone: 'Asia/Tokyo',
			sendTimeProfile: { ...habit(19, 1), timeZone: 'Asia/Tokyo' },
		});
		expect(planned.source).toBe('organization');
		expect(localTimeParts(planned.at, 'Asia/Tokyo').hour).toBe(12);
	});

	it('ignores an organization histogram without enough evidence', () => {
		const plan = makeSendTimePlanner(input({ organization: habit(12, 3) }));
		expect(plan({ _id: 'contact_c' }).source).toBe('start');
	});

	it("falls back to the start's wall-clock time in the contact's zone", () => {
		const plan = makeSendTimePlanner(input());
		const planned = plan({ _id: 'contact_d', timezone: 'America/New_York' });
		expect(planned.source).toBe('start');
		expect(localTimeParts(planned.at, 'America/New_York')).toMatchObject({ hour: 8, minute: 0 });
		expect(planned.at).toBeGreaterThanOrEqual(START);
	});

	it('sends at the start when the local start time is outside the window', () => {
		const plan = makeSendTimePlanner(
			input({ window: { startAt: START, endAt: START + 2 * HOUR } })
		);
		const planned = plan({ _id: 'contact_e', timezone: 'America/Los_Angeles' });
		expect(planned).toEqual({ at: START, source: 'start', group: 'optimized' });
	});

	it('decays history: an old habit no longer counts as evidence', () => {
		const old = { ...habit(19, 4, 3, START - 400 * 24 * HOUR), timeZone: 'Europe/Berlin' };
		const plan = makeSendTimePlanner(input());
		expect(plan({ _id: 'contact_f', sendTimeProfile: old }).source).toBe('start');
	});

	it('holds out a deterministic share at the start time', () => {
		const settings = { windowHours: 24, holdoutPercent: 20 };
		const plan = makeSendTimePlanner(input({ settings }));
		// Id-shaped keys: 32 characters from a seeded generator, like Convex ids.
		let seed = 42;
		const nextChar = () => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return 'abcdefghijklmnopqrstuvwxyz0123456789'[seed % 36]!;
		};
		const ids = Array.from({ length: 2000 }, () => Array.from({ length: 32 }, nextChar).join(''));
		const held = ids.filter((id) => plan({ _id: id }).group === 'holdout');
		expect(held.length / ids.length).toBeGreaterThan(0.17);
		expect(held.length / ids.length).toBeLessThan(0.23);
		for (const id of held) {
			expect(plan({ _id: id })).toEqual({ at: START, source: 'holdout', group: 'holdout' });
			expect(hashFraction('sto:campaign_1', id)).toBeLessThan(0.2);
		}
		// The same campaign and contact always land in the same group.
		const again = makeSendTimePlanner(input({ settings }));
		expect(ids.filter((id) => again({ _id: id }).group === 'holdout')).toEqual(held);
	});

	it('prefers the weekday a contact reads on when the window spans days', () => {
		// Reads at 9:00, mostly on Thursdays (weekday 4).
		let h: SendTimeHistogram | null = null;
		for (let i = 0; i < 5; i++)
			h = foldEngagement(h, { at: START, kind: 'open', hour: 9, weekday: 4 });
		h = foldEngagement(h, { at: START, kind: 'open', hour: 9, weekday: 3 });
		const plan = makeSendTimePlanner(
			input({ window: { startAt: START, endAt: START + 48 * HOUR } })
		);
		const planned = plan({
			_id: 'contact_g',
			sendTimeProfile: { ...h!, timeZone: 'Europe/Berlin' },
		});
		expect(localTimeParts(planned.at, 'Europe/Berlin')).toMatchObject({ hour: 9, weekday: 4 });
	});
});
