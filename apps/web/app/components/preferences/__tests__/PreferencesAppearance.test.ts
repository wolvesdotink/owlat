// @vitest-environment happy-dom
/**
 * THE THEME PICKER.
 *
 * Three cards that look identical to assistive tech: the selected one used to
 * be marked by a border colour and nothing else, so a screen-reader user was
 * told "Light, button / Dark, button / System, button" with no way to hear
 * which theme is on. LanguagePicker one card down already solves this with a
 * labelled `role="group"` and `aria-pressed`; these assertions hold this one to
 * the same contract, and to a single pressed card (two would be a lie about a
 * radio-style choice).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PreferencesAppearance from '../PreferencesAppearance.vue';
import type { ThemeOption } from '~/composables/useAppTheme';

const themePreference = ref<ThemeOption>('system');
const setTheme = vi.fn((option: ThemeOption) => {
	themePreference.value = option;
});

beforeEach(() => {
	vi.clearAllMocks();
	themePreference.value = 'system';
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: computed(() => false) }));
	vi.stubGlobal('useAppTheme', () => ({ themePreference, setTheme }));
});

function mountAppearance() {
	return mount(PreferencesAppearance, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: { template: '<span />' },
				NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
			},
		},
	});
}

describe('PreferencesAppearance', () => {
	it('names the choice as a group', () => {
		expect(mountAppearance().get('[role="group"]').attributes('aria-label')).toBe('Theme');
	});

	it('marks exactly the active theme as pressed', () => {
		const w = mountAppearance();
		const pressed = w.findAll('[aria-pressed="true"]');

		expect(pressed).toHaveLength(1);
		expect(pressed[0]!.text()).toContain('System');
	});

	it('states every other theme as not pressed rather than leaving it unsaid', () => {
		const w = mountAppearance();
		const cards = w.findAll('[role="group"] button');

		expect(cards).toHaveLength(3);
		expect(cards.map((card) => card.attributes('aria-pressed'))).toEqual([
			'false',
			'false',
			'true',
		]);
	});

	it('moves the pressed state with the selection', async () => {
		const w = mountAppearance();

		await w.findAll('[role="group"] button')[1]!.trigger('click');

		expect(setTheme).toHaveBeenCalledWith('dark');
		const pressed = w.findAll('[aria-pressed="true"]');
		expect(pressed).toHaveLength(1);
		expect(pressed[0]!.text()).toContain('Dark');
	});

	it('renders catalog copy, not key paths', () => {
		expectFullyLocalized(mountAppearance());
	});
});
