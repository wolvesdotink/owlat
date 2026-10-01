import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import ThreadDetailSkeleton from '../ThreadDetailSkeleton.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

/**
 * The Team Inbox thread page's loading state: the page's shape, headed by the
 * list row when the list already loaded it, never a centred spinner.
 */
function mountSkeleton(props: Record<string, unknown> = {}) {
	return mount(ThreadDetailSkeleton, {
		props,
		global: {
			plugins: [createTestI18n()],
			stubs: { UiSkeleton: true, UiSkeletonText: true, UiSpinner: true },
		},
	});
}

describe('InboxThreadDetailSkeleton', () => {
	it('heads the page with the list row it was opened from', () => {
		const wrapper = mountSkeleton({
			preview: {
				subject: 'Invoice question',
				contactIdentifier: 'ada@example.com',
				messageCount: 3,
			},
		});
		const header = wrapper.get('[data-testid="thread-detail-skeleton-preview"]');
		expect(header.get('[data-testid="thread-detail-skeleton-subject"]').text()).toBe(
			'Invoice question'
		);
		expect(header.text()).toContain('ada@example.com');
		expect(header.text()).toContain('3 messages');
	});

	it('falls back to the no-subject copy for an empty subject', () => {
		const wrapper = mountSkeleton({
			preview: { subject: '', contactIdentifier: 'ada@example.com' },
		});
		expect(wrapper.get('[data-testid="thread-detail-skeleton-subject"]').text()).toBe('No subject');
	});

	it('shows skeleton bars in the header without a row, and no spinner', () => {
		const wrapper = mountSkeleton({ preview: null });
		expect(wrapper.find('[data-testid="thread-detail-skeleton-preview"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="thread-detail-skeleton-subject"]').exists()).toBe(false);
		expect(wrapper.findComponent({ name: 'UiSpinner' }).exists()).toBe(false);
		expect(wrapper.findAll('ui-skeleton-stub').length).toBeGreaterThan(0);
	});

	it('announces the loading state to assistive tech', () => {
		const wrapper = mountSkeleton();
		expect(wrapper.get('[role="status"]').text()).toBe('Loading thread...');
		expect(wrapper.get('[data-testid="thread-detail-skeleton"]').attributes('aria-busy')).toBe(
			'true'
		);
	});
});
