import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import AppCommandPaletteResults from '../AppCommandPaletteResults.vue';
import type { PaletteGroup, PaletteItem } from '~/lib/commandPalette';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';

/**
 * A palette row's key chip comes from the registry: the key as this person has
 * it bound, for this machine, and none at all while nothing fires it. The
 * Postbox rows used to print `a` and `f` whatever the preset said.
 */
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});
afterEach(() => resetShortcutPreferences());

const item = (id: string, shortcutId?: string): PaletteItem => ({
	id,
	label: id,
	icon: 'lucide:circle',
	run: () => {},
	...(shortcutId ? { shortcutId } : {}),
});

function mountResults(items: PaletteItem[]) {
	const groups: PaletteGroup[] = [{ key: 'g', heading: 'Mailbox', order: 0, items }];
	return mount(AppCommandPaletteResults, {
		props: {
			groups,
			activeIndex: 0,
			indexById: new Map(items.map((entry, index) => [entry.id, index])),
			matchTerm: '',
			prompt: 'palette',
			isSearching: false,
			hasRows: true,
			askAnswer: null,
			askLoading: false,
		},
		global: { plugins: [createTestI18n()], stubs: { QueryResult: true } },
	});
}

function chips(wrapper: ReturnType<typeof mountResults>) {
	return wrapper
		.findAll('[role="option"]')
		.map((row) => (row.find('kbd').exists() ? row.get('kbd').text() : null));
}

describe('palette key chips', () => {
	it('shows the live binding of each row that names one', () => {
		const wrapper = mountResults([
			item('reply-all', 'postbox.replyAll'),
			item('forward', 'postbox.forward'),
			item('print'),
		]);
		expect(chips(wrapper)).toEqual(['A', 'F', null]);
	});

	it('updates an open palette when the preset changes', async () => {
		const wrapper = mountResults([
			item('reply-all', 'postbox.replyAll'),
			item('forward', 'postbox.forward'),
		]);
		applyShortcutPreferences('superhuman', []);
		await nextTick();
		expect(chips(wrapper)).toEqual(['Shift+R', 'Shift+F']);
	});

	it('keeps a literal chip for a key the palette itself answers', () => {
		const wrapper = mountResults([{ ...item('search-for'), hint: '↵' }]);
		expect(chips(wrapper)).toEqual(['↵']);
	});

	it('drops the chip of a row whose key was unbound', async () => {
		const wrapper = mountResults([item('move', 'postbox.move')]);
		expect(chips(wrapper)).toEqual(['V']);
		applyShortcutPreferences('owlat', [{ id: 'postbox.move', keys: [] }]);
		await nextTick();
		expect(chips(wrapper)).toEqual([null]);
	});
});
