/**
 * Team Inbox response targets, as the thread row renders them.
 *
 * The deadline itself is stored on the thread (`responseDueAt`, computed on the
 * server in business or calendar time and moved only by replies, snoozes and
 * status changes), so the row only compares it with the list's clock. Pure,
 * with an injected `now`, like utils/inboxWaiting.ts.
 */
import { inboxDurationLabel, type InboxWaitingLabel } from './inboxWaiting';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How close a deadline counts as "due soon".
 *
 * MIRRORS `SLA_DUE_SOON_MS` in apps/api/convex/inbox/sla/slices.ts, which the
 * "Due soon" pill counts by; both sides pin the value in their own test.
 */
export const INBOX_SLA_DUE_SOON_MS = 60 * 60 * 1000;

/** `ok` → due later, `soon` → within the hour, `overdue` → passed. */
export type InboxSlaTier = 'ok' | 'soon' | 'overdue';

/** Chip colour per tier; the label always spells the time out too. */
export const INBOX_SLA_TIER_CLASS: Record<InboxSlaTier, string> = {
	ok: 'text-text-tertiary',
	soon: 'text-warning',
	overdue: 'text-error',
};

export interface InboxSlaChip {
	tier: InboxSlaTier;
	label: InboxWaitingLabel;
}

/** The chip for a thread with a running deadline, or `null` without one. */
export function inboxSlaChip(
	thread: { responseDueAt?: number | null },
	now: number
): InboxSlaChip | null {
	const due = thread.responseDueAt;
	if (due === undefined || due === null) return null;
	if (due <= now) {
		return { tier: 'overdue', label: inboxDurationLabel('shared.inboxSla.overdue', now - due) };
	}
	return {
		tier: due - now <= INBOX_SLA_DUE_SOON_MS ? 'soon' : 'ok',
		label: inboxDurationLabel('shared.inboxSla.dueIn', due - now),
	};
}

/**
 * A measured duration for the analytics page, one unit finer than the row
 * chip: "45m", "2h 13m", "3d 4h". Minutes round, so a median of 59.6 minutes
 * reads "1h 0m" rather than "59m".
 */
export function inboxSlaDurationLabel(ms: number): InboxWaitingLabel {
	const base = 'shared.inboxSla.duration';
	const minutes = Math.round(Math.max(0, ms) / MINUTE);
	if (minutes < 60) return { key: `${base}.minutes`, params: { minutes } };
	if (minutes * MINUTE < DAY) {
		return {
			key: `${base}.hoursMinutes`,
			params: { hours: Math.floor(minutes / 60), minutes: minutes % 60 },
		};
	}
	const totalHours = Math.floor((minutes * MINUTE) / HOUR);
	return {
		key: `${base}.daysHours`,
		params: { days: Math.floor(totalHours / 24), hours: totalHours % 24 },
	};
}

/** The analytics page's quick ranges, in days ending today (UTC). */
export const INBOX_ANALYTICS_PRESETS = ['7', '30', '90'] as const;
export type InboxAnalyticsPreset = (typeof INBOX_ANALYTICS_PRESETS)[number] | 'custom';

/** The widest range the backend answers. */
export const INBOX_ANALYTICS_MAX_DAYS = 366;

function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The `{ fromDay, toDay }` (UTC dates, inclusive) a range choice asks for, or
 * `null` when a custom range is incomplete, reversed or too wide.
 */
export function inboxAnalyticsRange(
	preset: InboxAnalyticsPreset,
	custom: { from: string; to: string },
	now: number
): { fromDay: string; toDay: string } | null {
	if (preset !== 'custom') {
		return { fromDay: utcDay(now - (Number(preset) - 1) * DAY), toDay: utcDay(now) };
	}
	const from = Date.parse(`${custom.from}T00:00:00Z`);
	const to = Date.parse(`${custom.to}T00:00:00Z`);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
	if ((to - from) / DAY + 1 > INBOX_ANALYTICS_MAX_DAYS) return null;
	return { fromDay: custom.from, toDay: custom.to };
}
