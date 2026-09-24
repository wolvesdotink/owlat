// @vitest-environment happy-dom
/**
 * UiQueryBoundary is the shared loading / error / empty state machine that the
 * list and detail pages now route their reads through. The regression it guards
 * against: a faulted query used to render a misleading "empty" (list pages) or
 * "doesn't exist / has been deleted" (single-record editors) state, because the
 * pages only inspected `isLoading` and treated undefined data as "no rows".
 *
 * These tests pin the contract the pages rely on:
 *   - an ERROR takes precedence over empty/not-found and surfaces a retry control
 *     (never the empty slot), and retry is wired to the caller's refetch;
 *   - a genuine settled-empty (error null, not loading) still renders the empty /
 *     not-found slot, so real "nothing here" and "you don't have access" cases
 *     are preserved untouched.
 *
 * The Ui* globals and Icon are auto-imported app-wide, so they are stubbed here.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ConvexError } from 'convex/values';

import QueryBoundary from '../QueryBoundary.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// The boundary's own copy (heading, retry, empty state) renders through
// vue-i18n; `useI18n` reaches the component as a Nuxt auto-import.
beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const stubs = {
	Icon: true,
	UiSpinner: true,
	UiEmptyState: { template: '<div data-testid="empty"><slot /></div>' },
	UiErrorAlert: {
		props: ['title', 'message', 'variant'],
		template: '<div data-testid="error-alert">{{ title }} — {{ message }}</div>',
	},
	UiButton: {
		emits: ['click'],
		template: '<button data-testid="retry" @click="$emit(\'click\')"><slot /></button>',
	},
};

const slots = {
	default: '<div data-testid="content">rows</div>',
	empty: '<div data-testid="empty-slot">Nothing here yet</div>',
};

describe('UiQueryBoundary', () => {
	it('renders retry (not the empty slot) when the query errored, even with no data', () => {
		const wrapper = mount(QueryBoundary, {
			props: { loading: false, error: new Error('boom'), empty: true },
			slots,
			global: { stubs, plugins: [createTestI18n()] },
		});

		// Error branch wins: retry control + alert are shown…
		expect(wrapper.find('[data-testid="retry"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="error-alert"]').exists()).toBe(true);
		// …and neither the empty slot nor the content leaks through.
		expect(wrapper.find('[data-testid="empty-slot"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="content"]').exists()).toBe(false);
	});

	it('emits retry so the caller can refetch instead of reloading the page', async () => {
		const onRetry = vi.fn();
		const wrapper = mount(QueryBoundary, {
			props: { loading: false, error: new Error('boom'), onRetry },
			slots,
			global: { stubs, plugins: [createTestI18n()] },
		});

		await wrapper.find('[data-testid="retry"]').trigger('click');
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	function alertText(error: Error): string {
		return mount(QueryBoundary, {
			props: { loading: false, error },
			slots,
			global: { stubs, plugins: [createTestI18n()] },
		})
			.find('[data-testid="error-alert"]')
			.text();
	}

	it('says a timed-out read was slow, not the raw Convex message (#721)', () => {
		const text = alertText(
			new Error(
				'[CONVEX Q(topics/topics:list)] [Request ID: 1] Server Error\nUncaught Error: Function execution timed out (maximum duration: 1s)'
			)
		);
		expect(text).toContain('The server took too long to answer. Try again in a moment.');
		expect(text).not.toContain('CONVEX');
	});

	it('shows the backend message of a categorized refusal', () => {
		expect(
			alertText(
				new ConvexError({ category: 'forbidden', message: 'Only admins can view senders.' })
			)
		).toContain('Only admins can view senders.');
	});

	it('falls back to the generic load failure for an uncategorized server error', () => {
		const text = alertText(
			new Error('[CONVEX Q(topics/topics:list)] [Request ID: 1] Server Error')
		);
		expect(text).toContain('Something went wrong while loading this view.');
		expect(text).not.toContain('Request ID');
	});

	it('renders the empty / not-found slot for a genuine settled-empty (no error)', () => {
		const wrapper = mount(QueryBoundary, {
			props: { loading: false, error: null, empty: true },
			slots,
			global: { stubs, plugins: [createTestI18n()] },
		});

		expect(wrapper.find('[data-testid="empty-slot"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="retry"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="content"]').exists()).toBe(false);
	});

	it('renders content once the query settles with rows', () => {
		const wrapper = mount(QueryBoundary, {
			props: { loading: false, error: null, empty: false },
			slots,
			global: { stubs, plugins: [createTestI18n()] },
		});

		expect(wrapper.find('[data-testid="content"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="empty-slot"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="retry"]').exists()).toBe(false);
	});
});
