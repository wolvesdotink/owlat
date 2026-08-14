import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_DOCS_COLLECTION,
	DEFAULT_DOCS_LOCALE,
	contentPath,
	docsCollection,
} from '../app/composables/useDocsContent';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(appRoot, rel), 'utf8');

/**
 * The three files that have to agree for a locale to actually exist — the i18n
 * locale list, the content collections, and the content tree itself.
 *
 * They fail in different, quiet ways when they drift: a locale with no
 * collection serves the English page under a German URL forever; a content
 * directory with no collection is simply never indexed (no error, the pages
 * just 404); a locale with no catalog renders raw key paths. So the source of
 * truth is compared three ways rather than trusted once.
 */
const configuredLocales = [
	...read('nuxt.config.ts').matchAll(
		/\{ code: '([a-z-]+)', language: '[^']+', name: '[^']+', file: '([^']+)' \}/g
	),
].map(([, code, file]) => ({ code: code!, file: file! }));

describe('docs locale wiring', () => {
	it('registers more than one locale', () => {
		expect(configuredLocales.length).toBeGreaterThan(1);
	});

	it('gives every configured locale a message catalog', () => {
		const catalogs = readdirSync(resolve(appRoot, 'i18n/locales'));
		expect(configuredLocales.map((locale) => locale.file).sort()).toEqual(catalogs.sort());
	});

	it('gives every configured locale a content collection that strips its directory', () => {
		// `prefix: ''` is what keeps the English URLs unchanged after the content
		// tree moved under `content/en/` — without it every path would gain an
		// `/en` segment and every published docs link would 404.
		const config = read('content.config.ts');
		for (const { code } of configuredLocales) {
			expect(config).toContain(`content_${code}: defineCollection`);
			expect(config).toContain(`source: { include: '${code}/**/*.md', prefix: '' }`);
		}
	});

	it('files every content page under a locale directory', () => {
		const entries = readdirSync(resolve(appRoot, 'content'), { withFileTypes: true });
		const codes = configuredLocales.map((locale) => locale.code);
		for (const entry of entries) {
			expect(entry.isDirectory(), `content/${entry.name} is not a locale directory`).toBe(true);
			expect(codes).toContain(entry.name);
		}
	});

	it('keeps the default locale tree populated', () => {
		expect(readdirSync(resolve(appRoot, `content/${DEFAULT_DOCS_LOCALE}`)).length).toBeGreaterThan(
			0
		);
	});
});

describe('contentPath', () => {
	it('leaves default-locale paths untouched', () => {
		expect(contentPath('/guide/quick-start', 'en')).toBe('/guide/quick-start');
		expect(contentPath('/', 'en')).toBe('/');
	});

	it('strips the prefix of a non-default locale', () => {
		expect(contentPath('/de/guide/quick-start', 'de')).toBe('/guide/quick-start');
	});

	it('maps a locale root to the content root', () => {
		expect(contentPath('/de', 'de')).toBe('/');
	});

	it('only strips a whole segment', () => {
		// `/design` starts with `/de` as a STRING but not as a path segment;
		// slicing by length would leave `sign` and query the wrong page.
		expect(contentPath('/design', 'de')).toBe('/design');
	});

	it('leaves an already-unprefixed path alone', () => {
		expect(contentPath('/guide/topics', 'de')).toBe('/guide/topics');
	});
});

describe('docsCollection', () => {
	it('maps each locale to its own collection', () => {
		expect(docsCollection('en')).toBe('content_en');
		expect(docsCollection('de')).toBe('content_de');
	});

	it('falls back to the source collection for an unknown locale', () => {
		expect(docsCollection('fr')).toBe(DEFAULT_DOCS_COLLECTION);
	});
});
