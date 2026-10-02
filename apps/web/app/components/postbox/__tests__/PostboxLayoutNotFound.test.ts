// @vitest-environment happy-dom
/**
 * The Postbox reader pane for a message that is gone (#1100). A link (a
 * notification, a bookmark, the Answer queue) can name a message that was
 * deleted, moved by another client, purged from Trash, or whose mailbox is no
 * longer shared. Neither the list nor its thread has it, and `getMessage`
 * answers `null`. The pane used to fall through to "Select a message"; it now
 * says the message is no longer available, with the way back to the folder.
 *
 * The layout's real `usePostboxActiveMessageRead` runs here, against queries
 * answered by name, so the state is driven by `getMessage` itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, useId, type Ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { dashboardShellStubs, installNuxtStubs, paginatedResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useClickOutside } from '~/composables/useClickOutside';
import { useLocalStorage } from '~/composables/useLocalStorage';
import PostboxLayout from '../PostboxLayout.vue';
import PostboxMessageNotFound from '../PostboxMessageNotFound.vue';
import PostboxReaderPlaceholder from '../PostboxReaderPlaceholder.vue';
import en from '../../../../i18n/locales/en.json';

/** Postbox's own auto-imported composables and helpers, at their real implementations. */
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

const THREAD = 'mail/mailbox/messages:listThreadMessages';
const BY_ID = 'mail/mailbox/messages:getMessage';

/** What each query answers, by function name; anything unnamed answers `undefined`. */
let answers: Record<string, { data?: unknown; error?: Error }>;
const refetch = vi.fn();

function useConvexQueryByName(query: unknown, args: unknown) {
	const name = getFunctionName(query as never);
	const skipped = computed(() => (typeof args === 'function' ? args() : args) === 'skip');
	const answer = computed(() => (skipped.value ? undefined : answers[name]));
	return {
		data: computed(() => answer.value?.data),
		isLoading: computed(() => !skipped.value && !answer.value && name in answers),
		isRefetching: ref(false),
		error: computed(() => answer.value?.error ?? null),
		refetch,
		reset: vi.fn(),
	};
}

const navigateTo = vi.fn();

beforeEach(() => {
	answers = { [THREAD]: { data: null } };
	navigateTo.mockClear();
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		...autoImportedHelpers(),
		useId,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useLocalStorage,
		navigateTo,
		useConvexQuery: useConvexQueryByName,
		useOrganizationQuery: useConvexQueryByName,
		usePaginatedQuery: () => paginatedResult([]),
		registerCommandPaletteProvider: vi.fn(),
		unregisterCommandPaletteProvider: vi.fn(),
		// The folder's list is loaded and does not hold the linked message.
		usePostboxThreads: () => ({
			messages: ref([]),
			isLoading: ref(false),
			isLoadingMore: ref(false),
			isRefetching: ref(false),
			hasMore: ref(false),
			canLoadMore: ref(false),
			loadMore: vi.fn(),
			error: ref(null),
			refetch: vi.fn(),
		}),
		usePostboxOfflineThreads: (args: { liveRows: Ref<unknown[]> }) => ({
			rows: args.liveRows,
			showingCached: ref(false),
			isOffline: ref(false),
			cachedAt: ref(null),
		}),
		useRoute: () => ({
			path: '/dashboard/postbox/archive/msg_gone',
			fullPath: '/dashboard/postbox/archive/msg_gone',
			name: 'postbox',
			params: { folder: 'archive', messageId: 'msg_gone' },
			query: {},
			hash: '',
			meta: {},
		}),
	});
});

/** The layout's other panes and chrome, inert: only the reader pane is under test. */
const INERT = Object.fromEntries(
	[
		'PostboxBannerSlot',
		'PostboxDraftList',
		'PostboxFolderDrawer',
		'PostboxListHeader',
		'PostboxPaneResizer',
		'PostboxQuickActionsBar',
		'PostboxShortcutHelp',
		'PostboxThreadBundleList',
		'PostboxThreadCategoryList',
		'PostboxThreadGroupList',
		'PostboxThreadList',
		'PostboxThreadReader',
		'PostboxThreadSectionList',
		'PostboxTodayView',
		'PostboxTriageFilterChips',
	].map((name) => [name, defineComponent({ name, setup: () => () => h('div') })])
);

async function mountLayout() {
	const wrapper = mount(PostboxLayout, {
		props: { mailboxId: 'mbx1' as never, folderRole: 'archive', activeMessageId: 'msg_gone' },
		global: {
			plugins: [createTestI18n()],
			mocks: autoImportedHelpers(),
			components: { ...INERT, PostboxMessageNotFound, PostboxReaderPlaceholder },
		},
	});
	await flushPromises();
	return wrapper;
}

const NOT_FOUND = '[data-testid="postbox-message-not-found"]';
const copy = en.components.postbox;

describe('Postbox reader for a message that is gone (#1100)', () => {
	it('says "Select a message" while getMessage has not answered', async () => {
		const wrapper = await mountLayout();
		expect(wrapper.find(NOT_FOUND).exists()).toBe(false);
		expect(wrapper.text()).toContain(copy.postboxLayout.selectMessage);
		wrapper.unmount();
	});

	it('says the message is no longer available once getMessage answers null', async () => {
		answers[BY_ID] = { data: null };
		const wrapper = await mountLayout();
		const state = wrapper.get(NOT_FOUND);
		expect(state.text()).toContain(copy.postboxMessageNotFound.title);
		expect(wrapper.text()).not.toContain(copy.postboxLayout.selectMessage);

		const back = state.findAll('button').find((b) => b.text() === 'Back to Archive');
		expect(back).toBeDefined();
		await back!.trigger('click');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/archive', { replace: true });
		wrapper.unmount();
	});

	it('keeps a failed getMessage an error, not "no longer available"', async () => {
		answers[BY_ID] = { error: new Error('[CONVEX Q(x:y)] [Request ID: 1] Server Error') };
		const wrapper = await mountLayout();
		expect(wrapper.find(NOT_FOUND).exists()).toBe(false);
		const retry = wrapper.findAll('button').find((b) => b.text() === 'Try again');
		expect(retry).toBeDefined();
		await retry!.trigger('click');
		expect(refetch).toHaveBeenCalled();
		wrapper.unmount();
	});
});
