import { describe, expect, it } from 'vitest';
import de from '../i18n/locales/de.json';
import en from '../i18n/locales/en.json';
import { sidebarConfig, sidebarGroupKey, sidebarItemKey } from '../app/utils/sidebarConfig';

/**
 * Guards for the docs UI message catalogs (apps/docs/i18n/locales).
 *
 * `en` is the source of truth and the `fallbackLocale`, so a translation that
 * drifts fails QUIETLY at runtime — a German page just renders an English line
 * in the middle of a German one. These checks turn every way that drift happens
 * into a test failure instead:
 *  - a key added to `en` and never translated (or a stale key left behind);
 *  - a placeholder renamed on one side only, which renders the literal `{name}`;
 *  - markup smuggled into a message, which @nuxtjs/i18n rejects at BUILD time
 *    (`compilation.strictMessage`) — a broken deploy, not a broken string;
 *  - a bare `@`, which the message compiler reads as a linked-message marker;
 *  - a sidebar entry added to `sidebarConfig` with no catalog entry, which the
 *    nav silently renders in English in every locale.
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

describe('docs UI message catalogs', () => {
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
		const offenders = [...catalogs[code]].filter(
			([, message]) => /<[a-z/]/i.test(message) || /(^|[^{'])@/.test(message)
		);
		expect(offenders.map(([key]) => key)).toEqual([]);
	});

	it.each(localeCodes)('%s leaves no message empty', (code) => {
		const blank = [...catalogs[code]].filter(([, message]) => message.trim() === '');
		expect(blank.map(([key]) => key)).toEqual([]);
	});
});

describe('sidebar catalog coverage', () => {
	const keys = sidebarConfig.flatMap((group) => [
		sidebarGroupKey(group),
		...group.items.map(sidebarItemKey),
	]);

	it('gives every configured nav entry a catalog key', () => {
		const missing = keys.filter((key) => !catalogs.en.has(key));
		expect(missing).toEqual([]);
	});

	it('carries no catalog key for a nav entry that no longer exists', () => {
		const configured = new Set(keys);
		const orphaned = [...catalogs.en.keys()].filter(
			(key) => key.startsWith('sidebar.') && !configured.has(key)
		);
		expect(orphaned).toEqual([]);
	});

	/**
	 * The keys are DERIVED from `section`/`label`/`to`, so two entries could in
	 * principle collapse onto one key (`/guide/a-b` and `/guide/a/b` both slugify
	 * to `guide-a-b`) — and the second would then silently render the first's
	 * translation.
	 */
	it('derives a distinct key per nav entry', () => {
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("matches the config's English label for every entry", () => {
		const mismatched = sidebarConfig.flatMap((group) =>
			[
				[sidebarGroupKey(group), group.label] as const,
				...group.items.map((item) => [sidebarItemKey(item), item.label] as const),
			].filter(([key, label]) => catalogs.en.get(key) !== label)
		);
		expect(mismatched).toEqual([]);
	});
});
