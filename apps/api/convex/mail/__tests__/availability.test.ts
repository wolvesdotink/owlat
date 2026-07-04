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
	parseIcsInstant,
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

describe('parseIcsInstant', () => {
	it('parses a UTC date-time', () => {
		expect(parseIcsInstant('20260708T140000Z')).toEqual({
			ms: Date.UTC(2026, 6, 8, 14, 0, 0),
			allDay: false,
		});
	});
	it('parses a floating date-time as UTC', () => {
		expect(parseIcsInstant('20260708T140000')).toEqual({
			ms: Date.UTC(2026, 6, 8, 14, 0, 0),
			allDay: false,
		});
	});
	it('parses a date-only value as all-day', () => {
		expect(parseIcsInstant('20260708')).toEqual({
			ms: Date.UTC(2026, 6, 8),
			allDay: true,
		});
	});
	it('returns null for junk', () => {
		expect(parseIcsInstant('not-a-date')).toBeNull();
	});
});

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
			async () => ({ ok: true, text: async () => icsBody }) as unknown as Response,
		);
		const slots = await fetchOpenSlots({
			icsUrl: 'https://cal.example.test/private.ics',
			timeZone: 'UTC',
			now: NOW,
			fetchImpl,
		});
		// The module itself performs the fetch (in-deployment), not the caller.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls[0]![0]).toBe('https://cal.example.test/private.ics');
		expect(slots.length).toBeGreaterThan(0);
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
			async () => ({ ok: false, text: async () => '' }) as unknown as Response,
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
			async () => ({ ok: true, text: async () => icsBody }) as unknown as Response,
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
				async () => ({ ok: true, text: async () => icsBody }) as unknown as Response,
			),
		});
		const withoutCal = await buildSchedulingReplyInstruction([], { icsUrl: undefined });
		// With a source the grounded framing differs from the ungrounded one.
		expect(withCal).not.toEqual(withoutCal);
	});
});
