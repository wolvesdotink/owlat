/**
 * Deadline resolution (review F11): the date a deadline phrase means, worked
 * out deterministically from the phrase, the message date and the owner's time
 * zone. The model's own timestamp is never stored: a phrase this resolver
 * cannot read with certainty is kept as written, `isAmbiguous`, with no `at`.
 *
 * Reads (EN / DE / FR):
 *   - explicit dates: `2026-10-09`, `9.10.2026`, `9.10.`, `9/10/2026` only when
 *     the day/month order is decidable (one part above 12), month names
 *     (`October 9`, `9 October`, `9. Oktober`, `9 octobre`), optional year;
 *   - relative days: today / tomorrow / the day after tomorrow, `in N days`,
 *     `in a week`, end of day;
 *   - weekdays: the next such day after the message date ("by Friday" sent on
 *     a Wednesday is that Friday). The message's own weekday, and "next
 *     Friday" (this one or the one after?), are ambiguous.
 * Two different readings in one phrase are ambiguous too.
 *
 * `at` is the start of that day in the time zone (a date deadline). Pure.
 */

export interface ResolvedDue {
	at?: number;
	isAmbiguous: boolean;
}

interface YMD {
	y: number;
	m: number;
	d: number;
}

const MONTHS: Record<string, number> = {
	january: 1, jan: 1, januar: 1, janvier: 1, jänner: 1,
	february: 2, feb: 2, februar: 2, février: 2, fevrier: 2,
	march: 3, mar: 3, märz: 3, maerz: 3, mars: 3,
	april: 4, apr: 4, avril: 4,
	may: 5, mai: 5,
	june: 6, jun: 6, juni: 6, juin: 6,
	july: 7, jul: 7, juli: 7, juillet: 7,
	august: 8, aug: 8, août: 8, aout: 8,
	september: 9, sep: 9, sept: 9, septembre: 9,
	october: 10, oct: 10, oktober: 10, okt: 10, octobre: 10,
	november: 11, nov: 11, novembre: 11,
	december: 12, dec: 12, dezember: 12, dez: 12, décembre: 12, decembre: 12,
};

/** Weekday names → 0 (Sunday) … 6 (Saturday). */
const WEEKDAYS: Record<string, number> = {
	sunday: 0, sonntag: 0, dimanche: 0,
	monday: 1, montag: 1, lundi: 1,
	tuesday: 2, dienstag: 2, mardi: 2,
	wednesday: 3, mittwoch: 3, mercredi: 3,
	thursday: 4, donnerstag: 4, jeudi: 4,
	friday: 5, freitag: 5, vendredi: 5,
	saturday: 6, samstag: 6, sonnabend: 6, samedi: 6,
};

const MONTH_RE = Object.keys(MONTHS)
	.sort((a, b) => b.length - a.length)
	.join('|');
const WEEKDAY_RE = Object.keys(WEEKDAYS).join('|');

function partsIn(ms: number, timeZone: string): YMD {
	let fmt: Intl.DateTimeFormat;
	try {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
		});
	} catch {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone: 'UTC',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
		});
	}
	const get = (type: string) =>
		Number(fmt.formatToParts(new Date(ms)).find((p) => p.type === type)?.value);
	return { y: get('year'), m: get('month'), d: get('day') };
}

/** The calendar date (YYYY-MM-DD) of an instant in `timeZone`. Pure. */
export function localDayKey(ms: number, timeZone: string): string {
	const { y, m, d } = partsIn(ms, timeZone);
	return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Epoch ms of local midnight of a calendar date in `timeZone`. */
export function zonedMidnight(date: YMD, timeZone: string): number {
	const guess = Date.UTC(date.y, date.m - 1, date.d);
	let at = guess;
	for (let i = 0; i < 2; i++) {
		const local = partsIn(at, timeZone);
		const hours = hourIn(at, timeZone);
		const localAsUtc = Date.UTC(local.y, local.m - 1, local.d) + hours.ms;
		at -= localAsUtc - guess;
	}
	return at;
}

function hourIn(ms: number, timeZone: string): { ms: number } {
	let fmt: Intl.DateTimeFormat;
	try {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hour: 'numeric',
			minute: 'numeric',
			hourCycle: 'h23',
		});
	} catch {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone: 'UTC',
			hour: 'numeric',
			minute: 'numeric',
			hourCycle: 'h23',
		});
	}
	const parts = fmt.formatToParts(new Date(ms));
	const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
	const min = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
	return { ms: (h * 60 + min) * 60_000 };
}

function addDays(date: YMD, days: number): YMD {
	const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
	return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(date: YMD): number {
	return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

function isValid(date: YMD): boolean {
	const t = new Date(Date.UTC(date.y, date.m - 1, date.d));
	return t.getUTCFullYear() === date.y && t.getUTCMonth() + 1 === date.m && t.getUTCDate() === date.d;
}

/** A date written without a year: this year, or next year when it already passed. */
function withYear(m: number, d: number, today: YMD): YMD {
	const thisYear = { y: today.y, m, d };
	const passed =
		Date.UTC(today.y, m - 1, d) < Date.UTC(today.y, today.m - 1, today.d) - 31 * 86_400_000;
	return passed ? { y: today.y + 1, m, d } : thisYear;
}

function fullYear(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = Number(raw);
	return raw.length === 2 ? 2000 + n : n;
}

const NUMBER_WORDS: Record<string, number> = {
	one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14,
	einem: 1, einen: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sieben: 7, zehn: 10, vierzehn: 14,
	un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, dix: 10, quinze: 15,
};

/** Every reading the phrase supports, as calendar dates; `ambiguous` when one is unsure. */
function readings(phrase: string, today: YMD): { dates: YMD[]; isUnsure: boolean } {
	const text = phrase.normalize('NFKC').toLowerCase();
	const dates: YMD[] = [];
	let isUnsure = false;
	const push = (date: YMD | undefined) => {
		if (date && isValid(date)) dates.push(date);
		else isUnsure = true;
	};

	for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
		push({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
	}
	for (const m of text.matchAll(/(?<![\d-])(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?![\d-])/g)) {
		const y = fullYear(m[3]);
		push(y ? { y, m: Number(m[2]), d: Number(m[1]) } : withYear(Number(m[2]), Number(m[1]), today));
	}
	for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g)) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (a <= 12 && b <= 12 && a !== b) {
			isUnsure = true; // 9/10: September 10th or 9 October?
			continue;
		}
		const [d, mo] = a > 12 ? [a, b] : [b, a];
		const y = fullYear(m[3]);
		push(y ? { y, m: mo, d } : withYear(mo, d, today));
	}
	const dayMonth = new RegExp(
		`\\b(\\d{1,2})(?:st|nd|rd|th|er|e)?\\.?\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?\\b`,
		'g'
	);
	for (const m of text.matchAll(dayMonth)) {
		const mo = MONTHS[m[2] as string] as number;
		const y = fullYear(m[3]);
		push(y ? { y, m: mo, d: Number(m[1]) } : withYear(mo, Number(m[1]), today));
	}
	const monthDay = new RegExp(
		`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
		'g'
	);
	for (const m of text.matchAll(monthDay)) {
		const mo = MONTHS[m[1] as string] as number;
		const y = fullYear(m[3]);
		push(y ? { y, m: mo, d: Number(m[2]) } : withYear(mo, Number(m[2]), today));
	}

	// `\b` is ASCII-only; word edges are spelled out so `übermorgen` reads as one word.
	if (/(?<!\p{L})(?:day after tomorrow|übermorgen|après-demain|apres-demain)(?!\p{L})/u.test(text)) {
		push(addDays(today, 2));
	} else if (/(?<!\p{L})(?:tomorrow|morgen|demain)(?!\p{L})/u.test(text)) {
		push(addDays(today, 1));
	}
	if (/\b(?:today|tonight|end of (?:the )?day|eod|cob|heute|aujourd'hui|aujourd’hui|ce soir)\b/.test(text)) {
		push(today);
	}
	const inDays = text.match(
		/\b(?:in|within|innerhalb von|dans|sous)\s+(\d+|[a-zäöüéè]+)\s+(?:days?|tagen?|jours?)\b/
	);
	if (inDays) {
		const n = /^\d+$/.test(inDays[1] as string)
			? Number(inDays[1])
			: NUMBER_WORDS[inDays[1] as string];
		if (n === undefined) isUnsure = true;
		else push(addDays(today, n));
	}
	if (/\b(?:in a week|in one week|in einer woche|dans une semaine|dans 1 semaine)\b/.test(text)) {
		push(addDays(today, 7));
	}

	const weekdayRe = new RegExp(`\\b(${WEEKDAY_RE})\\b`, 'g');
	for (const m of text.matchAll(weekdayRe)) {
		const target = WEEKDAYS[m[1] as string] as number;
		const isNext = /\b(?:next|nächsten|nächste|kommenden?|prochain)\b/.test(text);
		const delta = (target - weekdayOf(today) + 7) % 7;
		if (isNext || delta === 0) {
			isUnsure = true;
			continue;
		}
		push(addDays(today, delta));
	}
	return { dates, isUnsure };
}

/** Resolve a deadline phrase (see the module doc). Pure. */
export function resolveDue(phrase: string, sentAt: number, timeZone: string): ResolvedDue {
	if (!phrase.trim() || !Number.isFinite(sentAt)) return { isAmbiguous: true };
	const today = partsIn(sentAt, timeZone);
	const { dates, isUnsure } = readings(phrase, today);
	const distinct = new Set(dates.map((d) => `${d.y}-${d.m}-${d.d}`));
	if (isUnsure || distinct.size !== 1) return { isAmbiguous: true };
	return { at: zonedMidnight(dates[0] as YMD, timeZone), isAmbiguous: false };
}
