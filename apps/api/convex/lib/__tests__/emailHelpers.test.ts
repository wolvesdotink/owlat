import { describe, it, expect } from 'vitest';
import { resolveNextSendTime, isValidTimeZone } from '../emailHelpers';

/** The local wall-clock {hour, minute} an instant maps to in a given zone. */
function localHourMinute(instant: number, timeZone: string): { hour: number; minute: number } {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).formatToParts(new Date(instant));
	const hour = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
	const minute = Number(parts.find((p) => p.type === 'minute')!.value);
	return { hour, minute };
}

describe('isValidTimeZone', () => {
	it('accepts real IANA zones, rejects junk/empty/undefined', () => {
		expect(isValidTimeZone('Europe/Berlin')).toBe(true);
		expect(isValidTimeZone('America/New_York')).toBe(true);
		expect(isValidTimeZone('UTC')).toBe(true);
		expect(isValidTimeZone('Mars/Olympus')).toBe(false);
		expect(isValidTimeZone('')).toBe(false);
		expect(isValidTimeZone(undefined)).toBe(false);
	});
});

describe('resolveNextSendTime', () => {
	it('resolves to the requested local wall-clock time in the zone (the whole point)', () => {
		const now = Date.UTC(2026, 0, 15, 3, 0, 0); // arbitrary winter instant
		for (const zone of ['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland']) {
			const target = resolveNextSendTime(zone, 9, 30, now);
			expect(localHourMinute(target, zone)).toEqual({ hour: 9, minute: 30 });
			expect(target).toBeGreaterThan(now);
		}
	});

	it('is DST-correct: the same 9am-local resolves to a different UTC hour across DST', () => {
		const zone = 'Europe/Berlin';
		// Winter (CET, +1): 9am local → 08:00 UTC. Summer (CEST, +2): 9am → 07:00 UTC.
		const winter = resolveNextSendTime(zone, 9, 0, Date.UTC(2026, 0, 10, 0, 0, 0));
		const summer = resolveNextSendTime(zone, 9, 0, Date.UTC(2026, 6, 10, 0, 0, 0));
		expect(new Date(winter).getUTCHours()).toBe(8);
		expect(new Date(summer).getUTCHours()).toBe(7);
		// And both still read 9am in the zone.
		expect(localHourMinute(winter, zone).hour).toBe(9);
		expect(localHourMinute(summer, zone).hour).toBe(9);
	});

	it('rolls to tomorrow when the local time has already passed today', () => {
		const zone = 'UTC';
		const now = Date.UTC(2026, 2, 20, 10, 0, 0); // 10:00 UTC
		const target = resolveNextSendTime(zone, 9, 0, now); // 9am already passed
		expect(target).toBeGreaterThan(now);
		expect(target - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
		expect(localHourMinute(target, zone)).toEqual({ hour: 9, minute: 0 });
	});

	it('falls back to UTC for unknown/invalid zones', () => {
		const now = Date.UTC(2026, 0, 15, 3, 0, 0);
		const target = resolveNextSendTime('Mars/Olympus', 9, 0, now);
		expect(localHourMinute(target, 'UTC')).toEqual({ hour: 9, minute: 0 });
	});
});
