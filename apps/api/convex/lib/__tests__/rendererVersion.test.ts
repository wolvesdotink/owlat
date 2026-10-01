import { describe, it, expect } from 'vitest';
import { rendererVersionAfterWrite, UNSTAMPED_RENDERER_VERSION } from '../rendererVersion';

const DE_HTML = JSON.stringify({ de: { htmlContent: '<p>Hallo</p>', subject: 'Hallo' } });
const ALL = { htmlContent: true, htmlTranslations: true };
const ONE_LANGUAGE = { htmlContent: false, htmlTranslations: false };

describe('rendererVersionAfterWrite', () => {
	it('records the written version when the write replaces all stored HTML', () => {
		const row = { rendererVersion: 1, htmlContent: '<p>a</p>', htmlTranslations: DE_HTML };
		expect(rendererVersionAfterWrite(row, 2, ALL)).toBe(2);
	});

	it('records version 1 for HTML from a caller that reports no version', () => {
		const row = { rendererVersion: 2, htmlContent: '<p>a</p>' };
		expect(rendererVersionAfterWrite(row, undefined, ALL)).toBe(UNSTAMPED_RENDERER_VERSION);
	});

	it('treats default HTML alone as everything when the row has no translated HTML', () => {
		const writes = { htmlContent: true, htmlTranslations: false };
		expect(
			rendererVersionAfterWrite({ rendererVersion: 1, htmlContent: '<p>a</p>' }, 2, writes)
		).toBe(2);
		expect(
			rendererVersionAfterWrite({ rendererVersion: 1, htmlTranslations: '{}' }, 2, writes)
		).toBe(2);
		// An unreadable blob delivers nothing either.
		expect(
			rendererVersionAfterWrite({ rendererVersion: 1, htmlTranslations: 'not json' }, 2, writes)
		).toBe(2);
	});

	it('keeps the older version when older HTML stays in the row', () => {
		const row = { rendererVersion: 1, htmlContent: '<p>a</p>', htmlTranslations: DE_HTML };
		expect(rendererVersionAfterWrite(row, 2, ONE_LANGUAGE)).toBe(1);
		expect(rendererVersionAfterWrite(row, 2, { htmlContent: true, htmlTranslations: false })).toBe(
			1
		);
		expect(rendererVersionAfterWrite(row, 2, { htmlContent: false, htmlTranslations: true })).toBe(
			1
		);
	});

	it('lowers the version when the new HTML is older than what the row holds', () => {
		const row = { rendererVersion: 2, htmlContent: '<p>a</p>' };
		expect(rendererVersionAfterWrite(row, 1, ONE_LANGUAGE)).toBe(1);
	});

	it('treats an unstamped row as version 1', () => {
		const row = { htmlContent: '<p>a</p>' };
		expect(rendererVersionAfterWrite(row, 2, ONE_LANGUAGE)).toBe(1);
	});

	it('records the written version for the first HTML a row stores', () => {
		expect(rendererVersionAfterWrite({ rendererVersion: 1 }, 2, ONE_LANGUAGE)).toBe(2);
	});
});
