/**
 * Postbox quiet hours: the daily window (plus weekday mask) during which
 * desktop toasts are held back and rolled into one "N while you were away"
 * summary when the window ends.
 *
 * Shape and normalisation only — the "is it quiet right now?" evaluation lives
 * in `~/lib/desktop/notificationRules` beside the rest of the toast matrix.
 *
 * The two minute fields are minutes past LOCAL midnight (0..1439), not an
 * instant: "quiet from 22:00" means 22:00 on the device the user is looking at,
 * which is why the window is evaluated client-side rather than by the server.
 * A window whose end is at or before its start wraps midnight (22:00 → 07:00).
 * `days` is the weekday mask the window STARTS on (0 = Sunday .. 6 = Saturday,
 * matching `Date.getDay()`), so a Friday-night window still covers Saturday's
 * small hours.
 *
 * `enabled` is stored rather than inferred from the row's presence so switching
 * quiet hours off keeps the window the user configured.
 */

export interface PostboxQuietHours {
	enabled: boolean;
	/** Minutes past local midnight, 0..1439. */
	startMinute: number;
	/** Minutes past local midnight, 0..1439. */
	endMinute: number;
	/** Weekdays the window starts on, 0 = Sunday .. 6 = Saturday. */
	days: number[];
}

export const MINUTES_PER_DAY = 24 * 60;

/**
 * What an unset preference reads as: OFF, with a sensible 22:00–07:00 every-day
 * window pre-filled so the first toggle does something useful. Because
 * `enabled` is false, an unset row is exactly today's behaviour.
 */
export const POSTBOX_QUIET_HOURS_DEFAULT: PostboxQuietHours = {
	enabled: false,
	startMinute: 22 * 60,
	endMinute: 7 * 60,
	days: [0, 1, 2, 3, 4, 5, 6],
};

/**
 * Weekday values in the order a Monday-first picker renders them. VALUES ONLY —
 * labels are resolved from the message catalog at the render boundary.
 */
export const POSTBOX_WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** Clamp any number to a valid minute of the day, rounding to whole minutes. */
export function clampMinuteOfDay(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.round(value)));
}

/** Minutes past midnight → the `HH:MM` an `<input type="time">` speaks. */
export function formatMinuteOfDay(value: number): string {
	const m = clampMinuteOfDay(value);
	const hh = String(Math.floor(m / 60)).padStart(2, '0');
	const mm = String(m % 60).padStart(2, '0');
	return `${hh}:${mm}`;
}

/** `HH:MM` → minutes past midnight; null when the string isn't a clock time. */
export function parseMinuteOfDay(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	return hours * 60 + minutes;
}

/** Normalise a stored/unknown value to a usable window, defaulting safely. */
export function resolvePostboxQuietHours(value: unknown): PostboxQuietHours {
	if (!value || typeof value !== 'object') return POSTBOX_QUIET_HOURS_DEFAULT;
	const raw = value as Partial<PostboxQuietHours>;
	const days = Array.isArray(raw.days)
		? // Dedupe + sort so the mask is order-independent and a stray 9 from a
			// future client can't make a window "quiet" on a day that doesn't exist.
			[...new Set(raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
				(a, b) => a - b
			)
		: POSTBOX_QUIET_HOURS_DEFAULT.days;
	return {
		enabled: raw.enabled === true,
		startMinute: clampMinuteOfDay(
			typeof raw.startMinute === 'number'
				? raw.startMinute
				: POSTBOX_QUIET_HOURS_DEFAULT.startMinute
		),
		endMinute: clampMinuteOfDay(
			typeof raw.endMinute === 'number' ? raw.endMinute : POSTBOX_QUIET_HOURS_DEFAULT.endMinute
		),
		days,
	};
}

/**
 * Whether the window can ever suppress anything: it has to be switched on, name
 * at least one weekday, and span a non-zero stretch of the clock. A window
 * failing any of those is inert, and the settings UI says so rather than
 * pretending it is armed.
 */
export function isQuietHoursArmed(q: PostboxQuietHours): boolean {
	return q.enabled && q.days.length > 0 && q.startMinute !== q.endMinute;
}
