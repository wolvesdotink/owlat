/**
 * The Upcoming band's "when" reads against the viewer's calendar day, not a
 * rolling 24 hours, and each kind of row opens where it lives.
 */
import { describe, expect, it } from 'vitest';
import { localClockTime, upcomingHref, upcomingWhen, type UpcomingItem } from '../todayUpcoming';

// Wednesday 21 October 2026, 22:00 UTC.
const NOW = Date.UTC(2026, 9, 21, 22, 0);
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour, minute);

describe('upcomingWhen', () => {
	it('says now once the time has come', () => {
		expect(upcomingWhen(NOW, NOW, 'en-US', 'UTC')).toEqual({ kind: 'now' });
		expect(upcomingWhen(NOW - 60_000, NOW, 'en-US', 'UTC')).toEqual({ kind: 'now' });
	});

	it('gives only the time later today, and tomorrow by calendar day', () => {
		expect(upcomingWhen(at(21, 23, 30), NOW, 'en-GB', 'UTC')).toEqual({
			kind: 'today',
			time: '23:30',
		});
		// Two hours away, but already tomorrow.
		expect(upcomingWhen(at(22, 0, 15), NOW, 'en-GB', 'UTC')).toEqual({
			kind: 'tomorrow',
			time: '00:15',
		});
	});

	it('names the weekday within the week, then the date', () => {
		expect(upcomingWhen(at(23, 9), NOW, 'en-US', 'UTC')).toEqual({
			kind: 'week',
			day: 'Fri',
			time: '9:00 AM',
		});
		// The short weekday's spelling ("Di" / "Di.") is the engine's.
		expect(upcomingWhen(at(27, 10), NOW, 'de-DE', 'UTC')).toEqual({
			kind: 'week',
			day: new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', weekday: 'short' }).format(
				at(27, 10)
			),
			time: '10:00',
		});
		expect(upcomingWhen(at(28, 10), NOW, 'en-US', 'UTC')).toEqual({
			kind: 'date',
			date: 'Oct 28',
			time: '10:00 AM',
		});
	});

	it("counts days in the viewer's time zone", () => {
		// 22:00 UTC is 18:00 in New York; 03:00 UTC the next day is still that day there.
		expect(upcomingWhen(at(22, 3), NOW, 'en-US', 'America/New_York')).toEqual({
			kind: 'today',
			time: '11:00 PM',
		});
	});
});

describe('localClockTime', () => {
	it('formats a wall-clock time in the locale style', () => {
		expect(localClockTime({ hour: 9, minute: 30 }, 'en-US')).toBe('9:30 AM');
		expect(localClockTime({ hour: 9, minute: 30 }, 'de-DE')).toBe('09:30');
	});
});

describe('upcomingHref', () => {
	const mail = { mailboxId: 'mb1', mailboxLabel: 'Ada', key: 'k', at: NOW };
	it('opens each kind where it lives', () => {
		const rows = [
			{
				...mail,
				kind: 'scheduled_send',
				draftId: 'd1',
				subject: 's',
				firstRecipient: null,
				recipientCount: 0,
				inReplyToMessageId: null,
			},
			{
				...mail,
				kind: 'snooze_return',
				threadId: 't1',
				messageId: 'm1',
				subject: 's',
				from: 'x',
				isUntilReply: false,
			},
			{
				...mail,
				kind: 'follow_up',
				threadId: 't2',
				messageId: 'm2',
				subject: 's',
				waitingOn: null,
			},
			{
				kind: 'team_snooze_return',
				key: 'k',
				at: NOW,
				threadId: 'ct1',
				subject: 's',
				contact: 'c',
			},
			{
				kind: 'campaign',
				key: 'k',
				at: NOW,
				campaignId: 'c1',
				name: 'Autumn',
				timing: 'absolute',
				localTime: null,
				audienceName: null,
				recipients: null,
			},
		] as unknown as UpcomingItem[];
		expect(rows.map(upcomingHref)).toEqual([
			null,
			'/dashboard/postbox/snoozed/m1?mailbox=mb1',
			'/dashboard/postbox/sent/m2?mailbox=mb1',
			'/dashboard/inbox/ct1',
			'/dashboard/campaigns/c1/edit',
		]);
	});
});
