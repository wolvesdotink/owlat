// @vitest-environment happy-dom
/**
 * PostboxEditorToolbar behavior:
 *   - `persistent` variant (default) carries the full-width border/background
 *     chrome; `floating` variant stays neutral so its container can supply chrome
 *   - buttons emit their typed command
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { EMPTY_ACTIVE_MARKS } from '@owlat/ui/composables/useRichText';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxEditorToolbar from '../PostboxEditorToolbar.vue';

const iconStub = { props: ['name'], template: '<span />' };

// The button tooltips flow through vue-i18n now; `useI18n` is a Nuxt
// auto-import, so it has to exist as a global for the component's setup.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountToolbar(props: Record<string, unknown> = {}) {
	return mount(PostboxEditorToolbar, {
		props: { activeMarks: { ...EMPTY_ACTIVE_MARKS }, ...props },
		global: { plugins: [createTestI18n()], stubs: { Icon: iconStub } },
	});
}

describe('PostboxEditorToolbar', () => {
	it('defaults to the persistent variant with border chrome', () => {
		const wrapper = mountToolbar();
		expect(wrapper.find('div').classes()).toContain('border-b');
	});

	it('drops the border chrome in the floating variant', () => {
		const wrapper = mountToolbar({ variant: 'floating' });
		expect(wrapper.find('div').classes()).not.toContain('border-b');
	});

	it('emits the format command for a button', async () => {
		const wrapper = mountToolbar();
		await wrapper.find('button[title^="Italic"]').trigger('click');
		expect(wrapper.emitted('italic')).toHaveLength(1);
	});
});
