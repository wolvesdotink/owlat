/**
 * Schedule-send presets for the composer (plan idea 9). Pure, deterministic,
 * no I/O — the dialog only formats what this decides.
 *
 * Two problems with the presets as they were. They computed in the SENDER's
 * local time, so mailing Berlin from San Francisco, "tomorrow 9:00" landed at
 * 18:00 for the person reading it; and the third preset was a hardcoded
 * "Monday morning", which on a Friday evening is right by accident and on a
 * Tuesday says nothing about the weekend the message might rot over.
 *
 * What this module does instead:
 *
 *   - `nextWeekdayMorning` adds 9:00 on the next Mon–Fri beside the old "start
 *     of next week" row, and both are named by the day they actually resolve
 *     to. A Friday-evening send now offers Monday instead of only Saturday;
 *     midweek the weekday row IS tomorrow, dedupes away, and the list reads
 *     exactly as it always did.
 *   - Presets are DEDUPED by instant. On a Sunday, "tomorrow morning" and
 *     "Monday morning" were already the same timestamp offered twice.
 *   - When the recipient's timezone is confidently known, an extra preset lands
 *     at 9:00 in THEIR clock, and every preset carries both instants so the
 *     dialog can print "9:00 their time (18:00 yours)". Unknown timezone ⇒ the
 *     recipient preset is simply absent and the rest read exactly as before:
 *     the feature degrades silently rather than guessing a clock.
 *
 * Timezones are UTC offsets in minutes east (`-new Date().getTimezoneOffset()`),
 * the same convention `@owlat/shared/snoozePresets` uses, resolved from the
 * recipient's IANA zone by {@link zoneOffsetMinutes}. DST transitions between
 * now and the target are ignored — a ~1h drift on a scheduled send, never a
 * correctness bug.
 *
 * Module scope, so no `useI18n`: labels travel as catalog KEYS and the dialog
 * resolves them at render time.
 */

/** Wall-clock hour each preset targets, in whichever clock it is anchored to. */
const MORNING_HOUR = 9;
const AFTERNOON_HOUR = 13;

/** `Date.getDay()` indices that count as a weekday for `nextWeekdayMorning`. */
const WEEKDAYS = [1, 2, 3, 4, 5];

export type SchedulePresetId =
	| 'recipientMorning'
	| 'tomorrowMorning'
	| 'tomorrowAfternoon'
	| 'nextWeekdayMorning'
	| 'nextMondayMorning';

export interface SchedulePreset {
	id: SchedulePresetId;
	/** Catalog key for the row's name. */
	labelKey: string;
	/** Absolute send instant, epoch-ms. */
	at: number;
	/**
	 * Whose clock the hour was chosen in. `recipient` is the only preset that
	 * exists solely because the recipient's timezone is known.
	 */
	anchor: 'sender' | 'recipient';
	/**
	 * For the two day-named rows, the weekday they resolved to (0=Sun … 6=Sat),
	 * so the dialog says "Monday morning" rather than "next weekday morning".
	 */
	weekday?: number;
}

// ── Timezone-aware wall-clock math (offset minutes EAST of UTC) ──────────────

function localParts(at: number, offsetMinutes: number): Date {
	return new Date(at + offsetMinutes * 60_000);
}

/** Epoch-ms for `hour:00` local, `dayOffset` days from the local date at `now`. */
function atLocalHour(now: number, offsetMinutes: number, hour: number, dayOffset: number): number {
	const local = localParts(now, offsetMinutes);
	return (
		Date.UTC(
			local.getUTCFullYear(),
			local.getUTCMonth(),
			local.getUTCDate() + dayOffset,
			hour,
			0,
			0,
			0
		) -
		offsetMinutes * 60_000
	);
}

/** Local day-of-week (0=Sun … 6=Sat) `dayOffset` days from `now`. */
function localDayOfWeek(now: number, offsetMinutes: number, dayOffset: number): number {
	const local = localParts(now, offsetMinutes);
	return new Date(
		Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset)
	).getUTCDay();
}

/**
 * The UTC offset (minutes east) an IANA zone is on at a given instant, or
 * `null` when the runtime does not know the zone. Resolved per instant, so a
 * preset a week out gets the offset that will actually apply then.
 *
 * Formats the instant IN the zone and reads the wall clock back as if it were
 * UTC: the gap between that and the real instant IS the offset. `hour` can come
 * back as '24' for midnight under `hourCycle: 'h23'` in some engines, so it is
 * normalised.
 */
export function zoneOffsetMinutes(timeZone: string, at: number): number | null {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}).formatToParts(new Date(at));
		const read = (type: Intl.DateTimeFormatPartTypes): number =>
			Number(parts.find((p) => p.type === type)?.value ?? NaN);
		const hour = read('hour') % 24;
		const asUtc = Date.UTC(
			read('year'),
			read('month') - 1,
			read('day'),
			hour,
			read('minute'),
			read('second')
		);
		if (Number.isNaN(asUtc)) return null;
		// Round to the minute: sub-minute zone offsets stopped existing in 1972.
		return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
	} catch {
		// An unknown / malformed zone name is not worth a thrown dialog — the
		// caller degrades to sender-clock presets.
		return null;
	}
}

/**
 * The ONE timezone to schedule against, or null. Deliberately strict: a single
 * distinct known zone across the recipients we have an answer for. With two
 * recipients in different zones there is no "their morning" to aim at, so the
 * dialog says nothing rather than picking a winner.
 */
export function soleRecipientTimeZone(
	entries: ReadonlyArray<{ address: string; timeZone: string }>
): string | null {
	const zones = new Set(entries.map((e) => e.timeZone).filter(Boolean));
	return zones.size === 1 ? ([...zones][0] as string) : null;
}

export interface SchedulePresetInputs {
	/** Now, epoch-ms. */
	now: number;
	/** Sender's UTC offset in minutes east. */
	senderOffsetMinutes: number;
	/** Recipient's UTC offset in minutes east, or null when not known. */
	recipientOffsetMinutes?: number | null;
}

/**
 * The presets to offer, in display order, deduped by instant (first wins).
 *
 * The recipient-anchored preset comes first when it exists — it is the reason
 * the sender opened a timezone-aware dialog — and is dropped when it resolves
 * to the same instant as a sender preset (the two clocks agree), because
 * offering one moment twice under two labels is noise, not choice.
 */
export function buildSchedulePresets(inputs: SchedulePresetInputs): SchedulePreset[] {
	const { now, senderOffsetMinutes } = inputs;
	const candidates: SchedulePreset[] = [];

	const recipientOffset = inputs.recipientOffsetMinutes;
	if (typeof recipientOffset === 'number') {
		candidates.push({
			id: 'recipientMorning',
			labelKey: 'components.postbox.postboxScheduleDialog.recipientMorning',
			at: nextFutureLocalHour(now, recipientOffset, MORNING_HOUR),
			anchor: 'recipient',
		});
	}

	candidates.push(
		{
			id: 'tomorrowMorning',
			labelKey: 'components.postbox.postboxScheduleDialog.tomorrowMorning',
			at: atLocalHour(now, senderOffsetMinutes, MORNING_HOUR, 1),
			anchor: 'sender',
		},
		{
			id: 'tomorrowAfternoon',
			labelKey: 'components.postbox.postboxScheduleDialog.tomorrowAfternoon',
			at: atLocalHour(now, senderOffsetMinutes, AFTERNOON_HOUR, 1),
			anchor: 'sender',
		}
	);

	// Two "further out" candidates, both named by the day they land on. On a
	// Friday the weekday one IS Monday and the Monday one dedupes away; midweek
	// the weekday one is tomorrow and dedupes away, leaving "start of next week"
	// exactly as the dialog has always offered it. Either way the list keeps its
	// third row and nothing is offered twice.
	for (const [id, dayOffset] of [
		['nextWeekdayMorning', daysToNextWeekday(now, senderOffsetMinutes)],
		['nextMondayMorning', daysToNextMonday(now, senderOffsetMinutes)],
	] as const) {
		candidates.push({
			id,
			labelKey: 'components.postbox.postboxScheduleDialog.nextWeekdayMorning',
			at: atLocalHour(now, senderOffsetMinutes, MORNING_HOUR, dayOffset),
			anchor: 'sender',
			weekday: localDayOfWeek(now, senderOffsetMinutes, dayOffset),
		});
	}

	const seen = new Set<number>();
	return candidates.filter((preset) => {
		if (seen.has(preset.at)) return false;
		seen.add(preset.at);
		return true;
	});
}

/**
 * Days from today to the next Mon–Fri, never 0 — a preset is always a future
 * day, so "next weekday" on a Wednesday is Thursday, and on a Friday is Monday.
 */
function daysToNextWeekday(now: number, offsetMinutes: number): number {
	for (let offset = 1; offset <= 7; offset++) {
		if (WEEKDAYS.includes(localDayOfWeek(now, offsetMinutes, offset))) return offset;
	}
	// Unreachable: any 7-day window contains a weekday. Keeps the return total.
	return 1;
}

/** Days from today to the next Monday, never 0 — "start of next week". */
function daysToNextMonday(now: number, offsetMinutes: number): number {
	const today = localDayOfWeek(now, offsetMinutes, 0);
	return (1 + 7 - today) % 7 || 7;
}

/**
 * The next time it is `hour:00` in a clock, strictly in the future. Used for
 * the recipient-anchored preset: their 9:00 may still be ahead of us TODAY
 * (they are behind us), in which case aiming at tomorrow would skip a day.
 */
function nextFutureLocalHour(now: number, offsetMinutes: number, hour: number): number {
	const today = atLocalHour(now, offsetMinutes, hour, 0);
	return today > now ? today : atLocalHour(now, offsetMinutes, hour, 1);
}
