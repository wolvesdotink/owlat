import { describe, expect, it } from 'vitest';
import de from '../locales/de.json';
import en from '../locales/en.json';
import { metaKey } from '../useBuilderI18n';

/**
 * Guards for the builder's own catalogs (src/i18n/locales).
 *
 * `en` is the source and the fallback, so drift fails quietly: a German user
 * just meets an English line. These turn each way it drifts into a failure:
 *  - a key added to `en` and never translated (or a stale key left in `de`);
 *  - a placeholder renamed on one side, which renders the literal `{name}`;
 *  - a plural message (`one | other`) that lost a form in translation;
 *  - markup in a message (the canvas text placeholder is set as HTML);
 *  - a `builder.meta` entry filed under a key its English text does not map to,
 *    which `label()` could then never find;
 *  - a German message left identical to its English source by accident.
 */

type Catalog = { [key: string]: string | Catalog };

function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
	const flat = new Map<string, string>();
	for (const [key, value] of Object.entries(catalog)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === 'string') flat.set(path, value);
		else for (const [nested, message] of flatten(value, path)) flat.set(nested, message);
	}
	return flat;
}

function placeholders(message: string): string[] {
	return [...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]!).sort();
}

const english = flatten(en as Catalog);
const german = flatten(de as Catalog);

/**
 * German that is the English text on purpose: product and protocol names, terms
 * German borrows unchanged, single-letter abbreviations and punctuation.
 */
const IDENTICAL_BY_DESIGN = new Set([
	'builder.analysis.health.outlook',
	'builder.analysis.size.breakdown.vml',
	'builder.analysis.size.breakdown.text',
	'builder.analysis.size.breakdown.markup',
	'builder.analysis.size.links',
	'builder.preview.devices.desktop',
	'builder.preview.devices.tablet',
	'builder.preview.views.text',
	'builder.canvas.categories.text',
	'builder.canvas.categories.layout',
	'builder.toolbar.categories.design',
	'builder.toolbar.link',
	'builder.subject.name',
	'builder.subject.variable',
	'builder.panel.repeat.referenceAfter',
	'builder.panel.box.verticalShort',
	'builder.panel.box.horizontalShort',
	'builder.link.url',
]);

describe('builder message catalogs', () => {
	it('keeps every message under builder.*', () => {
		expect(Object.keys(en)).toEqual(['builder']);
		expect(Object.keys(de)).toEqual(['builder']);
	});

	it('de covers every en key and nothing else', () => {
		const missing = [...english.keys()].filter((key) => !german.has(key));
		const extra = [...german.keys()].filter((key) => !english.has(key));
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	});

	it('de keeps every placeholder and plural form', () => {
		const drifted = [...english].filter(([key, message]) => {
			const translated = german.get(key) ?? '';
			return (
				placeholders(translated).join() !== placeholders(message).join() ||
				translated.split('|').length !== message.split('|').length
			);
		});
		expect(drifted.map(([key]) => key)).toEqual([]);
	});

	it('carries no markup', () => {
		const offenders = [...english, ...german]
			.filter(([, message]) => /[<>]/.test(message))
			.map(([key]) => key);
		expect(offenders).toEqual([]);
	});

	it('files every registry translation under the key its English text maps to', () => {
		const misfiled = [...english]
			.filter(([key]) => key.startsWith('builder.meta.'))
			.filter(([key, source]) => metaKey(source) !== key)
			.map(([key]) => key);
		expect(misfiled).toEqual([]);
	});

	it('translates every message unless it is identical by design', () => {
		const untranslated = [...english]
			.filter(([key, message]) => german.get(key) === message && !IDENTICAL_BY_DESIGN.has(key))
			.map(([key]) => key);
		expect(untranslated).toEqual([]);
		const stale = [...IDENTICAL_BY_DESIGN].filter((key) => german.get(key) !== english.get(key));
		expect(stale).toEqual([]);
	});

	it('addresses the reader informally (du, never Sie)', () => {
		const formal = [...german]
			.filter(([, message]) => /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer)\b/.test(message))
			.map(([key]) => key);
		expect(formal).toEqual([]);
	});
});
