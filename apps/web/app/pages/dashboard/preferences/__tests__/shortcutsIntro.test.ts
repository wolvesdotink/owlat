/**
 * The shortcuts page's intro names the key that opens Help as the person has
 * it bound, so it never sends them to a key that does nothing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';
import ShortcutsPage from '../shortcuts.vue';

vi.mock('~/components/preferences/PreferencesShortcuts.vue', () => ({
	default: { name: 'PreferencesShortcuts', render: () => null },
}));

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useHead: () => {},
		definePageMeta: () => {},
	});
});
beforeEach(() => resetShortcutPreferences());

const intro = () =>
	mount(ShortcutsPage, { global: { plugins: [createTestI18n()] } })
		.get('p')
		.text()
		.replace(/\s+/g, ' ');

describe('shortcuts page intro', () => {
	it('names the shipped Help key', () => {
		expect(intro()).toContain('or search for one. Press ? anywhere to see the keys');
	});

	it('names a remapped Help key instead of `?`', () => {
		applyShortcutPreferences('owlat', [{ id: 'global.help', keys: ['y'] }]);
		const text = intro();
		expect(text).toContain('Press Y anywhere');
		expect(text).not.toContain('?');
	});

	it('leaves the sentence out when Help is unbound', () => {
		applyShortcutPreferences('owlat', [{ id: 'global.help', keys: [] }]);
		expect(intro()).not.toContain('Press');
	});
});
