/**
 * Reading comfort: the app's text size, mail text size, reading width, higher
 * contrast, an in-app "Reduce motion" override, and list density for the Team
 * Inbox, contacts and campaign lists.
 *
 * Device-local, like the theme: these answer to the screen and the eyes in
 * front of it (a phone held close, a wide monitor across the desk), not to the
 * account, so they live in this browser's localStorage and never sync. Postbox
 * density stays an account setting in mail settings; the list density here
 * covers the lists that had none.
 *
 * Pure data and pure functions (no Vue, no DOM), so validation and the
 * typography tables are unit-tested without mounting anything.
 */

export type MailTextSize = 'small' | 'default' | 'large' | 'larger';
export type ReadingWidth = 'narrow' | 'default' | 'wide' | 'full';
export type ListDensity = 'comfortable' | 'compact';
/** The app's own text, in percent of the type scale's sizes. */
export type UiTextSize = 90 | 100 | 110 | 120 | 130;

export interface ReadingComfort {
	/**
	 * Scales the type tokens (and with them mail), never spacing or layout, so
	 * larger text does not cost the room that browser zoom takes.
	 */
	uiTextSize: UiTextSize;
	textSize: MailTextSize;
	readingWidth: ReadingWidth;
	/** Stronger text and border tokens in both themes. */
	highContrast: boolean;
	/** Reduce motion even when the OS does not ask for it. Never forces motion on. */
	reduceMotion: boolean;
	listDensity: ListDensity;
}

export const READING_COMFORT_DEFAULTS: Readonly<ReadingComfort> = Object.freeze({
	uiTextSize: 100,
	textSize: 'default',
	readingWidth: 'default',
	highContrast: false,
	reduceMotion: false,
	listDensity: 'comfortable',
});

/** localStorage key. One JSON object, so a reader never sees half an update. */
export const READING_COMFORT_STORAGE_KEY = 'owlat-reading-comfort';

const TEXT_SIZES: readonly MailTextSize[] = ['small', 'default', 'large', 'larger'];
const READING_WIDTHS: readonly ReadingWidth[] = ['narrow', 'default', 'wide', 'full'];
const LIST_DENSITIES: readonly ListDensity[] = ['comfortable', 'compact'];
export const UI_TEXT_SIZES: readonly UiTextSize[] = [90, 100, 110, 120, 130];

/**
 * Picker options. Module scope never calls `useI18n`, so `label` is the catalog
 * key the settings card resolves through `t()`.
 */
const optionKey = (group: string, value: string) =>
	`components.preferences.preferencesComfort.${group}.${value}`;
export const MAIL_TEXT_SIZE_OPTIONS = TEXT_SIZES.map((value) => ({
	value,
	label: optionKey('textSize', value),
}));
export const READING_WIDTH_OPTIONS = READING_WIDTHS.map((value) => ({
	value,
	label: optionKey('readingWidth', value),
}));
export const LIST_DENSITY_OPTIONS = LIST_DENSITIES.map((value) => ({
	value,
	label: optionKey('listDensity', value),
}));

function oneOf<T extends string | number>(allowed: readonly T[], value: unknown, fallback: T): T {
	return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/**
 * Normalise whatever storage held into valid settings. Field by field: one
 * unknown value (a newer build's option, a hand edit) falls back alone instead
 * of discarding the rest; anything that is not an object is all defaults.
 */
export function resolveReadingComfort(stored: unknown): ReadingComfort {
	const d = READING_COMFORT_DEFAULTS;
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...d };
	const s = stored as Record<string, unknown>;
	return {
		uiTextSize: oneOf(UI_TEXT_SIZES, s['uiTextSize'], d.uiTextSize),
		textSize: oneOf(TEXT_SIZES, s['textSize'], d.textSize),
		readingWidth: oneOf(READING_WIDTHS, s['readingWidth'], d.readingWidth),
		highContrast: typeof s['highContrast'] === 'boolean' ? s['highContrast'] : d.highContrast,
		reduceMotion: typeof s['reduceMotion'] === 'boolean' ? s['reduceMotion'] : d.reduceMotion,
		listDensity: oneOf(LIST_DENSITIES, s['listDensity'], d.listDensity),
	};
}

/** Parse the raw localStorage string; malformed JSON is all defaults. */
export function parseReadingComfort(raw: string | null): ReadingComfort {
	if (raw === null) return { ...READING_COMFORT_DEFAULTS };
	try {
		return resolveReadingComfort(JSON.parse(raw));
	} catch {
		return { ...READING_COMFORT_DEFAULTS };
	}
}

/**
 * What changes a rendered mail body. Kept separate so the render cache keys on
 * exactly these fields and nothing else.
 */
export interface MailTypography {
	textSize: MailTextSize;
	readingWidth: ReadingWidth;
	/**
	 * Zoom on top of the text size: the app's text size times the zoom kept
	 * for the message's sender. 1 is none.
	 */
	zoom: number;
}

export const MAIL_TYPOGRAPHY_DEFAULT: Readonly<MailTypography> = Object.freeze({
	textSize: 'default',
	readingWidth: 'default',
	zoom: 1,
});

/** Multiply zoom factors, rounded so equal products give equal cache keys. */
export function combineZoom(...factors: number[]): number {
	return Math.round(factors.reduce((product, factor) => product * factor, 1) * 1000) / 1000;
}

/**
 * Effective body text size of plain ("simple") mail in the Postbox reader, in
 * px. The default is the reader's long-standing 15px; the other steps are
 * reached by scaling (see mailZoom), not by changing the base size.
 */
export const MAIL_TEXT_PX: Record<MailTextSize, number> = {
	small: 14,
	default: 15,
	large: 17,
	larger: 19,
};

/**
 * Team Inbox message text, in rem. The default is `text-sm` (0.875rem), the
 * size that view has always used; the steps follow the Postbox scale.
 */
export const INBOX_TEXT_REM: Record<MailTextSize, string> = {
	small: '0.8125rem',
	default: '0.875rem',
	large: '1rem',
	larger: '1.125rem',
};

/**
 * Maximum measure of a mail body. The default is the reader's long-standing
 * 72ch; `full` lifts the cap for people who want every line as long as the
 * pane is wide.
 */
export const READING_WIDTH_CSS: Record<ReadingWidth, string> = {
	narrow: '60ch',
	default: '72ch',
	wide: '90ch',
	full: 'none',
};

/**
 * Zoom applied to a mail body for a text size. Mail of either kind carries
 * sizes a base font size never reaches: a newsletter writes them inline, a
 * plain reply has `<span style="font-size:12px">` signatures and Outlook's
 * 11pt `MsoNormal` paragraphs. Scaling the whole body grows every one of them
 * by the same ratio and keeps images, tables and spacing in proportion, the
 * way browser zoom does. A layout wider than the pane after scaling scrolls
 * sideways inside the frame instead of being squeezed.
 */
export function mailZoom(textSize: MailTextSize): number {
	return combineZoom(MAIL_TEXT_PX[textSize] / MAIL_TEXT_PX.default);
}

/** The whole zoom a mail body gets: its text size and the zoom on top. */
export function mailBodyZoom(typography: MailTypography): number {
	return combineZoom(mailZoom(typography.textSize), typography.zoom);
}

/** Stable cache-key fragment for a typography. */
export function mailTypographyKey(typography: MailTypography): string {
	return `${typography.textSize}-${typography.readingWidth}-${typography.zoom}`;
}

/**
 * Root `<html>` attributes the CSS keys off. A value of `null` removes the
 * attribute, so a default setting leaves no trace on the document.
 */
export function readingComfortRootAttributes(
	comfort: ReadingComfort
): Record<'data-text-size' | 'data-contrast' | 'data-motion' | 'data-list-density', string | null> {
	return {
		'data-text-size': comfort.uiTextSize === 100 ? null : String(comfort.uiTextSize),
		'data-contrast': comfort.highContrast ? 'more' : null,
		'data-motion': comfort.reduceMotion ? 'reduce' : null,
		'data-list-density': comfort.listDensity === 'compact' ? 'compact' : null,
	};
}
