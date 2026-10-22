/**
 * The bar over an open conversation. Below lg it is the drill-in back; in Zen,
 * where the reader is the whole screen, it also steps to the previous and next
 * conversation, by button and by j/k (the list that owns those keys is away).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';
import { SHORTCUT_PRESET_DEFAULT } from '~/utils/shortcutPresets';
import PostboxReaderBackBar from '../PostboxReaderBackBar.vue';

const navigateTo = vi.fn();
beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('navigateTo', navigateTo);
});
beforeEach(() => {
	navigateTo.mockClear();
	resetShortcutPreferences();
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

function mountBar(props: { zen: boolean; activeMessageId?: string }) {
	wrapper = mount(PostboxReaderBackBar, {
		attachTo: document.body,
		props: {
			folderName: 'inbox',
			folderPath: 'inbox',
			activeMessageId: 'b',
			orderedIds: ['a', 'b', 'c'],
			...props,
		},
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
	return wrapper;
}

const key = (k: string) =>
	window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('PostboxReaderBackBar', () => {
	it('is only the back button outside Zen, and j/k stay with the list', () => {
		const w = mountBar({ zen: false });
		expect(w.findAll('button')).toHaveLength(1);
		key('j');
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('steps to the neighbours in Zen, by button and by j/k', async () => {
		const w = mountBar({ zen: true });
		const [, previous, next] = w.findAll('button');
		await previous!.trigger('click');
		await next!.trigger('click');
		key('j');
		key('k');
		expect(navigateTo.mock.calls.map((c) => c[0])).toEqual([
			'/dashboard/postbox/inbox/a',
			'/dashboard/postbox/inbox/c',
			'/dashboard/postbox/inbox/c',
			'/dashboard/postbox/inbox/a',
		]);
	});

	it('leaves the arrow keys to scrolling and disables a step with nowhere to go', () => {
		const w = mountBar({ zen: true, activeMessageId: 'c' });
		key('ArrowDown');
		expect(navigateTo).not.toHaveBeenCalled();
		const next = w.findAll('button')[2]!;
		expect(next.attributes('disabled')).toBeDefined();
	});

	it('goes back to the list', async () => {
		const w = mountBar({ zen: true });
		await w.findAll('button')[0]!.trigger('click');
		expect(w.emitted('back')).toHaveLength(1);
	});

	it('names the step keys as the person has them mapped', () => {
		const titles = (w: VueWrapper) =>
			w
				.findAll('button')
				.slice(1)
				.map((b) => b.attributes('title'));
		expect(titles(mountBar({ zen: true }))).toEqual([
			'Previous conversation (k)',
			'Next conversation (j)',
		]);
		wrapper?.unmount();
		applyShortcutPreferences(SHORTCUT_PRESET_DEFAULT, [
			{ id: 'postbox.next', keys: ['ArrowDown'] },
		]);
		// Only the arrow is left, and the arrows scroll here: no key to name.
		expect(titles(mountBar({ zen: true }))).toEqual([
			'Previous conversation (k)',
			'Next conversation',
		]);
	});
});
