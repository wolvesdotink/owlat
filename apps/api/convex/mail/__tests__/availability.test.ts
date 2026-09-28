/**
 * Unit tests for free/busy availability grounding (mail/availability).
 *
 * Covers the pure ICS parse + open-slot computation + labelling, and the
 * fail-soft fetch seam. The fetch is INJECTED (never a real network) so we can
 * assert the source is read server-side, in-deployment, and that any missing
 * config / error degrades to an empty slot list (today's behaviour).
 */
import { describe, it, expect, vi } from 'vitest';
import {
	parseIcsBusyIntervals,
	computeOpenSlots,
	formatOpenSlots,
	fetchOpenSlots,
	buildSchedulingReplyInstruction,
	type BusyInterval,
} from '../availability';

const HOUR = 60 * 60 * 1000;
// A fixed instant to anchor the horizon deterministically.
const NOW = Date.UTC(2026, 6, 6, 12, 0, 0); // 2026-07-06 12:00 UTC

describe('parseIcsBusyIntervals', () => {
	it('extracts DTSTART/DTEND busy ranges and ignores event content', () => {
		const ics = [
			'BEGIN:VCALENDAR',
			'BEGIN:VEVENT',
			'SUMMARY:Secret standup',
			'DTSTART:20260708T140000Z',
			'DTEND:20260708T150000Z',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		expect(parseIcsBusyIntervals(ics)).toEqual([
			{ start: Date.UTC(2026, 6, 8, 14), end: Date.UTC(2026, 6, 8, 15) },
		]);
	});

	it('defaults a missing end to a one-hour block', () => {
		const ics = 'BEGIN:VEVENT\nDTSTART:20260708T140000Z\nEND:VEVENT';
		expect(parseIcsBusyIntervals(ics)).toEqual([
			{ start: Date.UTC(2026, 6, 8, 14), end: Date.UTC(2026, 6, 8, 15) },
		]);
	});

	it('treats an all-day event as a full-day busy block', () => {
		const ics = 'BEGIN:VEVENT\nDTSTART;VALUE=DATE:20260708\nEND:VEVENT';
		expect(parseIcsBusyIntervals(ics)).toEqual([
			{ start: Date.UTC(2026, 6, 8), end: Date.UTC(2026, 6, 9) },
		]);
	});

	it('reads floating times in UTC by default', () => {
		const ics = 'BEGIN:VEVENT\nDTSTART:20260708T140000\nDTEND:20260708T150000\nEND:VEVENT';
		expect(parseIcsBusyIntervals(ics)).toEqual([
			{ start: Date.UTC(2026, 6, 8, 14), end: Date.UTC(2026, 6, 8, 15) },
		]);
	});

	it('reads floating and all-day times in the given calendar zone', () => {
		const ics = [
			'BEGIN:VEVENT',
			'DTSTART:20260708T140000',
			'DTEND:20260708T150000',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'DTSTART;VALUE=DATE:20260709',
			'END:VEVENT',
		].join('\r\n');
		// Berlin is UTC+2 in July.
		expect(parseIcsBusyIntervals(ics, 'Europe/Berlin')).toEqual([
			{ start: Date.UTC(2026, 6, 8, 12), end: Date.UTC(2026, 6, 8, 13) },
			{ start: Date.UTC(2026, 6, 8, 22), end: Date.UTC(2026, 6, 9, 22) },
		]);
	});

	it('converts a TZID event from its own zone to the right UTC interval', () => {
		const ics = [
			'BEGIN:VCALENDAR',
			'BEGIN:VEVENT',
			'DTSTART;TZID=Europe/Berlin:20260708T140000',
			'DTEND;TZID=Europe/Berlin:20260708T153000',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		// 14:00 CEST is 12:00 UTC, whatever the calendar zone is.
		const expected = [{ start: Date.UTC(2026, 6, 8, 12), end: Date.UTC(2026, 6, 8, 13, 30) }];
		expect(parseIcsBusyIntervals(ics)).toEqual(expected);
		expect(parseIcsBusyIntervals(ics, 'America/New_York')).toEqual(expected);
	});

	it('accepts a lowercase feed', () => {
		const ics = [
			'begin:vcalendar',
			'begin:vevent',
			'dtstart:20260708T140000Z',
			'dtend:20260708T150000Z',
			'end:vevent',
			'end:vcalendar',
		].join('\r\n');
		expect(parseIcsBusyIntervals(ics)).toEqual([
			{ start: Date.UTC(2026, 6, 8, 14), end: Date.UTC(2026, 6, 8, 15) },
		]);
	});

	it('drops events whose end is not after their start, and unparseable starts', () => {
		const ics = [
			'BEGIN:VEVENT',
			'DTSTART:20260708T150000Z',
			'DTEND:20260708T140000Z',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'DTSTART:not-a-date',
			'END:VEVENT',
		].join('\n');
		expect(parseIcsBusyIntervals(ics)).toEqual([]);
	});

	it('caps the number of busy intervals', () => {
		const event = 'BEGIN:VEVENT\nDTSTART:20260708T140000Z\nEND:VEVENT';
		const ics = Array.from({ length: 2100 }, () => event).join('\n');
		expect(parseIcsBusyIntervals(ics)).toHaveLength(2000);
	});

	it('unfolds RFC 5545 folded lines', () => {
		const ics = 'BEGIN:VEVENT\r\nDTSTART:20260708T1400\r\n 00Z\r\nEND:VEVENT';
		expect(parseIcsBusyIntervals(ics)).toEqual([
			{ start: Date.UTC(2026, 6, 8, 14), end: Date.UTC(2026, 6, 8, 15) },
		]);
	});
});

describe('computeOpenSlots', () => {
	it('offers weekday business-hours slots when the calendar is empty', () => {
		const slots = computeOpenSlots([], NOW, 'UTC');
		expect(slots).toHaveLength(3);
		for (const s of slots) {
			expect(s.end - s.start).toBe(HOUR);
			expect(s.start).toBeGreaterThan(NOW);
			const hour = new Date(s.start).getUTCHours();
			expect(hour).toBeGreaterThanOrEqual(9);
			expect(hour).toBeLessThan(17);
			const weekday = new Date(s.start).getUTCDay();
			expect(weekday).not.toBe(0);
			expect(weekday).not.toBe(6);
		}
		// Ascending in time.
		expect(slots[1]!.start).toBeGreaterThan(slots[0]!.start);
	});

	it('skips slots that overlap busy intervals', () => {
		// Block the entire horizon so nothing is free.
		const busy: BusyInterval[] = [{ start: NOW, end: NOW + 60 * 24 * HOUR }];
		expect(computeOpenSlots(busy, NOW, 'UTC')).toEqual([]);
	});

	it('never returns a slot overlapping a specific busy block', () => {
		const open = computeOpenSlots([], NOW, 'UTC');
		expect(open.length).toBeGreaterThan(0);
		const firstStart = open[0]!.start;
		// Mark that first free slot busy; it must then be excluded.
		const busy: BusyInterval[] = [{ start: firstStart, end: firstStart + HOUR }];
		const after = computeOpenSlots(busy, NOW, 'UTC');
		for (const s of after) {
			expect(s.start).not.toBe(firstStart);
		}
	});
});

describe('formatOpenSlots', () => {
	it('renders human labels in the owner timezone', () => {
		const label = formatOpenSlots([{ start: Date.UTC(2026, 6, 8, 14), end: 0 }], 'UTC');
		expect(label[0]).toContain('Jul 8');
		expect(label[0]).toContain('2:00');
	});
});

describe('fetchOpenSlots (fail-soft, in-deployment)', () => {
	const icsBody = [
		'BEGIN:VCALENDAR',
		'BEGIN:VEVENT',
		'DTSTART:20260708T140000Z',
		'DTEND:20260708T150000Z',
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n');

	it('fetches the configured feed server-side and returns concrete labels', async () => {
		const fetchImpl = vi.fn(
			async () => ({ ok: true, text: async () => icsBody }) as unknown as Response
		);
		const slots = await fetchOpenSlots({
			icsUrl: 'https://cal.example.test/private.ics',
			timeZone: 'UTC',
			now: NOW,
			fetchImpl,
		});
		// The module itself performs the fetch (in-deployment), not the caller.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((fetchImpl.mock.calls[0]! as unknown[])[0]).toBe('https://cal.example.test/private.ics');
		expect(slots.length).toBeGreaterThan(0);
	});

	it('masks a lowercase feed with TZID events in the owner zone', async () => {
		// Monday 2026-07-06 12:00 UTC is 14:00 in Berlin; the next slot is 15:00.
		const blockRestOfMonday = [
			'begin:vcalendar',
			'begin:vevent',
			'dtstart;tzid=Europe/Berlin:20260706T150000',
			'dtend;tzid=Europe/Berlin:20260706T170000',
			'end:vevent',
			'end:vcalendar',
		].join('\r\n');
		const fetchImpl = vi.fn(
			async () => ({ ok: true, text: async () => blockRestOfMonday }) as unknown as Response
		);
		const slots = await fetchOpenSlots({
			icsUrl: 'https://cal.example.test/private.ics',
			timeZone: 'Europe/Berlin',
			now: NOW,
			fetchImpl,
		});
		expect(slots).toHaveLength(3);
		for (const label of slots) expect(label).not.toContain('Jul 6');
		expect(slots[0]).toContain('Jul 7');
		expect(slots[0]).toContain('9:00');
	});

	it('returns [] and never fetches when no source is configured', async () => {
		const fetchImpl = vi.fn();
		const slots = await fetchOpenSlots({ icsUrl: undefined, fetchImpl });
		expect(slots).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('degrades to [] on a network error', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('unreachable');
		});
		const slots = await fetchOpenSlots({
			icsUrl: 'https://cal.example.test/private.ics',
			fetchImpl,
		});
		expect(slots).toEqual([]);
	});

	it('degrades to [] on a non-ok response', async () => {
		const fetchImpl = vi.fn(
			async () => ({ ok: false, text: async () => '' }) as unknown as Response
		);
		const slots = await fetchOpenSlots({
			icsUrl: 'https://cal.example.test/private.ics',
			fetchImpl,
		});
		expect(slots).toEqual([]);
	});
});

describe('buildSchedulingReplyInstruction (fetch + framing orchestration)', () => {
	const icsBody = [
		'BEGIN:VCALENDAR',
		'BEGIN:VEVENT',
		'DTSTART:20260708T140000Z',
		'DTEND:20260708T150000Z',
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n');

	it('folds the owner real open slots into the scheduling instruction', async () => {
		const fetchImpl = vi.fn(
			async () => ({ ok: true, text: async () => icsBody }) as unknown as Response
		);
		const instruction = await buildSchedulingReplyInstruction(['maybe Thursday?'], {
			icsUrl: 'https://cal.example.test/private.ics',
			timeZone: 'UTC',
			now: NOW,
			fetchImpl,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// Untrusted sender phrase is carried through verbatim.
		expect(instruction).toContain('maybe Thursday?');
	});

	it('degrades to today sender-phrase-only framing when no source is configured', async () => {
		const withCal = await buildSchedulingReplyInstruction([], {
			icsUrl: 'https://cal.example.test/private.ics',
			timeZone: 'UTC',
			now: NOW,
			fetchImpl: vi.fn(
				async () => ({ ok: true, text: async () => icsBody }) as unknown as Response
			),
		});
		const withoutCal = await buildSchedulingReplyInstruction([], { icsUrl: undefined });
		// With a source the grounded framing differs from the ungrounded one.
		expect(withCal).not.toEqual(withoutCal);
	});
});
