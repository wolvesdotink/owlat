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
import { reactive } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { focusTooltip, tooltipOf } from '~/__tests__/tooltip';
import PostboxTriageFilterChips from '../PostboxTriageFilterChips.vue';
import {
	POSTBOX_TRIAGE_SEARCH_TOKENS,
	postboxTriageSearchPath,
	type PostboxTriageFilter,
} from '~/composables/postbox/usePostboxTriageFilters';

const route = reactive({ query: {} as Record<string, unknown> });
const routerReplace = vi.fn((loc: { query: Record<string, unknown> }) => {
	route.query = loc.query;
});

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useRoute', () => route);
	vi.stubGlobal('useRouter', () => ({ replace: routerReplace }));
});

const stubs = {
	Icon: { props: ['name'], template: '<span />' },
	NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

function mountChips(filter: PostboxTriageFilter, countsArePartial = false) {
	return mount(PostboxTriageFilterChips, {
		props: {
			filter,
			counts: { all: 8, unread: 2, starred: 1, attachments: 2 },
			countsArePartial,
		},
		global: { plugins: [createTestI18n()], stubs },
		attachTo: document.body,
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

	it('names the search in a tooltip on focus, not a native title', async () => {
		const w = mountChips('unread');
		const link = w.get('a');
		expect(link.attributes('title')).toBeUndefined();
		expect(await focusTooltip(link)).toBe('Search all mail for is:unread');
		w.unmount();
	});

	it('keeps all four chips regardless', () => {
		const labels = mountChips('unread')
			.findAll('button')
			.map((b) => b.text());
		expect(labels).toHaveLength(4);
		expect(labels[0]).toContain('All');
	});
});

describe('PostboxTriageFilterChips partial counts', () => {
	it('says the counts are partial in each chip tooltip, and nothing while they are whole', () => {
		const partial = mountChips('all', true);
		for (const chip of partial.findAll('button')) {
			expect(chip.attributes('title')).toBeUndefined();
			expect(tooltipOf(partial, chip)).toBe(
				'Counts cover the messages loaded so far; scroll to load more.'
			);
		}
		partial.unmount();
		const whole = mountChips('all');
		expect(tooltipOf(whole, whole.get('button'))).toBeUndefined();
		whole.unmount();
	});
});

describe('PostboxTriageFilterChips placement filter (read on arrival §3)', () => {
	it("shows the Priority view's digest filter as an active chip whose × drops it", async () => {
		route.query = { placement: 'digest', q: 'kept' };
		const w = mountChips('all');
		const chip = w.get('[data-testid="placement-filter-chip"]');
		expect(chip.text()).toContain('In your digest');
		await chip.trigger('click');
		expect(routerReplace).toHaveBeenCalledWith({ query: { q: 'kept' } });
		expect(w.find('[data-testid="placement-filter-chip"]').exists()).toBe(false);
	});

	it('ignores a placement it does not know', () => {
		route.query = { placement: 'everything' };
		expect(mountChips('all').find('[data-testid="placement-filter-chip"]').exists()).toBe(false);
		route.query = {};
	});
});
