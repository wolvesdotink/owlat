import { describe, it, expect } from 'vitest';
import { parseICalendar, buildReplyICalendar } from '../ical';

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
		const reply = buildReplyICalendar(e, 'bob@example.com', 'ACCEPTED', new Date('2026-01-10T09:00:00Z'));
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
		const reply = buildReplyICalendar(e, 'bob@example.com', 'TENTATIVE', new Date('2026-01-10T09:00:00Z'));
		expect(reply).toContain('SUMMARY:Lunch\\, drinks\\; planning\\nday two');
		// No content line may contain a literal LF (only the CRLF separators do).
		for (const line of reply.split('\r\n')) expect(line).not.toContain('\n');
	});

	it('strips CR/LF from addresses so they cannot inject lines', () => {
		const e = parseICalendar(INVITE).events[0]!;
		const reply = buildReplyICalendar(e, 'bob@example.com\r\nX-EVIL:1', 'DECLINED', new Date('2026-01-10T09:00:00Z'));
		expect(reply).toContain('ATTENDEE;PARTSTAT=DECLINED:mailto:bob@example.comX-EVIL:1');
		// The CRLF didn't start a new content line (no injected property).
		expect(reply).not.toContain('\r\nX-EVIL');
	});
});
