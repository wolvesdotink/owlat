/**
 * Schedule-send preset math (plan idea 9). Pure and offset-driven, so the whole
 * "emailing Berlin from San Francisco" case is testable without a browser or a
 * TZ env var.
 *
 * Covers: the weekday-aware third row (a Friday send offers Monday rather than
 * letting the message rot over the weekend, while midweek the list is exactly
 * the three rows it always had), the dedupe that stops one instant being
 * offered under two labels, the recipient-anchored preset appearing ONLY when
 * their zone is known, and the silent degradation when it is not.
 */
import { describe, it, expect } from 'vitest';
import {
	buildSchedulePresets,
	soleRecipientTimeZone,
	zoneOffsetMinutes,
} from '../postboxSchedulePresets';

/** UTC helpers: every `now` below is stated in UTC and read back in UTC. */
const utc = (y: number, m: number, d: number, h = 12): number => Date.UTC(y, m - 1, d, h);
const hourAt = (at: number, offsetMinutes: number): number =>
	new Date(at + offsetMinutes * 60_000).getUTCHours();
const dayAt = (at: number, offsetMinutes: number): number =>
	new Date(at + offsetMinutes * 60_000).getUTCDay();

// 2026-08-25 is a Tuesday; 2026-08-28 a Friday; 2026-08-30 a Sunday.
const TUESDAY = utc(2026, 8, 25);
const FRIDAY = utc(2026, 8, 28);
const SUNDAY = utc(2026, 8, 30);

const ids = (presets: ReturnType<typeof buildSchedulePresets>) => presets.map((p) => p.id);

describe('buildSchedulePresets — sender clock only', () => {
	it('midweek keeps the three rows it always had, third one being next Monday', () => {
		const presets = buildSchedulePresets({ now: TUESDAY, senderOffsetMinutes: 0 });
		// The weekday row on a Tuesday IS tomorrow, so it dedupes away and the
		// "start of next week" row keeps the third slot.
		expect(ids(presets)).toEqual(['tomorrowMorning', 'tomorrowAfternoon', 'nextMondayMorning']);
		expect(hourAt(presets[0]!.at, 0)).toBe(9);
		expect(hourAt(presets[1]!.at, 0)).toBe(13);
		expect(dayAt(presets[2]!.at, 0)).toBe(1);
	});

	it('resolves the weekday preset to Monday for a Friday send — no weekend rot', () => {
		const presets = buildSchedulePresets({ now: FRIDAY, senderOffsetMinutes: 0 });
		const weekday = presets.find((p) => p.id === 'nextWeekdayMorning');
		expect(weekday?.weekday).toBe(1);
		expect(dayAt(weekday!.at, 0)).toBe(1);
		expect(hourAt(weekday!.at, 0)).toBe(9);
		// The Saturday presets are still offered — some people do want Saturday.
		expect(dayAt(presets[0]!.at, 0)).toBe(6);
	});

	it('resolves it to Monday for a Saturday send too', () => {
		const saturday = utc(2026, 8, 29);
		const weekday = buildSchedulePresets({ now: saturday, senderOffsetMinutes: 0 }).find(
			(p) => p.id === 'nextWeekdayMorning'
		);
		expect(dayAt(weekday!.at, 0)).toBe(1);
	});

	it('never offers the same instant twice under two labels', () => {
		// Sunday: tomorrow, the next weekday and the next Monday are all Monday
		// 9:00 — a duplicate the dialog used to render twice.
		const presets = buildSchedulePresets({ now: SUNDAY, senderOffsetMinutes: 0 });
		expect(ids(presets)).toEqual(['tomorrowMorning', 'tomorrowAfternoon']);
		expect(presets).toHaveLength(2);
		expect(new Set(presets.map((p) => p.at)).size).toBe(presets.length);
	});

	it('always lands in the future, never earlier today', () => {
		const lateFriday = utc(2026, 8, 28, 23);
		for (const preset of buildSchedulePresets({ now: lateFriday, senderOffsetMinutes: 0 })) {
			expect(preset.at).toBeGreaterThan(lateFriday);
		}
	});

	it('reads the wall clock in the SENDER offset, not UTC', () => {
		// UTC-7: Tuesday 12:00 UTC is Tuesday 05:00 local, so "tomorrow 9:00
		// local" is Wednesday 16:00 UTC.
		const presets = buildSchedulePresets({ now: TUESDAY, senderOffsetMinutes: -420 });
		expect(hourAt(presets[0]!.at, -420)).toBe(9);
		expect(new Date(presets[0]!.at).getUTCHours()).toBe(16);
	});
});

describe('buildSchedulePresets — recipient timezone known', () => {
	// The plan's case: sender in San Francisco (UTC-7), recipient in Berlin (UTC+2).
	const SF = -420;
	const BERLIN = 120;

	it('adds a preset anchored on the recipient morning, first in the list', () => {
		const presets = buildSchedulePresets({
			now: TUESDAY,
			senderOffsetMinutes: SF,
			recipientOffsetMinutes: BERLIN,
		});
		expect(presets[0]?.id).toBe('recipientMorning');
		expect(presets[0]?.anchor).toBe('recipient');
		// 9:00 in THEIR clock…
		expect(hourAt(presets[0]!.at, BERLIN)).toBe(9);
		// …which is the previous evening in the sender's — the whole point.
		expect(hourAt(presets[0]!.at, SF)).toBe(0);
	});

	it('aims at their NEXT 9:00, skipping no day when it is still ahead of us', () => {
		// 04:00 UTC Tuesday: Berlin is 06:00 Tuesday, so their 9:00 is TODAY.
		const earlyTuesday = utc(2026, 8, 25, 4);
		const [first] = buildSchedulePresets({
			now: earlyTuesday,
			senderOffsetMinutes: SF,
			recipientOffsetMinutes: BERLIN,
		});
		expect(first?.id).toBe('recipientMorning');
		expect(first!.at).toBeGreaterThan(earlyTuesday);
		expect(dayAt(first!.at, BERLIN)).toBe(2); // still Tuesday, their time
	});

	it('leaves the sender-clock presets untouched alongside it', () => {
		const presets = buildSchedulePresets({
			now: TUESDAY,
			senderOffsetMinutes: SF,
			recipientOffsetMinutes: BERLIN,
		});
		const withoutRecipient = buildSchedulePresets({ now: TUESDAY, senderOffsetMinutes: SF });
		expect(presets.filter((p) => p.anchor === 'sender')).toEqual(withoutRecipient);
	});

	it('drops the recipient preset when both clocks land on the same instant', () => {
		const presets = buildSchedulePresets({
			now: TUESDAY,
			senderOffsetMinutes: 0,
			recipientOffsetMinutes: 0,
		});
		expect(ids(presets)).toEqual(['recipientMorning', 'tomorrowAfternoon', 'nextMondayMorning']);
		// The duplicate is gone, not doubled: same instant, offered once.
		expect(new Set(presets.map((p) => p.at)).size).toBe(presets.length);
	});

	it('degrades silently to today’s presets when the timezone is unknown', () => {
		for (const unknown of [null, undefined]) {
			const presets = buildSchedulePresets({
				now: TUESDAY,
				senderOffsetMinutes: SF,
				recipientOffsetMinutes: unknown,
			});
			expect(ids(presets)).toEqual(['tomorrowMorning', 'tomorrowAfternoon', 'nextMondayMorning']);
		}
	});
});

describe('zoneOffsetMinutes', () => {
	it('resolves a real zone at a real instant', () => {
		// Berlin is on CEST (UTC+2) in late August, CET (UTC+1) in January.
		expect(zoneOffsetMinutes('Europe/Berlin', utc(2026, 8, 25))).toBe(120);
		expect(zoneOffsetMinutes('Europe/Berlin', utc(2026, 1, 15))).toBe(60);
	});

	it('handles a zone west of UTC, and UTC itself', () => {
		expect(zoneOffsetMinutes('America/Los_Angeles', utc(2026, 8, 25))).toBe(-420);
		expect(zoneOffsetMinutes('UTC', utc(2026, 8, 25))).toBe(0);
	});

	it('handles a half-hour zone', () => {
		expect(zoneOffsetMinutes('Asia/Kolkata', utc(2026, 8, 25))).toBe(330);
	});

	it('reads midnight correctly rather than as hour 24', () => {
		// 00:00 in Berlin on a CEST day is 22:00 UTC the day before.
		expect(zoneOffsetMinutes('Europe/Berlin', Date.UTC(2026, 7, 24, 22, 0, 0))).toBe(120);
	});

	it('returns null for a zone the runtime does not know', () => {
		expect(zoneOffsetMinutes('Mars/Olympus_Mons', utc(2026, 8, 25))).toBeNull();
	});
});

describe('soleRecipientTimeZone', () => {
	it('answers only when every known recipient shares one zone', () => {
		expect(
			soleRecipientTimeZone([
				{ address: 'a@x.test', timeZone: 'Europe/Berlin' },
				{ address: 'b@x.test', timeZone: 'Europe/Berlin' },
			])
		).toBe('Europe/Berlin');
	});

	it('says nothing when the recipients are spread across zones', () => {
		expect(
			soleRecipientTimeZone([
				{ address: 'a@x.test', timeZone: 'Europe/Berlin' },
				{ address: 'b@x.test', timeZone: 'America/New_York' },
			])
		).toBeNull();
	});

	it('says nothing when nobody has a timezone on record', () => {
		expect(soleRecipientTimeZone([])).toBeNull();
	});
});
