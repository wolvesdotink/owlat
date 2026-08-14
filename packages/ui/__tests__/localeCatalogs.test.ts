import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import de from '../i18n/locales/de.json';
import en from '../i18n/locales/en.json';

/**
 * Guards for the LAYER message catalogs (packages/ui/i18n/locales), modelled on
 * apps/web/app/__tests__/localeCatalogs.test.ts.
 *
 * These files are merged into every app that extends this layer, so drift here
 * is drift in three products at once: `en` is the source of truth and the
 * `fallbackLocale`, so a stale German key just renders an English line in the
 * middle of a German page. The checks turn each way that happens into a failure:
 *  - a key added to `en` and never translated (or a stale key left behind);
 *  - a placeholder renamed on one side only, which renders the literal `{step}`;
 *  - markup smuggled into a message, which @nuxtjs/i18n rejects at BUILD time
 *    (`compilation.strictMessage`) — a broken deploy, not a broken string;
 *  - a bare `@`, which the message compiler reads as a linked-message marker;
 *  - and, unique to a shared layer: a `ui.*` key a component asks for but the
 *    catalog does not carry (or carries and nothing renders).
 */

type Catalog = { [key: string]: string | Catalog };

function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
	const flat = new Map<string, string>();
	for (const [key, value] of Object.entries(catalog)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === 'string') {
			flat.set(path, value);
		} else {
			for (const [nested, message] of flatten(value, path)) flat.set(nested, message);
		}
	}
	return flat;
}

/** Named interpolations only — `{'@'}` and friends are literals, not params. */
function placeholders(message: string): string[] {
	return [...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]!).sort();
}

const sources = { en: en as Catalog, de: de as Catalog };
const catalogs = { en: flatten(sources.en), de: flatten(sources.de) };
const localeCodes = Object.keys(catalogs) as (keyof typeof catalogs)[];

describe('UI layer message catalogs', () => {
	it.each(localeCodes)('%s namespaces every message under ui.*', (code) => {
		const stray = [...catalogs[code].keys()].filter((key) => !key.startsWith('ui.'));
		expect(stray).toEqual([]);
	});

	it.each(localeCodes.filter((code) => code !== 'en'))('%s covers every en key', (code) => {
		const missing = [...catalogs.en.keys()].filter((key) => !catalogs[code].has(key));
		const extra = [...catalogs[code].keys()].filter((key) => !catalogs.en.has(key));
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	});

	it.each(localeCodes.filter((code) => code !== 'en'))('%s keeps every placeholder', (code) => {
		const drifted = [...catalogs.en].filter(([key, message]) => {
			const translated = catalogs[code].get(key);
			return translated != null && placeholders(translated).join() !== placeholders(message).join();
		});
		expect(drifted.map(([key]) => key)).toEqual([]);
	});

	it.each(localeCodes)('%s carries no markup and no unescaped @', (code) => {
		const offenders = [...catalogs[code]]
			.filter(([, message]) => /[<>]/.test(message) || /(?<!\{')@/.test(message))
			.map(([key]) => key);
		expect(offenders).toEqual([]);
	});

	it.each(localeCodes)('%s translates every message away from English', (code) => {
		if (code === 'en') return;
		// Identical strings are almost always a forgotten translation. Anything
		// that legitimately reads the same in both languages goes on this list.
		const intentionallyIdentical = new Set(['ui.alert.info']);
		const untranslated = [...catalogs[code]]
			.filter(([key, message]) => catalogs.en.get(key) === message)
			.map(([key]) => key)
			.filter((key) => !intentionallyIdentical.has(key));
		expect(untranslated).toEqual([]);
	});

	// The catalogs are compiled by @nuxtjs/i18n at build time, so a message the
	// compiler chokes on is a failed deploy — and one it accepts but that leaks a
	// `{placeholder}` is a visible defect in every app that extends this layer.
	it.each(localeCodes)('%s compiles and interpolates every message', (code) => {
		const i18n = createI18n({ legacy: false, locale: code, messages: { [code]: sources[code] } });
		const broken: string[] = [];
		for (const [key, message] of catalogs[code]) {
			const params = Object.fromEntries(placeholders(message).map((name) => [name, 'X']));
			let rendered: string;
			try {
				rendered = i18n.global.t(key, params);
			} catch (error) {
				broken.push(`${key}: ${(error as Error).message}`);
				continue;
			}
			if (!rendered || rendered === key || /[{}]/.test(rendered)) {
				broken.push(`${key}: ${rendered}`);
			}
		}
		expect(broken).toEqual([]);
	});
});

/**
 * Source scan: the layer is consumed as source by three apps, so a key that
 * only exists in one of the two places (catalog / component) is a defect that
 * no unit test would otherwise reach — a missing message renders its key path
 * to a user, and a dead message is translation work nobody reads.
 */
const layerRoot = join(__dirname, '..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) sourceFiles(path, acc);
		else if (/\.(vue|ts)$/.test(entry.name) && !path.includes('__tests__')) acc.push(path);
	}
	return acc;
}

const referencedKeys = new Set<string>();
for (const file of [
	...sourceFiles(join(layerRoot, 'components')),
	...sourceFiles(join(layerRoot, 'composables')),
	...sourceFiles(join(layerRoot, 'utils')),
]) {
	for (const match of readFileSync(file, 'utf8').matchAll(/'(ui\.[a-zA-Z][\w.]*)'/g)) {
		referencedKeys.add(match[1]!);
	}
}

describe('ui.* keys used by the layer', () => {
	it('finds keys to check at all (guards the scanner itself)', () => {
		expect(referencedKeys.size).toBeGreaterThan(10);
	});

	it('every key a component asks for exists in every catalog', () => {
		const missing = [...referencedKeys].flatMap((key) =>
			localeCodes.filter((code) => !catalogs[code].has(key)).map((code) => `${code}: ${key}`)
		);
		expect(missing.sort()).toEqual([]);
	});

	it('every catalog message is referenced by the layer', () => {
		const unused = [...catalogs.en.keys()].filter((key) => !referencedKeys.has(key));
		expect(unused).toEqual([]);
	});
});
