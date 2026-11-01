/**
 * The Updates band's key legend reads the Workbench's live bindings: a remap
 * on the shortcuts page changes what it advertises, and a key the person
 * unbound drops out of it instead of promising a press that does nothing.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { TodayModel } from '~/utils/todayDigest';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';
import TodayUpdates from '../TodayUpdates.vue';

const EMPTY = { worth: [], also: [] } as unknown as TodayModel;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});
afterEach(() => resetShortcutPreferences());

function legend(): string[] {
	const wrapper = mount(TodayUpdates, {
		props: { model: EMPTY },
		global: {
			plugins: [createTestI18n()],
			stubs: { NuxtLink: true, TodaySourceLink: true },
		},
	});
	const keys = wrapper.findAll('h3 kbd').map((kbd) => kbd.text());
	text = wrapper.findAll('h3 > span').at(-1)!.element.textContent!.replace(/\s+/g, ' ').trim();
	wrapper.unmount();
	return keys;
}
/** The legend as read, from the last `legend()` call. */
let text = '';

describe('TodayUpdates key legend', () => {
	it('shows the shipped keys', () => {
		expect(legend()).toEqual(['J', 'K', 'D', 'R']);
		expect(text).toBe('J K move · D Done · R Reply anyway');
	});

	it('follows a remap and leaves out an unbound key', () => {
		applyShortcutPreferences('owlat', [
			{ id: 'workbench.done', keys: ['x'] },
			{ id: 'workbench.reply', keys: [] },
		]);
		expect(legend()).toEqual(['J', 'K', 'X']);
		expect(text).toBe('J K move · X Done');
	});
});
