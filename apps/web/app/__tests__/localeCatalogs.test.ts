import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import de from '~~/i18n/locales/de.json';
import en from '~~/i18n/locales/en.json';
import { INTENTIONALLY_IDENTICAL_KEYS } from './localeIdenticalByDesign';

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

	/**
	 * A `de` message that is character-for-character its English source is almost
	 * always a key someone added to both files and translated in neither: the
	 * catalog-parity check above passes, the compile check passes, and the German
	 * page just says the English thing. The failure this catches is real — the
	 * whole `imprint.*` block sat here as untranslated GERMAN in `en.json`, so the
	 * English imprint page rendered "Angaben gemäß § 5 TMG".
	 *
	 * Ported from `packages/ui/__tests__/localeCatalogs.test.ts`, which has held
	 * the layer catalogs to this for a while; this app's catalog is 9,000 keys, so
	 * the legitimately-identical set is a list rather than a handful. Everything on
	 * it is a proper noun (Mailchimp, Twilio, OpenAI), a term German borrows
	 * wholesale (Spam, Marketing, Chat, Port), an IANA timezone or language name,
	 * or a placeholder that is the same in both.
	 */
	const INTENTIONALLY_IDENTICAL = new Set(INTENTIONALLY_IDENTICAL_KEYS);

	it('translates every message away from English', () => {
		const untranslated = [...catalogs.en]
			.filter(([key, message]) => catalogs.de.get(key) === message)
			.map(([key]) => key)
			.filter((key) => !INTENTIONALLY_IDENTICAL.has(key));
		expect(untranslated).toEqual([]);
	});

	/**
	 * The allowlist is a guard only while it is exact. An entry that outlives the
	 * key it excused — because the message was translated, renamed or deleted —
	 * silently re-opens the hole for whatever takes that key path next.
	 */
	it('carries no stale entry in the identical-by-design list', () => {
		const stale = [...INTENTIONALLY_IDENTICAL].filter(
			(key) => catalogs.en.get(key) !== catalogs.de.get(key)
		);
		expect(stale).toEqual([]);
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
