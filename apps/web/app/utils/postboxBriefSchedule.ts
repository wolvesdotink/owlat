/**
 * Daily-brief delivery time (idea 29) — the pure half.
 *
 * The preference stores minutes past LOCAL midnight, which is what the sending
 * cron compares against; an `<input type="time">` speaks "HH:MM". These two
 * conversions are the whole boundary between them, and they are here rather than
 * inline in the settings card so the rejection cases have a test: a browser that
 * renders the control as a plain text field (or an autofill) can hand back
 * anything at all, and a half-parsed time would silently schedule the brief for
 * midnight.
 */

/** 07:00 — early enough to be the morning's plan, late enough to be read. */
export const POSTBOX_BRIEF_TIME_DEFAULT_MINUTE = 7 * 60;

/** Minutes past local midnight → the `HH:MM` an `<input type="time">` wants. */
export function minuteToTimeInput(minute: number): string {
	const clamped = Math.min(1439, Math.max(0, Math.round(minute)));
	const hours = Math.floor(clamped / 60);
	const minutes = clamped % 60;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * `HH:MM` → minutes past local midnight, or null when the value is not a time.
 *
 * Null rather than a fallback on purpose: the caller SKIPS the save, leaving the
 * user's stored time untouched. Defaulting an unparseable value to midnight
 * would quietly move a brief someone had set for 07:00.
 */
export function timeInputToMinute(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
	if (hours > 23 || minutes > 59) return null;
	return hours * 60 + minutes;
}
