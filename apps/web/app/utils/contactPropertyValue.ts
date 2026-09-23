/**
 * How a stored custom-property value reads on the contact page.
 *
 * Values are stored as strings whatever the property's type, so without this a
 * yes/no property shows `true` and a date shows `2026-11-09`. Pure: the caller
 * hands in the translated Yes/No and a locale-aware date formatter.
 */
export type ContactPropertyType = 'string' | 'number' | 'boolean' | 'date';

export interface ContactPropertyFormat {
	yes: string;
	no: string;
	date: (value: Date) => string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date-only value (what the date input stores) is a calendar day, not an
 * instant: build it in local time so it never shifts to the day before in a
 * time zone west of UTC.
 */
function parseDate(raw: string): Date | null {
	const dateOnly = DATE_ONLY.exec(raw);
	if (dateOnly) {
		const [, year, month, day] = dateOnly;
		return new Date(Number(year), Number(month) - 1, Number(day));
	}
	const asNumber = Number(raw);
	const parsed =
		Number.isFinite(asNumber) && raw.trim() !== '' ? new Date(asNumber) : new Date(raw);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Returns `null` for an empty value so the caller can show its "Not set" copy. */
export function formatContactPropertyValue(
	type: string,
	raw: string | null | undefined,
	format: ContactPropertyFormat
): string | null {
	if (raw === null || raw === undefined || raw === '') return null;
	if (type === 'boolean') {
		if (raw === 'true') return format.yes;
		if (raw === 'false') return format.no;
		return raw;
	}
	if (type === 'date') {
		const date = parseDate(raw);
		return date ? format.date(date) : raw;
	}
	return raw;
}
