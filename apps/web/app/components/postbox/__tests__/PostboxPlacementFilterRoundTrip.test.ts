// @vitest-environment happy-dom
/**
 * The digest filter survives a round trip (read on arrival §3, review F11):
 * opening a row of the filtered list (its link and the keyboard), the reader
 * stepping on, and returning to the list all keep `?placement=digest`, so
 * the reader closes onto the same filtered list it was opened from.
 *
 * The layout runs with the REAL thread list, rows and back bar.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, useId } from 'vue';
import { dashboardShellStubs, installNuxtStubs, paginatedResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useClickOutside } from '~/composables/useClickOutside';
import { useLocalStorage } from '~/composables/useLocalStorage';
import PostboxLayout from '../PostboxLayout.vue';
import PostboxThreadList from '../PostboxThreadList.vue';
import PostboxThreadRow from '../PostboxThreadRow.vue';
import PostboxReaderBackBar from '../PostboxReaderBackBar.vue';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxSwipeTrack from '../PostboxSwipeTrack.vue';
import { usePostboxListQuery } from '~/composables/postbox/usePostboxPlacementFilter';

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
const navigateTo = vi.fn();

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
		navigateTo,
		useBackendOperation: () => ({
			run: vi.fn(async () => ({ ok: true, result: {} })),
			isLoading: ref(false),
			error: ref(null),
		}),
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
		'PostboxReaderPlaceholder',
		'PostboxShortcutHelp',
		'PostboxThreadBundleList',
		'PostboxThreadCategoryList',
		'PostboxThreadGroupList',
		'PostboxThreadSectionList',
		'PostboxTodayView',
		'PostboxTriageFilterChips',
	].map((name) => [name, probe(name)])
);

/** The reader's place in the round trip: the query it would keep on advance and close. */
const readerProbe = defineComponent({
	name: 'PostboxThreadReader',
	setup() {
		const listQuery = usePostboxListQuery();
		return () => h('div', { 'data-testid': 'reader', 'data-query': listQuery.value });
	},
});

async function mountLayout(activeMessageId?: string) {
	navigateTo.mockClear();
	const wrapper = mount(PostboxLayout, {
		props: { mailboxId: 'mbx1' as never, folderRole: 'inbox', activeMessageId },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			mocks: autoImportedHelpers(),
			components: {
				...INERT,
				PostboxQuickActionsBar: probe('PostboxQuickActionsBar'),
				PostboxThreadList,
				PostboxThreadRow,
				PostboxReaderBackBar,
				PostboxThreadReader: readerProbe,
				PostboxThreadRowBody,
				PostboxRowCore,
				PostboxSwipeTrack,
				UiAvatar: probe('UiAvatar'),
				// The row's right-click menu wraps the row itself.
				UiContextMenu: defineComponent({
					name: 'UiContextMenu',
					setup:
						(_p, { slots }) =>
						() =>
							h('div', slots.default?.({ onContextmenu: () => {}, onKeydown: () => {} })),
				}),
				PostboxThreadListSkeleton: probe('PostboxThreadListSkeleton'),
				PostboxEmptyState: probe('PostboxEmptyState'),
				PostboxThreadRowFollowUp: probe('PostboxThreadRowFollowUp'),
				PostboxSnoozeDialog: probe('PostboxSnoozeDialog'),
				PostboxLabelPickerDialog: probe('PostboxLabelPickerDialog'),
				PostboxMovePickerDialog: probe('PostboxMovePickerDialog'),
			},
		},
	});
	await flushPromises();
	return wrapper;
}

const ROUTE = '/dashboard/postbox/inbox/news?placement=digest';

describe('the filtered All mail list, opened and closed', () => {
	it('opens a row with the filter kept, by its link and by the keyboard', async () => {
		const wrapper = await mountLayout();
		const links = wrapper.findAll('a[href^="/dashboard/postbox/inbox/"]');
		expect(links.map((a) => a.attributes('href'))).toEqual([ROUTE]);

		const list = wrapper.get('[role="listbox"]');
		await list.trigger('keydown', { key: 'j' });
		await list.trigger('keydown', { key: 'Enter' });
		expect(navigateTo).toHaveBeenCalledWith(ROUTE);
		wrapper.unmount();
	});

	it('hands the reader the filter for advancing, and goes back to the filtered list', async () => {
		const wrapper = await mountLayout('news');
		expect(wrapper.get('[data-testid="reader"]').attributes('data-query')).toBe(
			'?placement=digest'
		);
		const back = wrapper
			.findAll('button')
			.find((b) => b.text().includes('Inbox') && !b.attributes('aria-label'));
		expect(back).toBeDefined();
		await back!.trigger('click');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox?placement=digest', {
			replace: true,
		});
		wrapper.unmount();
	});

	it('Esc from the list closes the open conversation onto the filtered list', async () => {
		const wrapper = await mountLayout('news');
		const list = wrapper.get('[role="listbox"]');
		await list.trigger('keydown', { key: 'j' });
		await list.trigger('keydown', { key: 'Escape' });
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox?placement=digest', {
			replace: true,
		});
		wrapper.unmount();
	});
});
