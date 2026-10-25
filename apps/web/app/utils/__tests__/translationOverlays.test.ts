import { describe, expect, it } from 'vitest';
import { readTranslationOverlays, requireTranslationOverlays } from '../translationOverlays';

const DE = {
	subject: 'Betreff',
	previewText: 'Vorschau',
	blocks: { b1: { html: '<p>Hallo</p>' }, b2: { buttonText: 'Los' }, b3: { alt: 'Bild' } },
};

describe('readTranslationOverlays', () => {
	it('reads an absent or empty blob as no overlays', () => {
		expect(readTranslationOverlays(undefined)).toEqual({});
		expect(readTranslationOverlays('')).toEqual({});
	});

	it('reads overlays, keeping fields and languages it does not render', () => {
		const stored = { de: { ...DE, legacy: true }, fr: { subject: 'Sujet' }, es: {} };
		expect(readTranslationOverlays(JSON.stringify(stored))).toEqual(stored);
	});

	it.each([
		['not JSON', '{de:'],
		['a list', '[]'],
		['null', 'null'],
		['a language that is a string', JSON.stringify({ de: 'Hallo' })],
		['a language that is null', JSON.stringify({ de: null })],
		['a non-string subject', JSON.stringify({ de: { ...DE, subject: 1 } })],
		['a non-string preview text', JSON.stringify({ de: { ...DE, previewText: false } })],
		['blocks that are a list', JSON.stringify({ de: { ...DE, blocks: [] } })],
		['a Block entry that is text', JSON.stringify({ de: { ...DE, blocks: { b1: 'Hallo' } } })],
		['non-string Block text', JSON.stringify({ de: { ...DE, blocks: { b1: { alt: 3 } } } })],
	])('refuses a blob that is %s', (_case, blob) => {
		expect(readTranslationOverlays(blob)).toBeNull();
		expect(() => requireTranslationOverlays(blob)).toThrow();
	});
});
