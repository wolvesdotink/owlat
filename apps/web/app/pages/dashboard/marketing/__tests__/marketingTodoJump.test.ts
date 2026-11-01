/**
 * The marketing overview's "N to do" chip jumps down to Next up. It glides
 * there, unless the reader asked for less motion: the app's own Reduce motion
 * setting cannot reach an explicit `behavior: 'smooth'` through CSS, so the
 * page has to ask the shared owner and jump instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setAppReducedMotion } from '@owlat/ui/composables/useReducedMotion';

import MarketingOverview from '../index.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs } from '~/__tests__/a11y';

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
	scrollIntoView = vi.fn();
	vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(scrollIntoView);
});

afterEach(() => {
	setAppReducedMotion(false);
	vi.restoreAllMocks();
});

function render(): VueWrapper {
	installNuxtStubs({
		...i18nStubs,
		useHead: () => {},
		definePageMeta: () => {},
		useRouter: () => ({ push: vi.fn() }),
		// The overview is still loading, so neither performance band renders and
		// the header chip is the only control on the page.
		useOrganizationQuery: () => ({ data: ref(null), isLoading: ref(true), error: ref(null) }),
		useMarketingNextUp: () => ({
			needsYou: ref([]),
			scheduled: ref([]),
			scheduledTotal: ref(0),
			drafts: ref([]),
			todoCount: ref(2),
			isUrgent: ref(false),
			isLoading: ref(false),
			error: ref(null),
		}),
	});
	return mount(MarketingOverview, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiPageHeader: { template: '<header><slot name="actions" /></header>' },
				UiButton: true,
				UiSkeleton: true,
				UiErrorAlert: true,
				UiCard: true,
				UiEmptyState: true,
				UiTrendChart: true,
				MarketingNextUp: true,
			},
		},
	}) as VueWrapper;
}

const todoChip = (wrapper: VueWrapper) =>
	wrapper.findAll('button').find((button) => button.text().includes('2'))!;

describe('marketing overview — the to-do chip', () => {
	it('glides down to Next up', async () => {
		const wrapper = render();
		await todoChip(wrapper).trigger('click');
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
	});

	it('jumps without animating when motion is reduced in the app', async () => {
		setAppReducedMotion(true);
		const wrapper = render();
		await todoChip(wrapper).trigger('click');
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
	});
});
