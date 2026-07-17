// @vitest-environment happy-dom
/**
 * The graceful placeholder for a task-flow card that can't be rendered. It must
 * never leave the user stuck: an unknown or disabled kind is always skippable
 * (so the queue advances) and, when a destination exists, openable — the queue
 * item is surfaced, never silently dropped.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import TaskCardFallback from '../TaskCardFallback.vue';

const stubs = { Icon: { template: '<i />' }, UiIconBox: { template: '<i />' } };

function mountFallback(props: Record<string, unknown>) {
	return mount(TaskCardFallback, { props: { kind: 'plugin.ghost', ...props }, global: { stubs } });
}

const skipSel = '[data-testid="task-fallback-skip"]';
const openSel = '[data-testid="task-fallback-open"]';

describe('TaskCardFallback', () => {
	it('renders the unknown-kind copy and the offending kind tag', () => {
		const wrapper = mountFallback({ reason: 'unknown', kind: 'plugin.acme.removed' });
		expect(wrapper.text()).toContain("can't be shown");
		expect(wrapper.text()).toContain('plugin.acme.removed');
	});

	it('length-clamps an oversized (untrusted) kind string in the tag', () => {
		const huge = `plugin.${'x'.repeat(500)}`;
		const wrapper = mountFallback({ reason: 'unknown', kind: huge });
		const tag = wrapper.find('span.font-mono').text();
		// Clamped to the 80-char cap plus a single ellipsis — never the full string.
		expect(tag.length).toBeLessThanOrEqual(81);
		expect(tag.endsWith('…')).toBe(true);
	});

	it('renders the disabled-kind copy with the registry label', () => {
		const wrapper = mountFallback({ reason: 'disabled', label: 'Survey card' });
		expect(wrapper.text()).toContain('Survey card is turned off');
	});

	it('always offers a Skip control and emits skip (queue can advance)', async () => {
		const wrapper = mountFallback({ reason: 'unknown' });
		expect(wrapper.find(skipSel).exists()).toBe(true);
		await wrapper.find(skipSel).trigger('click');
		expect(wrapper.emitted('skip')).toHaveLength(1);
	});

	it('hides Open by default and shows + emits it only when a destination exists', async () => {
		const without = mountFallback({ reason: 'unknown' });
		expect(without.find(openSel).exists()).toBe(false);

		const withOpen = mountFallback({ reason: 'unknown', canOpen: true });
		expect(withOpen.find(openSel).exists()).toBe(true);
		await withOpen.find(openSel).trigger('click');
		expect(withOpen.emitted('open')).toHaveLength(1);
	});
});
