/**
 * One category vocabulary on the web (utils/mailCategory): every category the
 * schema knows has one icon and one catalog key, every surface's subset stays
 * inside it, and the icons stay distinct from the Recategorize action.
 */
import { describe, expect, it } from 'vitest';
import { FILED_CATEGORIES } from '@owlat/shared/threadStatus';
import de from '~~/i18n/locales/de.json';
import en from '~~/i18n/locales/en.json';
import { MAIL_CATEGORY_META, type MailCategory } from '../mailCategory';
import { POSTBOX_BUNDLE_CATEGORIES } from '../postboxBundles';
import { RECATEGORIZE_OPTIONS } from '~/composables/postbox/usePostboxThreadCategories';

const ALL: MailCategory[] = [
	'person',
	'newsletter',
	'notification',
	'receipt',
	'promotion',
	'spam',
	'other',
];

function lookup(catalog: unknown, key: string): unknown {
	let node: unknown = catalog;
	for (const part of key.split('.')) {
		if (typeof node !== 'object' || node === null) return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return node;
}

describe('MAIL_CATEGORY_META', () => {
	it('covers every category exactly', () => {
		expect(Object.keys(MAIL_CATEGORY_META).sort()).toEqual([...ALL].sort());
	});

	it('carries a lucide icon and a catalog KEY that both locales resolve', () => {
		for (const category of ALL) {
			const meta = MAIL_CATEGORY_META[category];
			expect(meta.icon).toMatch(/^lucide:/);
			expect(meta.labelKey).toBe(`shared.mailCategory.${category}`);
			expect(typeof lookup(en, meta.labelKey)).toBe('string');
			expect(typeof lookup(de, meta.labelKey)).toBe('string');
		}
	});

	it('gives every category its own icon, never the Recategorize tag', () => {
		const icons = ALL.map((category) => MAIL_CATEGORY_META[category].icon);
		expect(new Set(icons).size).toBe(icons.length);
		expect(icons).not.toContain('lucide:tag');
		expect(MAIL_CATEGORY_META.promotion.icon).toBe('lucide:megaphone');
	});

	it('covers every subset a surface lists', () => {
		for (const category of [
			...POSTBOX_BUNDLE_CATEGORIES,
			...FILED_CATEGORIES,
			...RECATEGORIZE_OPTIONS.map((option) => option.key),
		]) {
			expect(ALL).toContain(category);
		}
	});
});
