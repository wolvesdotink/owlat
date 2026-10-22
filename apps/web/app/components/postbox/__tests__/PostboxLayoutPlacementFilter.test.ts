/**
 * All mail filtered to the digest placement (read on arrival §3), at the
 * layout: `?placement=digest` alone decides the surface, so a reload lands on
 * the filtered flat list whatever modes were saved (the saved inbox mode here
 * is Priority), and whole-folder "select all matching" is off, because that
 * query does not know the filter and would act on mail the list hides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, useId } from 'vue';
import { dashboardShellStubs, installNuxtStubs, paginatedResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useClickOutside } from '~/composables/useClickOutside';
import { useLocalStorage } from '~/composables/useLocalStorage';
import PostboxLayout from '../PostboxLayout.vue';
import PostboxReaderPane from '../PostboxReaderPane.vue';

function autoImportedHelpers(): Record<string, unknown> {
	const modules = {
		...import.meta.glob('../../../composables/postbox/*.ts', { eager: true }),
		...import.meta.glob('../../../utils/postbox*.ts', { eager: true }),
	};
	const helpers: Record<string, unknown> = {};
	for (const module of Object.values(modules)) {
		for (const [name, value] of Object.entries(module as Record<string, unknown>)) {
			if (typeof value === 'function') helpers[name] = value;
		}
	}
	return helpers;
}

function row(id: string, placement?: string) {
	return {
		_id: id,
		threadId: `t-${id}`,
		mailboxId: 'mbx1',
		fromAddress: 'news@example.com',
		subject: id,
		snippet: id,
		receivedAt: Date.now(),
		flagSeen: false,
		flagFlagged: false,
		hasAttachments: false,
		...(placement ? { placement } : {}),
	};
}

let query: Record<string, unknown>;

beforeEach(() => {
	query = { placement: 'digest' };
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		...autoImportedHelpers(),
		useId,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useLocalStorage,
		usePaginatedQuery: () => paginatedResult([]),
		registerCommandPaletteProvider: vi.fn(),
		unregisterCommandPaletteProvider: vi.fn(),
		usePostboxThreads: () => ({
			messages: ref([row('news', 'digest'), row('bahn', 'updates'), row('legacy')]),
			isLoading: ref(false),
			isLoadingMore: ref(false),
			isRefetching: ref(false),
			hasMore: ref(true),
			canLoadMore: ref(true),
			loadMore: vi.fn(),
			error: ref(null),
			refetch: vi.fn(),
		}),
		usePostboxOfflineThreads: (args: { liveRows: unknown }) => ({
			rows: args.liveRows,
			showingCached: ref(false),
			isOffline: ref(false),
			cachedAt: ref(null),
		}),
		useRoute: () => ({
			path: '/dashboard/postbox/inbox',
			fullPath: '/dashboard/postbox/inbox?placement=digest',
			name: 'postbox',
			params: { folder: 'inbox' },
			query,
			hash: '',
			meta: {},
		}),
	});
});

const probe = (name: string, props: string[] = []) =>
	defineComponent({
		name,
		props: Object.fromEntries(props.map((p) => [p, { type: null, default: undefined }])),
		setup: (p) => () => h('div', { 'data-testid': name, 'data-props': JSON.stringify(p) }),
	});

const INERT = Object.fromEntries(
	[
		'PostboxBannerSlot',
		'PostboxDraftList',
		'PostboxFolderDrawer',
		'PostboxListHeader',
		'PostboxPaneResizer',
		'PostboxReaderBackBar',
		'PostboxReaderPlaceholder',
		'PostboxShortcutHelp',
		'PostboxArrivalExplain',
		'PostboxThreadBundleList',
		'PostboxThreadCategoryList',
		'PostboxThreadGroupList',
		'PostboxThreadReader',
		'PostboxThreadSectionList',
		'PostboxTodayView',
		'PostboxTriageFilterChips',
	].map((name) => [name, probe(name)])
);

async function mountLayout() {
	const wrapper = mount(PostboxLayout, {
		props: { mailboxId: 'mbx1' as never, folderRole: 'inbox' },
		global: {
			plugins: [createTestI18n()],
			mocks: autoImportedHelpers(),
			components: {
				...INERT,
				PostboxReaderPane,
				PostboxQuickActionsBar: probe('PostboxQuickActionsBar', [
					'pageIds',
					'selectAllScopeMatchesList',
				]),
				PostboxThreadList: probe('PostboxThreadList', ['messages']),
			},
		},
	});
	await flushPromises();
	return wrapper;
}

function propsOf(wrapper: ReturnType<typeof mount>, name: string) {
	return JSON.parse(wrapper.get(`[data-testid="${name}"]`).attributes('data-props')!);
}

describe('PostboxLayout on ?placement=digest', () => {
	it('opens the filtered flat list, not the saved Priority view', async () => {
		const wrapper = await mountLayout();
		expect(wrapper.find('[data-testid="PostboxTodayView"]').exists()).toBe(false);
		const list = propsOf(wrapper, 'PostboxThreadList');
		expect(list.messages.map((m: { _id: string }) => m._id)).toEqual(['news']);
		wrapper.unmount();
	});

	it('keeps "select all matching" to the rows the filter shows', async () => {
		const wrapper = await mountLayout();
		const bar = propsOf(wrapper, 'PostboxQuickActionsBar');
		expect(bar.pageIds).toEqual(['news']);
		expect(bar.selectAllScopeMatchesList).toBe(false);
		wrapper.unmount();
	});
});
