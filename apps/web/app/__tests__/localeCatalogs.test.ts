import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import de from '~~/i18n/locales/de.json';
import en from '~~/i18n/locales/en.json';

/**
 * Guards for the UI message catalogs (apps/web/i18n/locales).
 *
 * `en` is the source of truth and the `fallbackLocale`, so a translation that
 * drifts fails quietly at runtime — the visitor just gets an English line in the
 * middle of a German page. These checks turn every way that drift happens into a
 * test failure instead:
 *  - a key added to `en` and never translated (or a stale key left behind);
 *  - a placeholder renamed on one side only, which renders the literal `{name}`;
 *  - markup smuggled into a message, which @nuxtjs/i18n rejects at BUILD time
 *    (`compilation.strictMessage`) — a broken deploy, not a broken string;
 *  - a bare `@`, which the message compiler reads as a linked-message marker
 *    (email placeholders have to be written as `you{'@'}example.com`).
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

describe('UI message catalogs', () => {
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

	// The catalogs are compiled by @nuxtjs/i18n at build time, so a message the
	// compiler chokes on is a failed deploy — and one it accepts but that leaks a
	// `{placeholder}` is a visible defect on a page a stranger reads.
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
