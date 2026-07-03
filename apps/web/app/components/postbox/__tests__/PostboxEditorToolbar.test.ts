// @vitest-environment happy-dom
/**
 * PostboxEditorToolbar behavior:
 *   - `persistent` variant (default) carries the full-width border/background
 *     chrome; `floating` variant stays neutral so its container can supply chrome
 *   - buttons emit their typed command
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { EMPTY_ACTIVE_MARKS } from '@owlat/ui/composables/useRichText';

import PostboxEditorToolbar from '../PostboxEditorToolbar.vue';

const iconStub = { props: ['name'], template: '<span />' };

function mountToolbar(props: Record<string, unknown> = {}) {
	return mount(PostboxEditorToolbar, {
		props: { activeMarks: { ...EMPTY_ACTIVE_MARKS }, ...props },
		global: { stubs: { Icon: iconStub } },
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
