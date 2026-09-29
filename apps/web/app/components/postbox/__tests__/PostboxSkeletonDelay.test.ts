// @vitest-environment happy-dom
/**
 * The Postbox's list and reader skeletons wait 150 ms before they paint (plan
 * 2.8), keeping their box meanwhile: a folder or a body that arrives inside that
 * window never flashes a placeholder, and nothing below them moves when one does
 * appear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';

const global = { components: { UiSkeleton } };

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe.each([
	['list', PostboxThreadListSkeleton, 'postbox-thread-list-skeleton'],
	['reader', PostboxReaderSkeleton, 'postbox-reader-skeleton'],
] as const)('the Postbox %s skeleton', (_name, component, testId) => {
	it('keeps its box but stays invisible for the first 150 ms', async () => {
		const w = mount(component, { global });
		const root = w.find(`[data-testid="${testId}"]`);

		expect(root.exists()).toBe(true);
		expect(root.findAllComponents(UiSkeleton).length).toBeGreaterThan(0);
		expect(root.classes()).toContain('invisible');

		vi.advanceTimersByTime(149);
		await nextTick();
		expect(w.find(`[data-testid="${testId}"]`).classes()).toContain('invisible');
	});

	it('shows once the wait outlasts the delay', async () => {
		const w = mount(component, { global });

		vi.advanceTimersByTime(150);
		await nextTick();

		expect(w.find(`[data-testid="${testId}"]`).classes()).not.toContain('invisible');
	});
});

it('keeps the reader card chrome alongside the delay class', () => {
	const w = mount(PostboxReaderSkeleton, { global });
	const root = w.find('[data-testid="postbox-reader-skeleton"]');
	expect(root.classes()).toEqual(expect.arrayContaining(['border', 'rounded', 'invisible']));
});
