// @vitest-environment happy-dom
/**
 * UiSpinner's opt-in `delay`: a spinner for a wait that ends quickly should
 * never paint. The ring keeps its box while hidden (`invisible`, not unmounted)
 * so the surrounding layout does not shift when it appears.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import Spinner from '../components/ui/Spinner.vue';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('UiSpinner delay', () => {
	it('paints immediately by default', () => {
		const wrapper = mount(Spinner);
		expect(wrapper.classes()).not.toContain('invisible');
		expect(wrapper.classes()).toContain('w-8');
	});

	it('holds the ring back for 150 ms with `delay`, keeping its size', async () => {
		const wrapper = mount(Spinner, { props: { delay: true, size: 'sm' } });
		expect(wrapper.classes()).toContain('invisible');
		expect(wrapper.classes()).toContain('w-5');

		vi.advanceTimersByTime(149);
		await nextTick();
		expect(wrapper.classes()).toContain('invisible');

		vi.advanceTimersByTime(1);
		await nextTick();
		expect(wrapper.classes()).not.toContain('invisible');
	});

	it('takes a custom delay in ms', async () => {
		const wrapper = mount(Spinner, { props: { delay: 400 } });
		vi.advanceTimersByTime(399);
		await nextTick();
		expect(wrapper.classes()).toContain('invisible');
		vi.advanceTimersByTime(1);
		await nextTick();
		expect(wrapper.classes()).not.toContain('invisible');
	});

	it('leaves no timer behind when unmounted before it appears', () => {
		const wrapper = mount(Spinner, { props: { delay: true } });
		expect(vi.getTimerCount()).toBe(1);
		wrapper.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
