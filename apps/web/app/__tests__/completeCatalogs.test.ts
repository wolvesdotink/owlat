// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import de from '~~/i18n/locales/de.json';
import en from '~~/i18n/locales/en.json';
import {
	completeCatalog,
	i18nBuildLocales,
	type MessageCatalog,
	USES_COMPLETE_CATALOGS,
	writeCompleteCatalogs,
} from '~~/i18n/completeCatalogs';

/**
 * A production build registers `de` as a generated catalog completed from `en`
 * and turns the runtime fallback off, so a German visitor loads one catalog
 * instead of `en` and then `de` (plan 1.10). These pin both halves: a catalog
 * that lost a key would render its key path, and a config that kept the
 * fallback would bring the serial `en` load back.
 */

function keyPaths(catalog: MessageCatalog, prefix = ''): string[] {
	return Object.entries(catalog).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		return typeof value === 'string' ? [path] : keyPaths(value, path);
	});
}

describe('completeCatalog', () => {
	const source: MessageCatalog = {
		auth: { login: { title: 'Sign in', submit: 'Continue' }, logout: 'Sign out' },
		common: { save: 'Save' },
	};

	it('fills every key the translation lacks from the source, at any depth', () => {
		const translation: MessageCatalog = { auth: { login: { title: 'Anmelden' } } };
		expect(completeCatalog(translation, source)).toEqual({
			auth: { login: { title: 'Anmelden', submit: 'Continue' }, logout: 'Sign out' },
			common: { save: 'Save' },
		});
	});

	it('keeps the translation’s own messages, including ones the source lacks', () => {
		const translation: MessageCatalog = { common: { save: 'Speichern', extra: 'Nur hier' } };
		const complete = completeCatalog(translation, source);
		expect(complete['common']).toEqual({ save: 'Speichern', extra: 'Nur hier' });
	});

	it('leaves both inputs untouched', () => {
		const translation: MessageCatalog = { auth: { logout: 'Abmelden' } };
		const before = JSON.stringify({ translation, source });
		completeCatalog(translation, source);
		expect(JSON.stringify({ translation, source })).toBe(before);
	});
});

describe('build catalogs', () => {
	it('is on outside the dev server', () => {
		expect(USES_COMPLETE_CATALOGS).toBe(true);
	});

	it('registers the generated de catalog and keeps en as the source file', () => {
		const locales = i18nBuildLocales();
		expect(locales.find((l) => l.code === 'en')?.file).toBe('en.json');
		expect(locales.find((l) => l.code === 'de')?.file).toMatch(
			/node_modules\/\.cache\/owlat-i18n\/de\.json$/
		);
	});

	it('writes a de catalog with every en key and every de translation', () => {
		writeCompleteCatalogs();
		const file = i18nBuildLocales().find((l) => l.code === 'de')!.file;
		const generated = JSON.parse(readFileSync(file, 'utf-8')) as MessageCatalog;

		const generatedKeys = new Set(keyPaths(generated));
		expect(keyPaths(en as MessageCatalog).filter((key) => !generatedKeys.has(key))).toEqual([]);
		expect(generated).toEqual(completeCatalog(de as MessageCatalog, en as MessageCatalog));
	});

	it('turns the runtime en fallback off outside dev', async () => {
		vi.stubGlobal('defineI18nConfig', (config: () => unknown) => config);
		const { default: config } = await import('~~/i18n/i18n.config');
		expect((config as () => { fallbackLocale: unknown })().fallbackLocale).toBe(false);
	});
});
