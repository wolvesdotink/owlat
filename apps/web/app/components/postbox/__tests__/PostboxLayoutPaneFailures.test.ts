/**
 * The Postbox panes fail one at a time. The reader renders mail from strangers
 * and the list renders their subjects and snippets, so either can hit a render
 * error; it must take down only its own pane. The rail, the other pane and the
 * back bar keep working, and opening another message brings the reader back.
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
import PostboxReaderPane from '../PostboxReaderPane.vue';
import en from '../../../../i18n/locales/en.json';

const ROWS = ['m_bad', 'm_ok'].map((id, index) => ({
	_id: id,
	mailboxId: 'mbx1',
	fromAddress: 'sender@example.com',
	toAddresses: ['me@owlat.example'],
	ccAddresses: [],
	subject: `Subject ${index}`,
	snippet: '',
	receivedAt: 1_700_000_000_000 - index,
	flagSeen: true,
}));

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
		// The folder's list holds both messages, so the reader opens either from it.
		usePostboxThreads: () => ({
			messages: ref(ROWS),
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
			path: '/dashboard/postbox/archive',
			fullPath: '/dashboard/postbox/archive',
			name: 'postbox',
			params: { folder: 'archive' },
			query: {},
			hash: '',
			meta: {},
		}),
	});
});

/** Inert chrome: only the list and reader panes are under test. */
const INERT = Object.fromEntries(
	[
		'PostboxBannerSlot',
		'PostboxDraftList',
		'PostboxFolderDrawer',
		'PostboxListHeader',
		'PostboxPaneResizer',
		'PostboxQuickActionsBar',
		'PostboxReaderPlaceholder',
		'PostboxShortcutHelp',
		'PostboxArrivalExplain',
		'PostboxThreadBundleList',
		'PostboxThreadCategoryList',
		'PostboxThreadGroupList',
		'PostboxThreadSectionList',
		'PostboxTodayView',
		'PostboxTriageFilterChips',
	].map((name) => [name, defineComponent({ name, setup: () => () => h('div') })])
);

/** Fails to render while `failing` is true. */
function pane(testId: string, failing: Ref<boolean>, props: string[] = []) {
	return defineComponent({
		name: testId,
		props: Object.fromEntries(props.map((prop) => [prop, { type: null, default: undefined }])),
		setup: (p) => () => {
			if (failing.value) throw new Error(`${testId} could not render`);
			return h('div', { 'data-testid': testId }, String(p['message']?._id ?? ''));
		},
	});
}

async function mountLayout(failures: { list?: Ref<boolean>; reader?: (id: string) => boolean }) {
	const readerFails = failures.reader ?? (() => false);
	const Reader = defineComponent({
		name: 'PostboxThreadReader',
		props: { message: { type: Object, required: true } },
		setup: (p) => () => {
			if (readerFails(p.message._id)) throw new Error('unrenderable mail');
			return h('div', { 'data-testid': 'reader' }, p.message._id);
		},
	});
	const wrapper = mount(PostboxLayout, {
		props: { mailboxId: 'mbx1' as never, folderRole: 'archive', activeMessageId: 'm_bad' },
		global: {
			plugins: [createTestI18n()],
			mocks: autoImportedHelpers(),
			components: {
				...INERT,
				PostboxReaderPane,
				PostboxReaderBackBar: pane('back-bar', ref(false)),
				PostboxThreadList: pane('list', failures.list ?? ref(false)),
				PostboxThreadReader: Reader,
			},
		},
	});
	await flushPromises();
	return wrapper;
}

describe('Postbox panes that fail to render', () => {
	it('contains a failed conversation to the reader pane, and the next one opens', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const wrapper = await mountLayout({ reader: (id) => id === 'm_bad' });

		const reader = wrapper.get('.pbx-pane-reader');
		expect(reader.get('[role="alert"]').text()).toContain(en.shell.paneError.reader);
		expect(reader.find('[data-testid="back-bar"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="list"]').exists()).toBe(true);

		await wrapper.setProps({ activeMessageId: 'm_ok' });
		await flushPromises();
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="reader"]').text()).toBe('m_ok');
		wrapper.unmount();
	});

	it('contains a failed list to the list pane and keeps the open conversation', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const wrapper = await mountLayout({ list: ref(true) });

		const list = wrapper.get('.pbx-pane-list');
		expect(list.get('[role="alert"]').text()).toContain(en.shell.paneError.list);
		expect(wrapper.get('[data-testid="reader"]').text()).toBe('m_bad');
		expect(wrapper.find('.pbx-pane-reader [role="alert"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
