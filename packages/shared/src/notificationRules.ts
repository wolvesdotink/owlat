/**
 * Which new mail is worth interrupting someone for: the rules the desktop
 * toasts (`apps/web/app/lib/desktop/notificationRules.ts`) and the server-sent
 * Web Push (`apps/api/convex/push/`) both apply, so the two surfaces can never
 * disagree about a message.
 *
 * Pure and runtime-free: no DOM, no Convex, no `Date` methods that read the
 * host's own time zone. The quiet-hours window is evaluated against a LOCAL
 * clock reading the caller supplies — the desktop passes its own wall clock,
 * the push sender converts the instant into the device's IANA zone with
 * {@link localClockIn}.
 */

/** The "Notify me about" scope stored on `mailUserSettings.notifyAbout`. */
export type NotifyAbout = 'everything' | 'people-important' | 'nothing';

/** Every scope, in the order a picker offers them. Values only, never labels. */
export const NOTIFY_ABOUT_OPTIONS: readonly NotifyAbout[] = [
	'everything',
	'people-important',
	'nothing',
];

/**
 * Default scope. Once smart categories exist the quieter 'people-important'
 * is preferred; a deploy without the classifier (`categoriesLive` false)
 * defaults to 'everything' so a fresh install still surfaces new mail.
 */
export function defaultNotifyAbout(categoriesLive: boolean): NotifyAbout {
	return categoriesLive ? 'people-important' : 'everything';
}

/** Normalise a stored/unknown value to a valid scope, defaulting safely. */
export function resolveNotifyAbout(
	value: string | undefined | null,
	categoriesLive: boolean
): NotifyAbout {
	if (value === 'everything' || value === 'people-important' || value === 'nothing') {
		return value;
	}
	return defaultNotifyAbout(categoriesLive);
}

/**
 * The quiet-hours window stored on `mailUserSettings.quietHours`. Minutes are
 * past LOCAL midnight (0..1439); a window whose end is at or before its start
 * wraps midnight; `days` is the weekday mask the window STARTS on
 * (0 = Sunday .. 6 = Saturday, matching `Date.getDay()`).
 */
export interface QuietHours {
	enabled: boolean;
	startMinute: number;
	endMinute: number;
	days: number[];
}

export const MINUTES_PER_DAY = 24 * 60;

/**
 * What an unset preference reads as: OFF, with a 22:00–07:00 every-day window
 * pre-filled so the first toggle does something useful.
 */
export const QUIET_HOURS_DEFAULT: QuietHours = {
	enabled: false,
	startMinute: 22 * 60,
	endMinute: 7 * 60,
	days: [0, 1, 2, 3, 4, 5, 6],
};

/** Clamp any number to a valid minute of the day, rounding to whole minutes. */
export function clampMinuteOfDay(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.round(value)));
}

/** Normalise a stored/unknown value to a usable window, defaulting safely. */
export function resolveQuietHours(value: unknown): QuietHours {
	if (!value || typeof value !== 'object') return QUIET_HOURS_DEFAULT;
	const raw = value as Partial<QuietHours>;
	const days = Array.isArray(raw.days)
		? // Dedupe + sort so the mask is order-independent and a stray 9 from a
			// future client can't make a window "quiet" on a day that doesn't exist.
			[...new Set(raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
				(a, b) => a - b
			)
		: QUIET_HOURS_DEFAULT.days;
	return {
		enabled: raw.enabled === true,
		startMinute: clampMinuteOfDay(
			typeof raw.startMinute === 'number' ? raw.startMinute : QUIET_HOURS_DEFAULT.startMinute
		),
		endMinute: clampMinuteOfDay(
			typeof raw.endMinute === 'number' ? raw.endMinute : QUIET_HOURS_DEFAULT.endMinute
		),
		days,
	};
}

/**
 * Whether the window can ever suppress anything: switched on, at least one
 * weekday, and a non-zero stretch of the clock.
 */
export function isQuietHoursArmed(q: QuietHours): boolean {
	return q.enabled && q.days.length > 0 && q.startMinute !== q.endMinute;
}

/** A local wall-clock reading: minutes past midnight and the weekday (0 = Sunday). */
export interface LocalClock {
	minuteOfDay: number;
	weekday: number;
}

/**
 * Is the local clock reading inside the quiet window? False for an inert
 * window. The weekday mask names the day the window STARTS on: with Friday
 * masked, 22:00 → 07:00 covers Friday night AND Saturday until 07:00.
 */
export function isQuietAt(q: QuietHours | undefined, clock: LocalClock): boolean {
	if (!q || !isQuietHoursArmed(q)) return false;
	const { minuteOfDay: minutes, weekday: day } = clock;
	if (q.startMinute < q.endMinute) {
		// Same-day window (09:00 → 17:00): start inclusive, end exclusive.
		return q.days.includes(day) && minutes >= q.startMinute && minutes < q.endMinute;
	}
	// Wrapping window (22:00 → 07:00): the tail belongs to the PREVIOUS day's mask.
	if (minutes >= q.startMinute) return q.days.includes(day);
	if (minutes < q.endMinute) return q.days.includes((day + 6) % 7);
	return false;
}

/** Minutes until the current quiet window ends, or null when not inside one. */
export function minutesUntilQuietEnd(q: QuietHours | undefined, clock: LocalClock): number | null {
	if (!q || !isQuietAt(q, clock)) return null;
	const delta = q.endMinute - clock.minuteOfDay;
	return delta > 0 ? delta : delta + MINUTES_PER_DAY;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The wall clock in `timeZone` at instant `at`. An unknown or absent zone
 * reads as UTC rather than throwing: a device that never reported its zone
 * still gets a deterministic (if possibly shifted) window, never a crash.
 */
export function localClockIn(timeZone: string | undefined, at: number): LocalClock {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timeZone || 'UTC',
			weekday: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(at));
	} catch {
		return localClockIn('UTC', at);
	}
	const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
	const hour = Number(read('hour')) % 24;
	const minute = Number(read('minute'));
	return { minuteOfDay: hour * 60 + minute, weekday: WEEKDAYS[read('weekday')] ?? 0 };
}

/** True when `timeZone` is an IANA zone this runtime can evaluate. */
export function isValidTimeZone(timeZone: string): boolean {
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone !== '';
	} catch {
		return false;
	}
}

/**
 * Should a NEW message of this category notify under the chosen scope?
 * A MUTED thread never does; 'nothing' never; 'everything' always;
 * 'people-important' only `person`, with an absent category (classifier has
 * not run) falling open so nothing is silently dropped before classification.
 */
export function shouldNotify(
	category: string | undefined,
	setting: NotifyAbout,
	muted = false
): boolean {
	if (muted) return false;
	if (setting === 'nothing') return false;
	if (setting === 'everything') return true;
	return category === undefined || category === 'person';
}

/** Why a notification did not fire, or null when it did. */
export type NotificationSuppression = 'muted' | 'scope' | 'quiet-hours' | null;

export interface NotifyDecisionInput {
	category?: string;
	setting: NotifyAbout;
	/** The thread is muted (mail/mute.ts). */
	muted?: boolean;
	/** The thread is armed with "notify me when they reply". */
	alerted?: boolean;
	/** We are currently inside the user's quiet-hours window. */
	quiet?: boolean;
}

/**
 * The whole per-message decision, in precedence order:
 *
 *   1. MUTED wins over everything, including an armed alert.
 *   2. An ARMED thread ("notify me when they reply") fires regardless of scope
 *      and of quiet hours.
 *   3. The global SCOPE (Everything / People & important / Nothing).
 *   4. QUIET HOURS suppress what is left — counted, so the caller can roll
 *      them into one "N while you were away" summary when the window ends.
 */
export function decideNotification(input: NotifyDecisionInput): {
	fire: boolean;
	suppressed: NotificationSuppression;
} {
	if (input.muted) return { fire: false, suppressed: 'muted' };
	if (input.alerted) return { fire: true, suppressed: null };
	if (!shouldNotify(input.category, input.setting)) return { fire: false, suppressed: 'scope' };
	if (input.quiet) return { fire: false, suppressed: 'quiet-hours' };
	return { fire: true, suppressed: null };
}
