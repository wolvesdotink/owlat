// @vitest-environment happy-dom
/**
 * PostboxFloatingFormatBar behavior:
 *   - renders nothing while `barStyle` is null (no/collapsed selection)
 *   - renders the format toolbar once `barStyle` is set (a selection exists)
 *   - forwards format commands (bold/italic/…) to the parent
 *   - shows the AI rewrite actions ONLY when `showAiActions` is true, as ONE
 *     combined bar alongside the format buttons (not a second popover)
 *   - forwards an AI action selection as `ai-select`
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { EMPTY_ACTIVE_MARKS } from '@owlat/ui/composables/useRichText';

import PostboxFloatingFormatBar from '../PostboxFloatingFormatBar.vue';
import PostboxEditorToolbar from '../PostboxEditorToolbar.vue';
import PostboxRewriteActions from '../PostboxRewriteActions.vue';

const iconStub = { props: ['name'], template: '<span />' };

function mountBar(props: Record<string, unknown> = {}) {
	return mount(PostboxFloatingFormatBar, {
		props: {
			barStyle: { top: '10px', left: '20px' },
			activeMarks: { ...EMPTY_ACTIVE_MARKS },
			...props,
		},
		global: {
			components: { PostboxEditorToolbar, PostboxRewriteActions },
			stubs: { Icon: iconStub },
		},
	});
}

describe('PostboxFloatingFormatBar', () => {
	it('renders nothing when barStyle is null (collapsed selection)', () => {
		const wrapper = mountBar({ barStyle: null });
		expect(wrapper.find('[data-testid="postbox-floating-format-bar"]').exists()).toBe(false);
	});

	it('renders the format toolbar when a selection anchors the bar', () => {
		const wrapper = mountBar();
		expect(wrapper.find('[data-testid="postbox-floating-format-bar"]').exists()).toBe(true);
		// Format buttons are present (Bold has a recognizable title).
		expect(wrapper.find('button[title^="Bold"]').exists()).toBe(true);
	});

	it('forwards a format command to the parent', async () => {
		const wrapper = mountBar();
		await wrapper.find('button[title^="Bold"]').trigger('click');
		expect(wrapper.emitted('bold')).toHaveLength(1);
	});

	it('hides the AI actions by default', () => {
		const wrapper = mountBar();
		expect(wrapper.find('[data-testid="postbox-rewrite-actions"]').exists()).toBe(false);
	});

	it('renders the AI actions in the same combined bar when showAiActions is on', () => {
		const wrapper = mountBar({ showAiActions: true, aiLanguages: ['Spanish'] });
		// Both the format buttons AND the AI actions live in the one bar.
		expect(wrapper.find('button[title^="Bold"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="postbox-rewrite-actions"]').exists()).toBe(true);
	});

	it('forwards an AI action selection as ai-select', async () => {
		const wrapper = mountBar({ showAiActions: true, aiLanguages: ['Spanish'] });
		await wrapper.find('button[title="Shorter"]').trigger('click');
		expect(wrapper.emitted('ai-select')?.[0]).toEqual([{ intent: 'shorter' }]);
	});
});
