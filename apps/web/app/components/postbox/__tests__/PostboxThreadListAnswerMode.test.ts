// @vitest-environment happy-dom
/**
 * The list's side of Answer mode:
 *   - r / a / f on a row open Answer mode on that row's message (no kind for
 *     `r`: Answer mode resolves the default reply mode and runs the guard);
 *   - Esc on the list closes the conversation open beside it;
 *   - the j/k row survives the round trip: filed on unmount, taken back on the
 *     mount that is the return from Answer mode, and only then.
 *
 * Same auto-import stubs as PostboxThreadListStates.test.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref, computed, nextTick, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadList from '../PostboxThreadList.vue';
import { recallScroll, rememberScroll } from '../../../composables/postbox/usePostboxVirtualList';
import { usePostboxRowTriage } from '../../../composables/postbox/usePostboxRowTriage';
import { usePostboxOptimisticFlags } from '../../../composables/postbox/usePostboxOptimisticFlags';
import { usePostboxRowPickers } from '../../../composables/postbox/usePostboxRowPickers';
import {
	usePostboxListRowDrag,
	usePostboxMessageDrag,
} from '../../../composables/postbox/usePostboxMessageDrag';
import { nextUnreadIndex, resolvePostboxShortcut } from '../../../utils/postboxShortcuts';
import { rememberListPlace, takeListPlace } from '../../../composables/useAnswerMode';
import PostboxThreadRow from '../PostboxThreadRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';

// The generated Convex api object is only passed through to the (stubbed)
// operation composables — a self-returning proxy stands in for any path.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const prefetchSpy = vi.fn();
/** The bulk selection the drag cases start from. */
const selectedIds = ref<string[]>([]);
const clearSelection = vi.fn(() => {
	selectedIds.value = [];
});
/** The key the list hands its keyboard focus to reset on. */
let focusResetKey: Ref<unknown> | undefined;
type KeyboardOptions = {
	resetKey: Ref<unknown>;
	onAction: (key: string, item: { _id: string }) => void;
};
let keyboard: KeyboardOptions | undefined;
const focusedIndex = ref(-1);
const navigateTo = vi.fn();
const state = new Map<string, Ref<unknown>>();
/** Every triage mutation the list runs; resolves like a landed useBackendOperation. */
const runSpy = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: true, result: null }));

beforeAll(() => {
	vi.stubGlobal('usePostboxPrefetch', () => ({ prefetch: prefetchSpy }));
	vi.stubGlobal('usePostboxBulkActions', () => ({
		toggle: vi.fn(),
		ids: selectedIds,
		isSelected: (id: string) => selectedIds.value.includes(id),
		clear: clearSelection,
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy }));
	// The REAL flag-override composable: the list's optimistic star / mark-read
	// painting is the behaviour under test, not a stub of it.
	vi.stubGlobal('usePostboxOptimisticFlags', usePostboxOptimisticFlags);
	vi.stubGlobal('usePostboxOptimisticHide', (messages: Ref<unknown[]>) => ({
		visible: computed(() => messages.value),
		hide: vi.fn(),
		unhide: vi.fn(),
	}));
	vi.stubGlobal('usePostboxTriageUndo', () => ({
		registerMoveBack: vi.fn(),
		onWindowKeydown: vi.fn(),
	}));
	// The REAL triage composable, running against the inert useBackendOperation /
	// usePostboxTriageUndo stubs above — the list's verbs stay covered end to end
	// rather than being replaced by a mock that can drift from the real shape.
	vi.stubGlobal('usePostboxRowTriage', usePostboxRowTriage);
	vi.stubGlobal('useState', (key: string, init?: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init ? init() : null));
		return state.get(key);
	});
	vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]), setOnMessage: vi.fn() }));
	vi.stubGlobal('usePostboxFolders', () => ({ folders: ref([]) }));
	// The h/l/v picker state lives in its own composable now; real, because it is
	// only refs over the two stubbed queries above.
	vi.stubGlobal('usePostboxRowPickers', usePostboxRowPickers);
	// Real: the drag source is the behaviour under test in its own block below.
	vi.stubGlobal('usePostboxListRowDrag', usePostboxListRowDrag);
	vi.stubGlobal('useRoute', () => ({ params: { folder: 'inbox' } }));
	vi.stubGlobal('nextUnreadIndex', nextUnreadIndex);
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable') }));
	// The list resolves the sender-trust-marker flag once and passes it down.
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('usePostboxListKeyboard', (opts: KeyboardOptions) => {
		focusResetKey = opts.resetKey;
		keyboard = opts;
		return { focusedIndex, activeId: ref(undefined), onKeydown: vi.fn() };
	});
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('useRouter', () => ({
		currentRoute: ref({ path: '/dashboard/postbox/inbox', fullPath: '/dashboard/postbox/inbox' }),
	}));
	vi.stubGlobal('resolvePostboxShortcut', resolvePostboxShortcut);
	// The list's empty-state copy and operation labels flow through vue-i18n now;
	// `useI18n` is a Nuxt auto-import, so it has to exist as a global.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const iconStub = { props: ['name'], template: '<span />' };
const nuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };
const dialogStub = { template: '<span />' };
// Renderless: exposes the scoped-slot handlers the row binds, no popover.
const contextMenuStub = {
	props: ['items'],
	template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
};

function makeMessage(i: number) {
	return {
		_id: `msg-${i}` as Id<'mailMessages'>,
		fromAddress: `sender${i}@example.com`,
		fromName: `Sender ${i}`,
		subject: `Subject ${i}`,
		snippet: `Snippet ${i}`,
		receivedAt: Date.now() - i * 60_000,
		flagSeen: false,
		flagFlagged: false,
		hasAttachments: false,
	};
}

function mountList(opts: {
	loading: boolean;
	messages?: ReturnType<typeof makeMessage>[];
	folderRole?: string;
	folderId?: string;
	emptyContext?: 'label';
	hasMore?: boolean;
	activeMessageId?: string;
}) {
	return mount(PostboxThreadList, {
		props: {
			mailboxId: 'mailbox-1' as never,
			messages: opts.messages ?? [],
			loading: opts.loading,
			folderRole: opts.folderRole ?? 'inbox',
			folderId: opts.folderId,
			emptyContext: opts.emptyContext,
			hasMore: opts.hasMore,
			activeMessageId: opts.activeMessageId,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxThreadRow,
				PostboxRowCore,
				PostboxThreadRowBody,
				PostboxThreadListSkeleton,
				PostboxEmptyState,
				UiSkeleton,
				Icon: iconStub,
				NuxtLink: nuxtLinkStub,
				UiContextMenu: contextMenuStub,
				PostboxSnoozeDialog: dialogStub,
				PostboxLabelPickerDialog: dialogStub,
				PostboxMovePickerDialog: dialogStub,
				PostboxSwipeTrack: { template: '<div><slot /></div>' },
				PostboxThreadRowFollowUp: { template: '<span />' },
				UiAvatar: { template: '<span />' },
			},
			mocks: {
				resolveComponent: () => 'div',
			},
		},
	});
}

beforeEach(() => {
	navigateTo.mockClear();
	focusedIndex.value = -1;
	state.clear();
	takeListPlace('__drain__');
});

const rows = [makeMessage(1), makeMessage(2), makeMessage(3)];
const act = (key: string, id: string) => keyboard!.onAction(key, { _id: id });

describe('PostboxThreadList and Answer mode', () => {
	it('opens Answer mode from r / a / f on a row', () => {
		mountList({ loading: false, messages: rows });
		act('r', 'msg-2');
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/answer/m/msg-2');
		act('a', 'msg-2');
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/answer/m/msg-2?kind=replyAll');
		act('f', 'msg-3');
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/answer/m/msg-3?kind=forward');
		// And remembers the list as the way back.
		expect(state.get('answer:return-to')?.value).toBe('/dashboard/postbox/inbox');
	});

	it('closes the open conversation on Esc', () => {
		mountList({ loading: false, messages: rows, activeMessageId: 'msg-2' });
		act('Escape', 'msg-2');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});

	it('does nothing on Esc when no conversation is open', () => {
		mountList({ loading: false, messages: rows });
		act('Escape', 'msg-2');
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('puts the j/k focus back on the way back from Answer mode', async () => {
		const first = mountList({ loading: false, messages: rows });
		focusedIndex.value = 2;
		act('r', 'msg-3');
		first.unmount();

		focusedIndex.value = -1;
		mountList({ loading: false, messages: rows });
		await flushPromises();
		expect(focusedIndex.value).toBe(2);
	});

	it('starts a later visit to the folder fresh', async () => {
		rememberListPlace('inbox', { focusedId: 'msg-3' });
		mountList({ loading: false, messages: rows });
		await flushPromises();
		expect(focusedIndex.value).toBe(-1);
	});
});
