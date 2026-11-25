import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import { extractTranslatableContent, itemTextKey } from '../../emailTemplates/translationMerge';
import {
	addLanguage,
	mergeTranslationWithContent,
	parseTranslations,
	removeLanguage,
	resolveForLanguage,
	serializeTranslations,
	setDefaultLanguagePatch,
	updateTranslationPatch,
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

describe('a stored translations blob is decoded, not cast', () => {
	it.each([
		['a subject that is not a string', { de: { subject: 7, blocks: {} } }],
		['block text that is not a string', { de: { subject: 'Hallo', blocks: { b1: { html: 5 } } } }],
		['an overlay that is a list', { de: [] }],
		['a JSON scalar', 42],
	])('refuses a blob with %s instead of serving or rewriting it', (_label, blob) => {
		expect(() => parseTranslations(JSON.stringify(blob))).toThrow(/malformed/);
		// A write on top of it would otherwise replace the damaged blob.
		expect(() =>
			addLanguage(
				templateEntity({ translations: JSON.stringify(blob) }),
				'fr',
				TEMPLATE_TRANSLATABLE_FIELDS
			)
		).toThrow(/malformed/);
	});

	it('reads an older overlay without subject or blocks, falling back to the default', () => {
		const entity = templateEntity({
			translations: JSON.stringify({ de: { previewText: 'Vorschau' } }),
			supportedLanguages: ['en', 'de'],
		});
		expect(resolveForLanguage(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS)).toEqual({
			resolvedLanguage: 'de',
			subject: 'Welcome',
			previewText: 'Vorschau',
			content: CONTENT,
		});
	});

	it('keeps a field a newer release stored on an overlay', () => {
		const blob = { de: { subject: 'Hallo', blocks: {}, tone: 'formal' } };
		expect(parseTranslations(JSON.stringify(blob))).toEqual(blob);
	});
});

describe('updateTranslationPatch refuses malformed block text', () => {
	const entity = templateEntity({
		translations: JSON.stringify({ de: { subject: 'Hallo', blocks: {} } }),
		supportedLanguages: ['en', 'de'],
	});

	it.each([
		['an html value that is a number', '{"b1":{"html":5}}'],
		['a list', '[{"html":"<p>Hi</p>"}]'],
		['text that is not JSON', '{"b1":'],
	])('rejects %s as invalid input', (_label, blocks) => {
		expect(
			categoryOf(() =>
				updateTranslationPatch(entity, { language: 'de', blocks }, TEMPLATE_TRANSLATABLE_FIELDS)
			)
		).toBe('invalid_input');
	});

	it('stores well-formed block text', () => {
		const patch = updateTranslationPatch(
			entity,
			{ language: 'de', blocks: '{"b1":{"html":"<p>Hallo</p>"}}' },
			TEMPLATE_TRANSLATABLE_FIELDS
		);
		expect(parseTranslations(patch.translations)['de']!.blocks).toEqual({
			b1: { html: '<p>Hallo</p>' },
		});
	});
});

describe('extractTranslatableContent', () => {
	it('carries over only string text, and nothing from a document that is not a Block list', () => {
		const content = JSON.stringify([
			{ id: 'b1', type: 'text', content: { html: 5 } },
			{ id: 'b2', type: 'button', content: { text: 'Click' } },
		]);
		expect(extractTranslatableContent(content)).toEqual({ b2: { buttonText: 'Click' } });
		expect(extractTranslatableContent('{"blocks":[]}')).toEqual({});
		expect(extractTranslatableContent('[{"id":"b1","type":"text"}]')).toEqual({});
	});

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
		const merged = JSON.parse(
			mergeTranslationWithContent(CONTENT, { b1: { html: '<p>Hallo</p>' } })
		);
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
			TRANSACTIONAL_TRANSLATABLE_FIELDS
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

	it('sanitizes the seeded text block html', () => {
		const content = JSON.stringify([
			{
				id: 'b1',
				type: 'text',
				content: { html: '<p>Hi</p><img src="x" onerror="window.__x=1">' },
			},
		]);
		const patch = addLanguage(templateEntity({ content }), 'de', TEMPLATE_TRANSLATABLE_FIELDS);
		const html = parseTranslations(patch.translations)['de']!.blocks!['b1']!.html;
		expect(html).toContain('Hi');
		expect(html).not.toContain('onerror');
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
		expect(categoryOf(() => addLanguage(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS))).toBe(
			'already_exists'
		);
	});

	it('rejects a language already in supportedLanguages (already_exists)', () => {
		const entity = templateEntity({ supportedLanguages: ['en', 'de'] });
		expect(categoryOf(() => addLanguage(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS))).toBe(
			'already_exists'
		);
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
		expect(
			categoryOf(() => removeLanguage(templateEntity({ supportedLanguages: ['en'] }), 'es'))
		).toBe('not_found');
	});
});

// Hero children (and anything nested in them) go through the same child
// contract as columns and containers: seeded, merged and resolved alike, for
// templates and transactional emails.
describe('Hero descendants', () => {
	const HERO_CONTENT = JSON.stringify([
		{
			id: 'hero',
			type: 'hero',
			content: {
				backgroundImage: 'https://example.com/bg.png',
				height: 400,
				items: [
					{ id: 'h-text', type: 'text', content: { html: '<p>Welcome</p>', textColor: '#fff' } },
					{
						id: 'h-btn',
						type: 'button',
						content: { text: 'Shop now', url: 'https://example.com' },
					},
					{
						id: 'h-img',
						type: 'image',
						content: { src: 'https://example.com/a.png', alt: 'Logo' },
					},
					{
						id: 'h-box',
						type: 'container',
						content: {
							items: [
								{
									id: 'h-cols',
									type: 'columns',
									content: {
										columns: [[{ id: 'h-deep', type: 'text', content: { html: '<p>Deep</p>' } }]],
									},
								},
							],
						},
					},
				],
			},
		},
	]);

	const GERMAN: Translation['blocks'] = {
		'h-text': { html: '<p>Willkommen</p>' },
		'h-btn': { buttonText: 'Jetzt kaufen' },
		'h-img': { alt: 'Firmenlogo' },
		'h-deep': { html: '<p>Tief</p>' },
	};

	it('extracts text, button and image descendants and a nested composite', () => {
		expect(extractTranslatableContent(HERO_CONTENT)).toEqual({
			'h-text': { html: '<p>Welcome</p>' },
			'h-btn': { buttonText: 'Shop now' },
			'h-img': { alt: 'Logo' },
			'h-deep': { html: '<p>Deep</p>' },
		});
	});

	it('merges the overlay into each descendant and keeps styling and structure', () => {
		const [hero] = JSON.parse(mergeTranslationWithContent(HERO_CONTENT, GERMAN));
		const [text, button, image, box] = hero.content.items;
		expect(hero.content.backgroundImage).toBe('https://example.com/bg.png');
		expect(hero.content.height).toBe(400);
		expect(text.content).toEqual({ html: '<p>Willkommen</p>', textColor: '#fff' });
		expect(button.content).toEqual({ text: 'Jetzt kaufen', url: 'https://example.com' });
		expect(image.content).toEqual({ src: 'https://example.com/a.png', alt: 'Firmenlogo' });
		expect(box.content.items[0].content.columns[0][0].content.html).toBe('<p>Tief</p>');
	});

	it.each([
		['template', TEMPLATE_TRANSLATABLE_FIELDS],
		['transactional email', TRANSACTIONAL_TRANSLATABLE_FIELDS],
	] as const)('seeds and resolves a language through the hero for a %s', (kind, fields) => {
		const entity = templateEntity({ content: HERO_CONTENT });
		const seeded = parseTranslations(addLanguage(entity, 'de', fields).translations);
		expect(Object.keys(seeded['de']!.blocks!).sort()).toEqual([
			'h-btn',
			'h-deep',
			'h-img',
			'h-text',
		]);

		const translated = templateEntity({
			content: HERO_CONTENT,
			supportedLanguages: ['en', 'de'],
			translations: serializeTranslations({ de: { subject: 'Hallo', blocks: GERMAN } }),
		});
		const resolved = resolveForLanguage(translated, 'de', fields);
		const items = JSON.parse(resolved.content)[0].content.items;
		expect(items[0].content.html).toBe('<p>Willkommen</p>');
		expect(items[1].content.text).toBe('Jetzt kaufen');
		expect(items[2].content.alt).toBe('Firmenlogo');
		expect(items[3].content.items[0].content.columns[0][0].content.html).toBe('<p>Tief</p>');
	});

	it('translates two copies with distinct child ids independently', () => {
		const copy = (rootId: string, childId: string) => ({
			id: rootId,
			type: 'columns',
			content: { columns: [[{ id: childId, type: 'text', content: { html: '<p>Hi</p>' } }]] },
		});
		const content = JSON.stringify([copy('a', 'a-text'), copy('b', 'b-text')]);
		const merged = JSON.parse(
			mergeTranslationWithContent(content, { 'b-text': { html: '<p>Hallo</p>' } })
		);
		expect(merged[0].content.columns[0][0].content.html).toBe('<p>Hi</p>');
		expect(merged[1].content.columns[0][0].content.html).toBe('<p>Hallo</p>');
	});
});

describe('list items, table text, menu labels and accordion titles', () => {
	const k = itemTextKey;
	const LIST = {
		id: 'list',
		type: 'list',
		content: { items: ['Free shipping', 'Easy returns'], listType: 'bullet' },
	};
	const TABLE = {
		id: 'table',
		type: 'table',
		content: {
			headers: ['Product', 'Price'],
			rows: [
				['Shirt', '49'],
				['Socks', '9'],
			],
			footerRow: ['Total', '58'],
			captionText: 'Your order',
		},
	};
	const MENU = {
		id: 'menu',
		type: 'menu',
		content: {
			items: [
				{ label: 'Shop', url: 'https://owlat.com/shop' },
				{ label: 'Help', url: 'https://owlat.com/help' },
			],
		},
	};
	const ACCORDION = {
		id: 'acc',
		type: 'accordion',
		content: {
			sections: [
				{
					id: 's1',
					title: 'Shipping',
					items: [{ id: 'acc-text', type: 'text', content: { html: '<p>Three days</p>' } }],
				},
			],
		},
	};
	// The table sits in a column, so the merge must reach a nested Block.
	const CONTENT_ALL = JSON.stringify([
		LIST,
		{ id: 'cols', type: 'columns', content: { columns: [[TABLE], [MENU]] } },
		ACCORDION,
	]);
	const GERMAN = {
		list: {
			texts: {
				[k('Free shipping')]: 'Kostenloser Versand',
				[k('Easy returns')]: 'Einfache Rückgabe',
			},
		},
		table: {
			texts: {
				[k('Product')]: 'Produkt',
				[k('Price')]: 'Preis',
				[k('Shirt')]: 'Hemd',
				[k('Socks')]: 'Socken',
				[k('Total')]: 'Summe',
				[k('Your order')]: 'Deine Bestellung',
			},
		},
		menu: { texts: { [k('Shop')]: 'Laden', [k('Help')]: 'Hilfe' } },
		acc: { sectionTitles: { s1: 'Versand' } },
		'acc-text': { html: '<p>Drei Tage</p>' },
	};

	it('seeds a language with every item text, keyed by its source', () => {
		const seeded = extractTranslatableContent(CONTENT_ALL);
		expect(seeded['list']).toEqual({
			texts: { [k('Free shipping')]: 'Free shipping', [k('Easy returns')]: 'Easy returns' },
		});
		expect(Object.values(seeded['table']!.texts!)).toEqual([
			'Product',
			'Price',
			'Shirt',
			'49',
			'Socks',
			'9',
			'Total',
			'58',
			'Your order',
		]);
		expect(seeded['menu']).toEqual({ texts: { [k('Shop')]: 'Shop', [k('Help')]: 'Help' } });
		expect(seeded['acc']).toEqual({ sectionTitles: { s1: 'Shipping' } });
		expect(seeded['acc-text']).toEqual({ html: '<p>Three days</p>' });
	});

	it('merges item texts at any depth and keeps untranslated text and links', () => {
		const [list, columns, accordion] = JSON.parse(mergeTranslationWithContent(CONTENT_ALL, GERMAN));
		expect(list.content.items).toEqual(['Kostenloser Versand', 'Einfache Rückgabe']);
		const [[table], [menu]] = columns.content.columns;
		expect(table.content.headers).toEqual(['Produkt', 'Preis']);
		expect(table.content.rows).toEqual([
			['Hemd', '49'],
			['Socken', '9'],
		]);
		expect(table.content.footerRow).toEqual(['Summe', '58']);
		expect(table.content.captionText).toBe('Deine Bestellung');
		expect(menu.content.items).toEqual([
			{ label: 'Laden', url: 'https://owlat.com/shop' },
			{ label: 'Hilfe', url: 'https://owlat.com/help' },
		]);
		expect(accordion.content.sections[0].title).toBe('Versand');
		expect(accordion.content.sections[0].items[0].content.html).toBe('<p>Drei Tage</p>');
	});

	it('translates the rich cells of a table that has them', () => {
		const content = JSON.stringify([
			{
				id: 'table',
				type: 'table',
				content: { headers: [], rows: [['Shirt']], cells: [[{ content: 'Shirt', colSpan: 2 }]] },
			},
		]);
		const [table] = JSON.parse(mergeTranslationWithContent(content, GERMAN));
		expect(table.content.cells).toEqual([[{ content: 'Hemd', colSpan: 2 }]]);
	});

	it('keeps each translation on its own item after the author reorders or changes them', () => {
		// The author moved "Easy returns" up, rewrote "Free shipping" and added an item.
		const edited = JSON.stringify([
			{
				...LIST,
				content: {
					...LIST.content,
					items: ['Easy returns', 'Free shipping worldwide', 'Gift wrap'],
				},
			},
			{
				...TABLE,
				content: {
					...TABLE.content,
					rows: [
						['Socks', '9'],
						['Shirt', '49'],
					],
				},
			},
		]);
		const [list, table] = JSON.parse(mergeTranslationWithContent(edited, GERMAN));
		expect(list.content.items).toEqual([
			'Einfache Rückgabe',
			'Free shipping worldwide',
			'Gift wrap',
		]);
		expect(table.content.rows).toEqual([
			['Socken', '9'],
			['Hemd', '49'],
		]);
	});

	it('stores item texts and refuses one that is not text', () => {
		const entity = templateEntity({
			content: CONTENT_ALL,
			translations: JSON.stringify({ de: { subject: 'Hallo', blocks: {} } }),
			supportedLanguages: ['en', 'de'],
		});
		const patch = updateTranslationPatch(
			entity,
			{ language: 'de', blocks: JSON.stringify(GERMAN) },
			TEMPLATE_TRANSLATABLE_FIELDS
		);
		expect(parseTranslations(patch.translations)['de']!.blocks).toEqual(GERMAN);
		expect(
			categoryOf(() =>
				updateTranslationPatch(
					entity,
					{ language: 'de', blocks: '{"list":{"texts":{"a":5}}}' },
					TEMPLATE_TRANSLATABLE_FIELDS
				)
			)
		).toBe('invalid_input');
	});

	it('shows the source of an item whose translation was cleared, and keeps the others in place on a swap', () => {
		const menu = (labels: string[]) => ({
			id: 'menu',
			type: 'menu',
			content: { items: labels.map((label) => ({ label, url: 'https://owlat.com' })) },
		});
		const entity = templateEntity({
			content: JSON.stringify([menu(['Contact us', 'Contact'])]),
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: {
					subject: 'Hallo',
					blocks: { menu: { texts: { [k('Contact us')]: '', [k('Contact')]: 'Kontakt' } } },
				},
			}),
		});
		const labels = (content: string, blocks: Record<string, unknown>) =>
			JSON.parse(mergeTranslationWithContent(content, blocks as never))[0].content.items.map(
				(item: { label: string }) => item.label
			);
		expect(labels(entity.content, parseTranslations(entity.translations)['de']!.blocks!)).toEqual([
			'Contact us',
			'Kontakt',
		]);
		const patch = setDefaultLanguagePatch(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS)!;
		const en = parseTranslations(patch.translations)['en']!.blocks!;
		expect(labels(patch.content!, en)).toEqual(['Contact us', 'Contact']);
	});

	it('leaves items untranslated rather than wrong when two texts become one on a swap', () => {
		const entity = templateEntity({
			content: JSON.stringify([
				{ ...LIST, content: { ...LIST.content, items: ['Contact us', 'Contact'] } },
			]),
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: {
					subject: 'Hallo',
					blocks: { list: { texts: { [k('Contact us')]: 'Kontakt', [k('Contact')]: 'Kontakt' } } },
				},
			}),
		});
		const patch = setDefaultLanguagePatch(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS)!;
		const en = parseTranslations(patch.translations)['en']!.blocks!;
		expect(JSON.parse(mergeTranslationWithContent(patch.content!, en))[0].content.items).toEqual([
			'Kontakt',
			'Kontakt',
		]);
	});

	it('moves every overlay onto the new default text when a language becomes the default', () => {
		const french = { list: { texts: { [k('Free shipping')]: 'Livraison gratuite' } } };
		const entity = templateEntity({
			content: JSON.stringify([LIST]),
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de', 'fr'],
			translations: JSON.stringify({
				de: { subject: 'Hallo', blocks: { list: GERMAN.list } },
				fr: { subject: 'Bonjour', blocks: french },
			}),
		});
		const patch = setDefaultLanguagePatch(entity, 'de', TEMPLATE_TRANSLATABLE_FIELDS)!;
		expect(JSON.parse(patch.content!)[0].content.items).toEqual([
			'Kostenloser Versand',
			'Einfache Rückgabe',
		]);
		const translations = parseTranslations(patch.translations);
		const contentDe = patch.content!;
		expect(
			JSON.parse(mergeTranslationWithContent(contentDe, translations['en']!.blocks!))[0].content
				.items
		).toEqual(['Free shipping', 'Easy returns']);
		expect(
			JSON.parse(mergeTranslationWithContent(contentDe, translations['fr']!.blocks!))[0].content
				.items
		).toEqual(['Livraison gratuite', 'Einfache Rückgabe']);
	});
});
