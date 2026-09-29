import { describe, it, expect } from 'vitest';
import {
	parseICalendar,
	buildReplyICalendar,
	icalDateTimeToEpoch,
	wallClockToEpoch,
	type ICalDateTime,
} from '../ical';

const INVITE = [
	'BEGIN:VCALENDAR',
	'METHOD:REQUEST',
	'BEGIN:VEVENT',
	'UID:abc-123',
	'SUMMARY:Team sync',
	'DESCRIPTION:Weekly\\nstandup',
	'LOCATION:Room 1',
	'DTSTART:20260115T140000Z',
	'DTEND:20260115T150000Z',
	'SEQUENCE:2',
	'ORGANIZER;CN=Alice:mailto:alice@example.com',
	'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com',
	'END:VEVENT',
	'END:VCALENDAR',
].join('\r\n');

describe('parseICalendar', () => {
	it('parses a VEVENT invite', () => {
		const cal = parseICalendar(INVITE);
		expect(cal.method).toBe('REQUEST');
		expect(cal.events).toHaveLength(1);
		const e = cal.events[0]!;
		expect(e.summary).toBe('Team sync');
		expect(e.description).toBe('Weekly\nstandup');
		expect(e.location).toBe('Room 1');
		expect(e.uid).toBe('abc-123');
		expect(e.start?.date?.toISOString()).toBe('2026-01-15T14:00:00.000Z');
		expect(e.organizer).toEqual({ name: 'Alice', email: 'alice@example.com' });
		expect(e.attendees[0]).toEqual({
			name: 'Bob',
			email: 'bob@example.com',
			partstat: 'NEEDS-ACTION',
		});
	});

	it('handles folded lines and all-day dates', () => {
		const cal = parseICalendar(
			[
				'BEGIN:VCALENDAR',
				'BEGIN:VEVENT',
				'SUMMARY:A very long ',
				' folded title',
				'DTSTART;VALUE=DATE:20260115',
				'END:VEVENT',
				'END:VCALENDAR',
			].join('\r\n')
		);
		expect(cal.events[0]!.summary).toBe('A very long folded title');
		expect(cal.events[0]!.start?.allDay).toBe(true);
	});
});

describe('buildReplyICalendar', () => {
	it('builds a METHOD:REPLY with the attendee PARTSTAT', () => {
		const e = parseICalendar(INVITE).events[0]!;
		const reply = buildReplyICalendar(
			e,
			'bob@example.com',
			'ACCEPTED',
			new Date('2026-01-10T09:00:00Z')
		);
		expect(reply).toContain('METHOD:REPLY');
		expect(reply).toContain('UID:abc-123');
		expect(reply).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com');
		expect(reply).toContain('ORGANIZER:mailto:alice@example.com');
		expect(reply).toContain('DTSTAMP:20260110T090000Z');
	});

	it('RFC 5545-escapes SUMMARY and never emits a bare newline', () => {
		const e = {
			...parseICalendar(INVITE).events[0]!,
			summary: 'Lunch, drinks; planning\nday two',
		};
		const reply = buildReplyICalendar(
			e,
			'bob@example.com',
			'TENTATIVE',
			new Date('2026-01-10T09:00:00Z')
		);
		expect(reply).toContain('SUMMARY:Lunch\\, drinks\\; planning\\nday two');
		// No content line may contain a literal LF (only the CRLF separators do).
		for (const line of reply.split('\r\n')) expect(line).not.toContain('\n');
	});

	it('strips CR/LF from addresses so they cannot inject lines', () => {
		const e = parseICalendar(INVITE).events[0]!;
		const reply = buildReplyICalendar(
			e,
			'bob@example.com\r\nX-EVIL:1',
			'DECLINED',
			new Date('2026-01-10T09:00:00Z')
		);
		expect(reply).toContain('ATTENDEE;PARTSTAT=DECLINED:mailto:bob@example.comX-EVIL:1');
		// The CRLF didn't start a new content line (no injected property).
		expect(reply).not.toContain('\r\nX-EVIL');
	});
});

describe('icalDateTimeToEpoch', () => {
	const at = (raw: string, extra: Partial<ICalDateTime> = {}): ICalDateTime => ({
		raw,
		date: null,
		allDay: /^\d{8}$/.test(raw),
		...extra,
	});

	it('reads a Z value as UTC and ignores the fallback zone', () => {
		expect(icalDateTimeToEpoch(at('20260708T140000Z'), 'Asia/Tokyo')).toBe(
			Date.UTC(2026, 6, 8, 14)
		);
	});

	it('converts a TZID wall clock in summer (CEST, UTC+2)', () => {
		expect(icalDateTimeToEpoch(at('20260708T140000', { tzid: 'Europe/Berlin' }), 'UTC')).toBe(
			Date.UTC(2026, 6, 8, 12)
		);
	});

	it('converts a TZID wall clock in winter (CET, UTC+1)', () => {
		expect(icalDateTimeToEpoch(at('20260115T093015', { tzid: 'Europe/Berlin' }), 'UTC')).toBe(
			Date.UTC(2026, 0, 15, 8, 30, 15)
		);
	});

	it('lands on the right side of a DST switch', () => {
		// Berlin moves to CEST at 2026-03-29 01:00 UTC; 03:30 local is already CEST.
		expect(icalDateTimeToEpoch(at('20260329T033000', { tzid: 'Europe/Berlin' }), 'UTC')).toBe(
			Date.UTC(2026, 2, 29, 1, 30)
		);
		// 01:30 local on the same day is still CET.
		expect(icalDateTimeToEpoch(at('20260329T013000', { tzid: 'Europe/Berlin' }), 'UTC')).toBe(
			Date.UTC(2026, 2, 29, 0, 30)
		);
	});

	it('reads a floating value in the fallback zone', () => {
		expect(icalDateTimeToEpoch(at('20260708T140000'), 'Europe/Berlin')).toBe(
			Date.UTC(2026, 6, 8, 12)
		);
		expect(icalDateTimeToEpoch(at('20260708T140000'), 'UTC')).toBe(Date.UTC(2026, 6, 8, 14));
	});

	it('reads a VALUE=DATE value as midnight in the fallback zone', () => {
		const allDay = parseICalendar('BEGIN:VEVENT\nDTSTART;VALUE=DATE:20260708\nEND:VEVENT')
			.events[0]!.start!;
		expect(allDay.allDay).toBe(true);
		expect(icalDateTimeToEpoch(allDay, 'UTC')).toBe(Date.UTC(2026, 6, 8));
		expect(icalDateTimeToEpoch(allDay, 'Europe/Berlin')).toBe(Date.UTC(2026, 6, 7, 22));
	});

	it('falls back to the fallback zone for a TZID that is not an IANA zone', () => {
		const dt = at('20260708T140000', { tzid: 'W. Europe Standard Time' });
		expect(icalDateTimeToEpoch(dt, 'UTC')).toBe(Date.UTC(2026, 6, 8, 14));
		expect(icalDateTimeToEpoch(dt, 'Europe/Berlin')).toBe(Date.UTC(2026, 6, 8, 12));
	});

	it('returns null when neither zone is usable', () => {
		expect(
			icalDateTimeToEpoch(at('20260708T140000', { tzid: 'Nowhere/Else' }), 'Also/Nowhere')
		).toBeNull();
	});

	it('returns null for garbage and out-of-range values', () => {
		for (const raw of [
			'',
			'not-a-date',
			'2026-07-08T14:00:00Z',
			'20261308',
			'20260230',
			'20260708T250000Z',
			'20260708T1400',
		]) {
			expect(icalDateTimeToEpoch(at(raw), 'UTC')).toBeNull();
		}
	});

	it('works from what parseICalendar returns, including quoted TZIDs', () => {
		const cal = parseICalendar(
			[
				'BEGIN:VEVENT',
				'DTSTART;TZID="Europe/Berlin":20260708T140000',
				'DTEND;TZID=Europe/Berlin:20260708T150000',
				'END:VEVENT',
			].join('\r\n')
		);
		const e = cal.events[0]!;
		expect(icalDateTimeToEpoch(e.start!, 'UTC')).toBe(Date.UTC(2026, 6, 8, 12));
		expect(icalDateTimeToEpoch(e.end!, 'UTC')).toBe(Date.UTC(2026, 6, 8, 13));
	});
});

describe('wallClockToEpoch', () => {
	it('is the identity on UTC wall clocks', () => {
		expect(wallClockToEpoch(2026, 7, 8, 9, 0, 'UTC')).toBe(Date.UTC(2026, 6, 8, 9));
	});

	it('throws a RangeError for an unknown zone', () => {
		expect(() => wallClockToEpoch(2026, 7, 8, 9, 0, 'Nowhere/Else')).toThrow(RangeError);
	});
});
