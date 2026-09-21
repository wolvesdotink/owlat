// @vitest-environment happy-dom
/**
 * The triage chips, and the handover they now offer.
 *
 * The chips filter the fetched WINDOW; the search grammar they duplicate
 * (`is:unread`, `is:starred`, `has:attachment`) searches the whole mailbox. So
 * an active chip stops being a dead end: it offers the same predicate as a
 * saveable search URL. "All" is not a predicate and gets no handover.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxTriageFilterChips from '../PostboxTriageFilterChips.vue';
import {
	POSTBOX_TRIAGE_SEARCH_TOKENS,
	postboxTriageSearchPath,
	type PostboxTriageFilter,
} from '~/composables/postbox/usePostboxTriageFilters';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const stubs = {
	Icon: { props: ['name'], template: '<span />' },
	NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

function mountChips(filter: PostboxTriageFilter) {
	return mount(PostboxTriageFilterChips, {
		props: {
			filter,
			counts: { all: 8, unread: 2, starred: 1, attachments: 2 },
		},
		global: { plugins: [createTestI18n()], stubs },
	});
}

describe('postboxTriageSearchPath', () => {
	it('maps each chip 1:1 onto the grammar it duplicates', () => {
		expect(POSTBOX_TRIAGE_SEARCH_TOKENS).toEqual({
			unread: 'is:unread',
			starred: 'is:starred',
			attachments: 'has:attachment',
		});
		expect(postboxTriageSearchPath('unread')).toBe('/dashboard/postbox/search?q=is%3Aunread');
		expect(postboxTriageSearchPath('attachments')).toBe(
			'/dashboard/postbox/search?q=has%3Aattachment'
		);
	});

	it('has nothing to hand over for the unfiltered chip', () => {
		expect(postboxTriageSearchPath('all')).toBeNull();
	});
});

describe('PostboxTriageFilterChips open-in-search', () => {
	it('offers the handover only while a chip is active', () => {
		expect(mountChips('all').find('a').exists()).toBe(false);
		expect(mountChips('starred').find('a').exists()).toBe(true);
	});

	it('points at the search page with the chip token', () => {
		const link = mountChips('unread').find('a');
		expect(link.attributes('href')).toBe('/dashboard/postbox/search?q=is%3Aunread');
		// The token is the label — the chip and `is:unread` are one predicate
		// spelled twice, and the sentence stays as the accessible name.
		expect(link.text()).toContain('is:unread');
		expect(link.attributes('aria-label')).toBe('Search all mail for is:unread');
	});

	it('keeps all four chips regardless', () => {
		const labels = mountChips('unread')
			.findAll('button')
			.map((b) => b.text());
		expect(labels).toHaveLength(4);
		expect(labels[0]).toContain('All');
	});
});
