// @vitest-environment happy-dom
/**
 * The mail search results page (/dashboard/postbox/search), after #777.
 *
 * - It is where ⌘K's Mail search lands on Enter, and it has no second search
 *   box: the query shows as a button that reopens ⌘K with that query.
 * - The "only the first 200 characters are searched" notice is for admins, who
 *   can change it, and links to the setting. Members never see it.
 * - When recent pages match nothing but older mail remains, "Search older mail"
 *   is a real button that keeps walking.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref } from 'vue';

import { i18nStubs } from '~/__tests__/i18n';
import { mountDashboardPage } from '~/__tests__/a11y';
import SearchPage from '../search.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const route = reactive({
	path: '/dashboard/postbox/search',
	query: { q: 'invoice' } as Record<string, string>,
});
const routerReplace = vi.fn((location: { query: Record<string, string> }) => {
	route.query = location.query;
});
const openPalette = vi.fn();
const role = ref<'owner' | 'admin' | 'editor'>('editor');
const bodyIndexing = ref(false);
const results = ref<Array<{ _id: string }>>([]);
const hasMore = ref(false);
const isWalking = ref(false);
const searchOlder = vi.fn(() => {
	isWalking.value = true;
});

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useHead: () => {},
		definePageMeta: () => {},
		useRoute: () => route,
		useRouter: () => ({ replace: routerReplace }),
		useCommandPalette: () => ({ open: openPalette }),
		usePermissions: () => ({
			isAdmin: computed(() => role.value === 'owner' || role.value === 'admin'),
		}),
		usePostboxMailbox: () => ({
			currentMailbox: ref({ _id: 'mailbox-1' }),
			isLoading: ref(false),
		}),
		usePostboxSearch: () => ({
			parsed: ref({}),
			results,
			isLoading: ref(false),
			isLoadingMore: ref(false),
			hasMore,
			canLoadMore: hasMore,
			loadMore: vi.fn(),
			isWalking,
			searchOlder,
		}),
		// Settings row for the admin notice; the backfill status is not needed
		// for the "disabled" state, so every other query resolves empty.
		useConvexQuery: (_ref: unknown, args: unknown) => {
			const resolved = typeof args === 'function' ? (args as () => unknown)() : args;
			if (resolved === 'skip') return { data: ref(undefined) };
			return {
				data: computed(() =>
					resolved && typeof resolved === 'object' && 'mailboxId' in resolved
						? null
						: { isBodySearchIndexingEnabled: bodyIndexing.value }
				),
			};
		},
		usePostboxSavedSearches: () => ({
			savedSearches: ref([]),
			save: vi.fn(),
			isSaving: ref(false),
		}),
		describeChips: () => [],
		removeSearchOperator: (q: string) => q,
		stripSearchOperators: (q: string) => q,
		resolveBodySearchDepth: (input: { isIndexingEnabled: boolean }) =>
			input.isIndexingEnabled ? 'deep' : 'disabled',
		bodySearchDepthHint: (depth: string) =>
			depth === 'deep' ? null : { key: `dashboard.postbox.search.depth.${depth}` },
	});
});

beforeEach(() => {
	route.query = { q: 'invoice' };
	role.value = 'editor';
	bodyIndexing.value = false;
	results.value = [];
	hasMore.value = false;
	isWalking.value = false;
	openPalette.mockClear();
	searchOlder.mockClear();
});

const passthrough = (name: string) =>
	defineComponent({
		name,
		setup:
			(_p, { slots }) =>
			() =>
				h('div', slots.default?.()),
	});
const nuxtLinkStub = defineComponent({
	name: 'NuxtLink',
	props: { to: { type: String, required: true } },
	setup:
		(props, { slots, attrs }) =>
		() =>
			h('a', { ...attrs, href: props.to }, slots.default?.()),
});
const buttonStub = defineComponent({
	name: 'UiButton',
	setup:
		(_p, { slots, attrs }) =>
		() =>
			h('button', { ...attrs, type: 'button' }, slots.default?.()),
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function mountPage() {
	wrapper = mountDashboardPage(SearchPage, {
		components: {
			NuxtLink: nuxtLinkStub,
			UiButton: buttonStub,
			PostboxMailboxGuard: passthrough('PostboxMailboxGuard'),
			PostboxComposerStack: passthrough('PostboxComposerStack'),
		},
		stubs: {
			Icon: true,
			I18nT: true,
			PostboxThreadListSkeleton: true,
			PostboxEmptyState: true,
			PostboxThreadList: true,
			PostboxThreadReader: true,
			PostboxShortcutHelp: true,
		},
	});
	return wrapper;
}

describe('mail search page', () => {
	it('has no search box of its own; the query reopens ⌘K to change it', async () => {
		const page = mountPage();
		expect(page.find('input[role="combobox"]').exists()).toBe(false);
		const refine = page.get('[data-testid="mail-search-refine"]');
		expect(refine.text()).toContain('invoice');
		// The visible query is the button's name, not replaced by an aria-label.
		expect(refine.attributes('aria-label')).toBeUndefined();
		expect(refine.text()).toContain('Change search');
		await refine.trigger('click');
		expect(openPalette).toHaveBeenCalledWith({ scope: 'mail', query: 'invoice' });
	});

	it('hides the 200-character notice from members', () => {
		const page = mountPage();
		expect(page.find('[data-testid="body-search-depth-hint"]').exists()).toBe(false);
		expect(page.text()).not.toContain('200 characters');
	});

	it('shows admins the notice with a link to the setting', () => {
		role.value = 'admin';
		const page = mountPage();
		const hint = page.get('[data-testid="body-search-depth-hint"]');
		expect(hint.text()).toContain('first 200 characters');
		expect(page.get('[data-testid="body-search-depth-link"]').attributes('href')).toBe(
			'/dashboard/admin/instance/general#mail-search'
		);
	});

	it('says nothing to admins once message bodies are searchable', () => {
		role.value = 'owner';
		bodyIndexing.value = true;
		expect(mountPage().find('[data-testid="body-search-depth-hint"]').exists()).toBe(false);
	});

	it('offers "Search older mail" when recent mail has no match but more remains', async () => {
		hasMore.value = true;
		const page = mountPage();
		const block = page.get('[data-testid="search-older"]');
		expect(block.text()).toContain('No matches in recent mail.');
		const button = block.get('button');
		expect(button.text()).toBe('Search older mail');
		await button.trigger('click');
		expect(searchOlder).toHaveBeenCalledTimes(1);
		expect(page.get('[data-testid="search-older"]').text()).toContain('Searching older mail…');
		expect(page.get('[data-testid="search-older"]').find('button').exists()).toBe(false);
	});
});
