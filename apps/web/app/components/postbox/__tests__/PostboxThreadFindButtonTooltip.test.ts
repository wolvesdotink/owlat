/**
 * The find-in-conversation button names its shortcut in a UiTooltip (as this
 * person has it bound), not in a native title.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { focusTooltip } from '~/__tests__/tooltip';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import { resetShortcutPreferences } from '~/utils/shortcutScope';
import PostboxThreadFindButton from '../PostboxThreadFindButton.vue';

beforeAll(() => {
	// Nuxt auto-imports the composable; the test build does not.
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useShortcutLabels });
});
afterEach(() => resetShortcutPreferences());

describe('find in conversation button', () => {
	it('names the shortcut in its tooltip and keeps no native title', async () => {
		const wrapper = mount(PostboxThreadFindButton, {
			global: { plugins: [createTestI18n()] },
			attachTo: document.body,
		});
		const button = wrapper.get('[data-testid="thread-find-open"]');
		expect(button.attributes('title')).toBeUndefined();
		expect(button.attributes('aria-label')).toBe('Find in conversation');
		expect(await focusTooltip(button)).toBe('Find in conversation Ctrl+F');
		expect(button.attributes('aria-keyshortcuts')).toBe('Control+f');
	});
});
