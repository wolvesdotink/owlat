/**
 * The reading-comfort settings as stored on this device: what an untouched
 * device gets, what survives a bad or partial stored value, and the tables the
 * mail readers and the root attributes are built from.
 */
import { describe, expect, it } from 'vitest';
import {
	mailBodyZoom,
	mailZoom,
	MAIL_TEXT_PX,
	mailTypographyKey,
	parseReadingComfort,
	READING_COMFORT_DEFAULTS,
	readingComfortRootAttributes,
	resolveReadingComfort,
} from '../readingComfort';

describe('resolveReadingComfort', () => {
	it('gives an untouched device the defaults, which keep today’s reader', () => {
		expect(parseReadingComfort(null)).toEqual({
			uiTextSize: 100,
			textSize: 'default',
			readingWidth: 'default',
			highContrast: false,
			reduceMotion: false,
			listDensity: 'comfortable',
		});
		// The default size is the reader's long-standing 15px.
		expect(MAIL_TEXT_PX[READING_COMFORT_DEFAULTS.textSize]).toBe(15);
	});

	it('keeps every valid stored field', () => {
		const stored = {
			uiTextSize: 90,
			textSize: 'larger',
			readingWidth: 'full',
			highContrast: true,
			reduceMotion: true,
			listDensity: 'compact',
		};
		expect(resolveReadingComfort(stored)).toEqual(stored);
	});

	it('falls back field by field, so one bad value does not discard the rest', () => {
		expect(
			resolveReadingComfort({
				uiTextSize: 115,
				textSize: 'huge',
				readingWidth: 42,
				highContrast: 'yes',
				reduceMotion: true,
				listDensity: 'compact',
				unknownField: 'ignored',
			})
		).toEqual({
			...READING_COMFORT_DEFAULTS,
			reduceMotion: true,
			listDensity: 'compact',
		});
	});

	it('treats malformed storage as all defaults', () => {
		for (const raw of ['{not json', '"compact"', '[]', 'null', '42']) {
			expect(parseReadingComfort(raw)).toEqual(READING_COMFORT_DEFAULTS);
		}
	});

	it('hands out copies, never the frozen defaults', () => {
		const comfort = parseReadingComfort(null);
		comfort.textSize = 'large';
		expect(READING_COMFORT_DEFAULTS.textSize).toBe('default');
	});
});

describe('mail typography', () => {
	it('scales mail by the ratio of the effective text sizes', () => {
		expect(mailZoom('default')).toBe(1);
		expect(mailZoom('small')).toBe(0.933);
		expect(mailZoom('large')).toBe(1.133);
		expect(mailZoom('larger')).toBe(1.267);
	});

	it('keys every size, width and zoom combination apart', () => {
		const keys = new Set<string>();
		for (const textSize of ['small', 'default', 'large', 'larger'] as const) {
			for (const readingWidth of ['narrow', 'default', 'wide', 'full'] as const) {
				for (const zoom of [1, 1.25]) keys.add(mailTypographyKey({ textSize, readingWidth, zoom }));
			}
		}
		expect(keys.size).toBe(32);
	});

	it('multiplies the zoom on top into the text size’s zoom', () => {
		expect(mailBodyZoom({ textSize: 'default', readingWidth: 'default', zoom: 1 })).toBe(1);
		expect(mailBodyZoom({ textSize: 'default', readingWidth: 'default', zoom: 1.3 })).toBe(1.3);
		expect(mailBodyZoom({ textSize: 'large', readingWidth: 'default', zoom: 1.5 })).toBe(1.7);
	});
});

describe('readingComfortRootAttributes', () => {
	it('leaves no attribute on the document for the defaults', () => {
		expect(readingComfortRootAttributes(READING_COMFORT_DEFAULTS)).toEqual({
			'data-text-size': null,
			'data-contrast': null,
			'data-motion': null,
			'data-list-density': null,
		});
	});

	it('names each non-default setting the CSS keys off', () => {
		expect(
			readingComfortRootAttributes({
				...READING_COMFORT_DEFAULTS,
				uiTextSize: 110,
				highContrast: true,
				reduceMotion: true,
				listDensity: 'compact',
			})
		).toEqual({
			'data-text-size': '110',
			'data-contrast': 'more',
			'data-motion': 'reduce',
			'data-list-density': 'compact',
		});
	});
});
