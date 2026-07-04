/**
 * Timezone-aware working-hours window for AUTONOMOUS auto-sends.
 *
 * A trust control on graduated autonomy: an owner can confine unattended
 * auto-sends to business hours (e.g. Mon–Fri 09:00–17:00 in their timezone) so
 * the agent never fires a reply at 3am. When the window is configured and the
 * current local time falls outside it, the `route` step's outbound gate holds
 * the auto-approved reply for HUMAN REVIEW instead of sending — the draft is
 * still produced and queued, only the unattended send is deferred to a human in
 * the morning. Human-reviewed approvals are unaffected (a person is already in
 * the loop).
 *
 * Pure + total: no Convex/`Date` timezone ambiguity leaks out. The window is
 * evaluated in the configured IANA timezone via `Intl.DateTimeFormat`, which is
 * the only correct way to map an absolute instant to a wall-clock hour/day in an
 * arbitrary zone (it handles DST). Fail-soft is the CALLER's job: this returns a
 * plain boolean, and an unconfigured/disabled window returns `true` (today's
 * 24/7 behaviour is preserved).
 *
 * Precedence (documented so it stays stable):
 *   1. This working-hours gate runs at ROUTING/decision time, inside the
 *      route step's `assertSafeToAutoSend`, BEFORE the daily cap is charged and
 *      BEFORE the send-delay/undo window or the outbox coalescing ever apply —
 *      an out-of-hours reply never becomes a pending auto-send at all, so there
 *      is nothing for the undo window or the kill switch to cancel later.
 *   2. The send-delay (`agentConfig.autoSendDelayMs`) and coalescing only ever
 *      apply to a reply that already cleared this gate (i.e. was auto-approved
 *      DURING business hours).
 */

export type WorkingHoursConfig = {
	isWorkingHoursEnabled?: boolean;
	workingHoursTimezone?: string;
	workingHoursStart?: number; // minutes from local midnight, inclusive
	workingHoursEnd?: number; // minutes from local midnight, exclusive
	workingHoursDays?: number[]; // allowed weekdays, 0=Sun … 6=Sat
};

/** Default business-hours window applied when a field is unset but the gate is on. */
export const DEFAULT_WORKING_HOURS_START = 9 * 60; // 09:00
export const DEFAULT_WORKING_HOURS_END = 17 * 60; // 17:00
export const DEFAULT_WORKING_HOURS_DAYS = [1, 2, 3, 4, 5]; // Mon–Fri
export const DEFAULT_WORKING_HOURS_TZ = 'UTC';

const WEEKDAY_INDEX: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

/**
 * Resolve the wall-clock minute-of-day and weekday for an absolute instant in a
 * given IANA timezone. Throws only on an invalid timezone string (the caller
 * treats that as "cannot evaluate").
 */
function localMinuteAndDay(nowMs: number, timeZone: string): { minute: number; weekday: number } {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		weekday: 'short',
		hour12: false,
	}).formatToParts(new Date(nowMs));

	let hour = 0;
	let minute = 0;
	let weekday = 0;
	for (const part of parts) {
		if (part.type === 'hour') {
			// `Intl` renders midnight as "24" in some engines with hour12:false — normalize.
			const h = Number.parseInt(part.value, 10);
			hour = h === 24 ? 0 : h;
		} else if (part.type === 'minute') {
			minute = Number.parseInt(part.value, 10);
		} else if (part.type === 'weekday') {
			weekday = WEEKDAY_INDEX[part.value] ?? 0;
		}
	}
	return { minute: hour * 60 + minute, weekday };
}

/**
 * True when `nowMs` falls inside the configured business-hours window (so an
 * autonomous auto-send is permitted). Returns `true` when the window is unset or
 * disabled — the 24/7 default. Supports overnight windows (start > end, e.g.
 * 22:00–06:00) by treating them as wrapping past midnight.
 *
 * Throws only when the timezone is invalid; callers wrap this in try/catch and
 * fail SAFE (hold the send for review) when the gate is enabled but cannot be
 * evaluated — never auto-send on uncertainty.
 */
export function isWithinWorkingHours(config: WorkingHoursConfig, nowMs: number): boolean {
	if (!config.isWorkingHoursEnabled) return true;

	const timeZone = config.workingHoursTimezone || DEFAULT_WORKING_HOURS_TZ;
	const start = config.workingHoursStart ?? DEFAULT_WORKING_HOURS_START;
	const end = config.workingHoursEnd ?? DEFAULT_WORKING_HOURS_END;
	const days =
		config.workingHoursDays && config.workingHoursDays.length > 0
			? config.workingHoursDays
			: DEFAULT_WORKING_HOURS_DAYS;

	const { minute, weekday } = localMinuteAndDay(nowMs, timeZone);

	// A start == end window is treated as "always allowed" on its days (a
	// degenerate 24h window) rather than "never", so a mis-set equal pair fails
	// open to today's behaviour rather than silently halting all auto-send.
	if (start === end) {
		return isAllowedDay(days, weekday);
	}

	if (start < end) {
		// Same-day window, e.g. 09:00–17:00.
		if (!isAllowedDay(days, weekday)) return false;
		return minute >= start && minute < end;
	}

	// Overnight window, e.g. 22:00–06:00. The "day" of an overnight window is the
	// day it STARTS on; the early-morning tail belongs to the previous day's
	// window. Accept either the evening segment on an allowed day or the
	// early-morning segment whose start-day (yesterday) is allowed.
	const eveningSegment = minute >= start;
	const morningSegment = minute < end;
	if (eveningSegment) return isAllowedDay(days, weekday);
	if (morningSegment) return isAllowedDay(days, (weekday + 6) % 7);
	return false;
}

function isAllowedDay(days: number[], weekday: number): boolean {
	for (const d of days) {
		if (d === weekday) return true;
	}
	return false;
}
