/**
 * Pure helpers for Today's Upcoming band (`TodayUpcoming.vue`): the short
 * "when" of a row, read against the viewer's calendar, and where each kind of
 * row opens. No Vue, no Convex, so the date rules are testable with a pinned
 * clock and time zone.
 */
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

export type UpcomingPage = FunctionReturnType<typeof api.today.upcoming.list>;
export type UpcomingItem = UpcomingPage['items'][number];

/**
 * When a row happens, relative to `now` in the viewer's calendar:
 *  - `now`: its time has come (a scheduled send whose dispatch is under way);
 *  - `today` / `tomorrow`: the clock time only;
 *  - `week`: within the next six days, the weekday and time ("Fri 10:00");
 *  - `date`: later, the date and time.
 */
export type UpcomingWhen =
	| { kind: 'now' }
	| { kind: 'today'; time: string }
	| { kind: 'tomorrow'; time: string }
	| { kind: 'week'; day: string; time: string }
	| { kind: 'date'; date: string; time: string };

const DAY_MS = 86_400_000;

/** Calendar day number of `at` in `timeZone` (days since the epoch, local midnight). */
function dayNumber(at: number, timeZone: string | undefined): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
	}).formatToParts(at);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY_MS);
}

export function upcomingWhen(
	at: number,
	now: number,
	locale: string,
	timeZone?: string
): UpcomingWhen {
	if (at <= now) return { kind: 'now' };
	const time = new Intl.DateTimeFormat(locale, { timeZone, timeStyle: 'short' }).format(at);
	const days = dayNumber(at, timeZone) - dayNumber(now, timeZone);
	if (days <= 0) return { kind: 'today', time };
	if (days === 1) return { kind: 'tomorrow', time };
	if (days < 7) {
		const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short' }).format(at);
		return { kind: 'week', day, time };
	}
	const date = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short' }).format(
		at
	);
	return { kind: 'date', date, time };
}

/** A wall-clock time ("09:30", "9:30 AM") in the locale's style, for recipient-local sends. */
export function localClockTime(clock: { hour: number; minute: number }, locale: string): string {
	return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', timeStyle: 'short' }).format(
		Date.UTC(2000, 0, 1, clock.hour, clock.minute)
	);
}

/** Where a row opens. A scheduled send has no page of its own: its actions are Edit and Cancel. */
export function upcomingHref(item: UpcomingItem): string | null {
	switch (item.kind) {
		case 'scheduled_send':
			return null;
		case 'snooze_return':
			return `/dashboard/postbox/snoozed/${item.messageId}?mailbox=${item.mailboxId}`;
		case 'follow_up':
			return `/dashboard/postbox/sent/${item.messageId}?mailbox=${item.mailboxId}`;
		case 'team_snooze_return':
			return `/dashboard/inbox/${item.threadId}`;
		case 'campaign':
			return `/dashboard/campaigns/${item.campaignId}/edit`;
	}
}
