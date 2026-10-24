/**
 * The inbox mode toggle is one tooltip around a two-segment control: keyboard
 * focus lands on a segment, not on the control's root, and the tooltip (with
 * the toggle's key) still opens and describes the focused segment.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { focusTooltip } from '~/__tests__/tooltip';
import PostboxInboxModeToggle from '../PostboxInboxModeToggle.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

describe('PostboxInboxModeToggle', () => {
	it('opens its tooltip and shortcut when a segment takes keyboard focus', async () => {
		const wrapper = mount(PostboxInboxModeToggle, {
			props: { mode: 'today' },
			global: { plugins: [createTestI18n()], components: { UiSegmentedControl } },
			attachTo: document.body,
		});
		const segment = wrapper.get('button');
		segment.element.focus();
		await wrapper.vm.$nextTick();
		const bubble = document.querySelector('[role="tooltip"]');
		expect(bubble).not.toBeNull();
		expect(segment.attributes('aria-describedby')).toBe(bubble!.id);

		expect(await focusTooltip(segment)).toBe('Priority mail or all mail B');
		expect(segment.attributes('aria-describedby')).toBeUndefined();
	});
});
