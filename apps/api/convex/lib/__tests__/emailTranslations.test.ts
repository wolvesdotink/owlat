import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import {
	addLanguage,
	extractTranslatableContent,
	mergeTranslationWithContent,
	parseTranslations,
	removeLanguage,
	resolveForLanguage,
	serializeTranslations,
	TEMPLATE_TRANSLATABLE_FIELDS,
	TRANSACTIONAL_TRANSLATABLE_FIELDS,
	type Translation,
	type TranslatableEntity,
} from '../emailTranslations';

/** Extract the OperationError category from a thrown ConvexError. */
function categoryOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		if (err instanceof ConvexError) {
			return (err.data as { category: string }).category;
		}
		throw err;
	}
	throw new Error('expected fn to throw');
}

// A default-language content document (block array serialized to a string).
const CONTENT = JSON.stringify([
	{ id: 'b1', type: 'text', content: { html: '<p>Hello</p>' } },
	{ id: 'b2', type: 'button', content: { text: 'Click', url: 'https://x' } },
]);

function templateEntity(overrides: Partial<TranslatableEntity> = {}): TranslatableEntity {
	return {
		subject: 'Welcome',
		previewText: 'Preview',
		content: CONTENT,
		defaultLanguage: 'en',
		supportedLanguages: ['en'],
		...overrides,
	};
}

describe('parse/serialize translations blob', () => {
	it('parses an undefined blob to an empty record and round-trips', () => {
		expect(parseTranslations(undefined)).toEqual({});
		const blob: Record<string, Translation> = { de: { subject: 'Hallo', blocks: {} } };
		expect(parseTranslations(serializeTranslations(blob))).toEqual(blob);
	});
});

describe('extractTranslatableContent', () => {
	it('extracts translatable text keyed by block id, ignoring styling', () => {
		expect(extractTranslatableContent(CONTENT)).toEqual({
			b1: { html: '<p>Hello</p>' },
			b2: { buttonText: 'Click' },
		});
	});

	it('returns an empty record for malformed JSON', () => {
		expect(extractTranslatableContent('not json')).toEqual({});
	});
});

describe('mergeTranslationWithContent', () => {
	it('overlays translated text onto the default content structure', () => {
		const merged = JSON.parse(mergeTranslationWithContent(CONTENT, { b1: { html: '<p>Hallo</p>' } }));
		expect(merged[0].content.html).toBe('<p>Hallo</p>');
		// Untranslated block keeps its default text; styling (url) is preserved.
		expect(merged[1].content.text).toBe('Click');
		expect(merged[1].content.url).toBe('https://x');
	});
});

describe('resolveForLanguage', () => {
	it('returns default content for the default language', () => {
		const resolved = resolveForLanguage(templateEntity(), 'en', TEMPLATE_TRANSLATABLE_FIELDS);
		expect(resolved.resolvedLanguage).toBe('en');
		expect(resolved.subject).toBe('Welcome');
		expect(resolved.previewText).toBe('Preview');
		expect(resolved.content).toBe(CONTENT);
	});

	it('merges the overlay for a translated non-default language', () => {
		const entity = templateEntity({
			supportedLanguages: ['en', 'de'],
			translations: serializeTranslations({
				de: { subject: 'Hallo', previewText: 'Vorschau', blocks: { b1: { html: '<p>Hallo</p>' } } },
			}),
		});
		const resolved = resolveForLanguage(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS);
		expect(resolved.resolvedLanguage).toBe('de');
		expect(resolved.subject).toBe('Hallo');
		expect(resolved.previewText).toBe('Vorschau');
		expect(JSON.parse(resolved.content)[0].content.html).toBe('<p>Hallo</p>');
	});

	it('falls back to default content when the overlay is missing', () => {
		const resolved = resolveForLanguage(templateEntity(), 'fr', TEMPLATE_TRANSLATABLE_FIELDS);
		expect(resolved.resolvedLanguage).toBe('en');
		expect(resolved.subject).toBe('Welcome');
	});

	it('omits previewText for entities without that field', () => {
		const resolved = resolveForLanguage(
			templateEntity({ previewText: undefined }),
			'en',
			TRANSACTIONAL_TRANSLATABLE_FIELDS,
		);
		expect('previewText' in resolved).toBe(false);
	});
});

describe('addLanguage', () => {
	it('seeds a new overlay from default text and extends supportedLanguages', () => {
		const patch = addLanguage(templateEntity(), 'de', TEMPLATE_TRANSLATABLE_FIELDS);
		expect(patch.supportedLanguages).toEqual(['en', 'de']);
		const overlay = parseTranslations(patch.translations)['de'];
		expect(overlay).toBeDefined();
		expect(overlay!.subject).toBe('Welcome');
		expect(overlay!.previewText).toBe('Preview');
		expect(overlay!.blocks).toEqual({ b1: { html: '<p>Hello</p>' }, b2: { buttonText: 'Click' } });
	});

	it('does not seed previewText for entities without that field', () => {
		const patch = addLanguage(templateEntity(), 'de', TRANSACTIONAL_TRANSLATABLE_FIELDS);
		const overlay = parseTranslations(patch.translations)['de'];
		expect(overlay).toBeDefined();
		expect('previewText' in overlay!).toBe(false);
	});

	it('rejects a language that already has an overlay (already_exists)', () => {
		const entity = templateEntity({
			supportedLanguages: ['en', 'de'],
			translations: serializeTranslations({ de: { subject: 'Hallo', blocks: {} } }),
		});
		expect(categoryOf(() => addLanguage(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS))).toBe('already_exists');
	});

	it('rejects a language already in supportedLanguages (already_exists)', () => {
		const entity = templateEntity({ supportedLanguages: ['en', 'de'] });
		expect(categoryOf(() => addLanguage(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS))).toBe('already_exists');
	});
});

describe('removeLanguage', () => {
	it('drops the overlay and the supportedLanguages entry', () => {
		const entity = templateEntity({
			supportedLanguages: ['en', 'de', 'fr'],
			translations: serializeTranslations({
				de: { subject: 'Hallo', blocks: {} },
				fr: { subject: 'Bonjour', blocks: {} },
			}),
		});
		const patch = removeLanguage(entity, 'de');
		expect(patch.supportedLanguages).toEqual(['en', 'fr']);
		const translations = parseTranslations(patch.translations);
		expect(translations['de']).toBeUndefined();
		expect(translations['fr']).toBeDefined();
	});

	it('refuses to remove the default language with a unified invalid_input guard', () => {
		expect(categoryOf(() => removeLanguage(templateEntity(), 'en'))).toBe('invalid_input');
	});

	it('throws not_found for a missing overlay', () => {
		expect(categoryOf(() => removeLanguage(templateEntity({ supportedLanguages: ['en'] }), 'es'))).toBe(
			'not_found',
		);
	});
});
