/**
 * Deleting the conversation that is open beside the list, from the list itself:
 * the reader must not stay on mail the list just threw away. Every row entry
 * point (hover Delete, the context menu, the `#` key, a swipe, a drag onto the
 * Trash folder) takes the reader off it the way the reader's own Delete does —
 * the auto-advance setting picks the neighbour, else back to the folder list —
 * and before the server answers. Deleting another row leaves the reader alone;
 * a failed delete goes back to the message; Undo restores the row in place.
 *
 * Same auto-import stubs as PostboxThreadListAnswerMode.test.ts, with the real
 * optimistic hide so the neighbour is picked from the order on screen.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref, computed, nextTick, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadList from '../PostboxThreadList.vue';
import { usePostboxRowTriage } from '../../../composables/postbox/usePostboxRowTriage';
import { usePostboxOptimisticFlags } from '../../../composables/postbox/usePostboxOptimisticFlags';
import { usePostboxOptimisticHide } from '../../../composables/postbox/usePostboxOptimisticHide';
import { usePostboxRowPickers } from '../../../composables/postbox/usePostboxRowPickers';
import {
	usePostboxListRowDrag,
	usePostboxMessageDrag,
} from '../../../composables/postbox/usePostboxMessageDrag';
import { nextUnreadIndex, resolvePostboxShortcut } from '../../../utils/postboxShortcuts';
import type { PostboxAutoAdvanceMode } from '../../../utils/postboxAutoAdvance';
import PostboxThreadRow from '../PostboxThreadRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type Outcome = { ok: boolean; result: unknown };
/** Each mutation call parks here until the test settles it. */
const pending: Array<{ args: unknown; settle: (outcome: Outcome) => void }> = [];
const runSpy = vi.fn(
	(args: unknown) =>
		new Promise<Outcome>((resolve) => {
			pending.push({ args, settle: resolve });
		})
);
const registerMoveBack = vi.fn();
const navigateTo = vi.fn();
const currentPath = ref('/dashboard/postbox/inbox/msg-2');
const autoAdvance = ref<PostboxAutoAdvanceMode>('next');
const selectedIds = ref<string[]>([]);
const state = new Map<string, Ref<unknown>>();
type KeyboardOptions = { onAction: (key: string, item: { _id: string }) => void };
let keyboard: KeyboardOptions | undefined;

beforeAll(() => {
	vi.stubGlobal('usePostboxPrefetch', () => ({ prefetch: vi.fn() }));
	vi.stubGlobal('usePostboxBulkActions', () => ({
		toggle: vi.fn(),
		ids: selectedIds,
		isSelected: (id: string) => selectedIds.value.includes(id),
		clear: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy }));
	vi.stubGlobal('usePostboxOptimisticFlags', usePostboxOptimisticFlags);
	vi.stubGlobal('usePostboxOptimisticHide', usePostboxOptimisticHide);
	vi.stubGlobal('usePostboxTriageUndo', () => ({ registerMoveBack, undo: vi.fn() }));
	vi.stubGlobal('usePostboxRowTriage', usePostboxRowTriage);
	vi.stubGlobal('useState', (key: string, init?: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init ? init() : null));
		return state.get(key);
	});
	vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]), setOnMessage: vi.fn() }));
	vi.stubGlobal('usePostboxFolders', () => ({
		folders: ref([
			{ _id: 'fld_archive', role: 'archive', name: 'Archive' },
			{ _id: 'fld_trash', role: 'trash', name: 'Trash' },
		]),
	}));
	vi.stubGlobal('usePostboxRowPickers', usePostboxRowPickers);
	vi.stubGlobal('usePostboxListRowDrag', usePostboxListRowDrag);
	vi.stubGlobal('useRoute', () => ({ params: { folder: 'inbox' }, query: {} }));
	vi.stubGlobal('nextUnreadIndex', nextUnreadIndex);
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable'), autoAdvance }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('usePostboxListKeyboard', (opts: KeyboardOptions) => {
		keyboard = opts;
		return { focusedIndex: ref(-1), activeId: ref(undefined), onKeydown: vi.fn() };
	});
	vi.stubGlobal('navigateTo', (to: string, opts?: unknown) => {
		navigateTo(to, opts);
		currentPath.value = to.split('?')[0]!;
		return Promise.resolve();
	});
	vi.stubGlobal('useRouter', () => ({
		currentRoute: computed(() => ({ path: currentPath.value, fullPath: currentPath.value })),
	}));
	vi.stubGlobal('resolvePostboxShortcut', resolvePostboxShortcut);
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const iconStub = { props: ['name'], template: '<span />' };
// Renderless: exposes the scoped-slot handlers the row binds, no popover.
const contextMenuStub = {
	props: ['items'],
	template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
};

function makeMessage(i: number) {
	return {
		_id: `msg-${i}` as Id<'mailMessages'>,
		threadId: `thread-${i}`,
		fromAddress: `sender${i}@example.com`,
		fromName: `Sender ${i}`,
		subject: `Subject ${i}`,
		snippet: `Snippet ${i}`,
		receivedAt: Date.now() - i * 60_000,
		flagSeen: true,
		flagFlagged: false,
		hasAttachments: false,
	};
}
const rows = [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4)];

function mountList(
	opts: {
		activeMessageId?: string | null;
		selectable?: boolean;
		folderRole?: string;
		folderId?: string;
	} = {}
) {
	const wrapper = mount(PostboxThreadList, {
		props: {
			mailboxId: 'mailbox-1' as never,
			messages: rows,
			loading: false,
			folderRole: opts.folderRole ?? 'inbox',
			folderId: opts.folderId,
			selectable: opts.selectable,
			activeMessageId: opts.activeMessageId === undefined ? 'msg-2' : opts.activeMessageId,
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
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiContextMenu: contextMenuStub,
				PostboxSnoozeDialog: { template: '<span />' },
				PostboxLabelPickerDialog: { template: '<span />' },
				PostboxMovePickerDialog: { template: '<span />' },
				PostboxSwipeTrack: { template: '<div><slot /></div>' },
				PostboxThreadRowFollowUp: { template: '<span />' },
				UiAvatar: { template: '<span />' },
			},
			mocks: { resolveComponent: () => 'div' },
		},
	});
	return wrapper;
}

function rowFor(wrapper: ReturnType<typeof mountList>, id: string) {
	const row = wrapper
		.findAllComponents(PostboxThreadRow)
		.find((r) => (r.props('msg') as { _id: string })._id === id);
	if (!row) throw new Error(`no row ${id}`);
	return row;
}

const visibleIds = (wrapper: ReturnType<typeof mountList>) =>
	wrapper.findAllComponents(PostboxThreadRow).map((r) => (r.props('msg') as { _id: string })._id);

const moved = (...ids: string[]) => ({
	ok: true,
	result: { moved: ids.map((messageId) => ({ messageId, sourceFolderId: 'fld_inbox' })) },
});

beforeEach(() => {
	navigateTo.mockClear();
	runSpy.mockClear();
	registerMoveBack.mockClear();
	pending.length = 0;
	state.clear();
	selectedIds.value = [];
	autoAdvance.value = 'next';
	currentPath.value = '/dashboard/postbox/inbox/msg-2';
	usePostboxMessageDrag().end();
});

describe('PostboxThreadList — deleting the open conversation', () => {
	it('moves the reader to the next row on hover Delete, before the server answers', async () => {
		const wrapper = mountList();
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		await nextTick();
		expect(navigateTo).toHaveBeenCalledTimes(1);
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox/msg-3', undefined);
		expect(pending).toHaveLength(1);
		expect(visibleIds(wrapper)).toEqual(['msg-1', 'msg-3', 'msg-4']);
		pending[0]!.settle(moved('msg-2'));
		await flushPromises();
		expect(navigateTo).toHaveBeenCalledTimes(1);
	});

	it('does the same from the # key, the context menu and a swipe', async () => {
		for (const trigger of ['key', 'menu', 'swipe'] as const) {
			navigateTo.mockClear();
			currentPath.value = '/dashboard/postbox/inbox/msg-2';
			const wrapper = mountList();
			if (trigger === 'key') keyboard!.onAction('#', { _id: 'msg-2' });
			else if (trigger === 'menu') {
				const items = rowFor(wrapper, 'msg-2')
					.findComponent(contextMenuStub)
					.props('items') as Array<{ id: string; run: () => void }>;
				items.find((item) => item.id === 'trash')!.run();
			} else await rowFor(wrapper, 'msg-2').vm.$emit('swipe', 'trash');
			await nextTick();
			expect(navigateTo, trigger).toHaveBeenCalledWith('/dashboard/postbox/inbox/msg-3', undefined);
			wrapper.unmount();
		}
	});

	it('leaves the reader alone when a different row is deleted', async () => {
		const wrapper = mountList();
		await rowFor(wrapper, 'msg-3').vm.$emit('trash');
		keyboard!.onAction('#', { _id: 'msg-4' });
		await nextTick();
		expect(navigateTo).not.toHaveBeenCalled();
		expect(visibleIds(wrapper)).toEqual(['msg-1', 'msg-2']);
	});

	it('does nothing when no conversation is open', async () => {
		const wrapper = mountList({ activeMessageId: null });
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		await nextTick();
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('follows the auto-advance setting: previous, and back to the list', async () => {
		autoAdvance.value = 'previous';
		let wrapper = mountList();
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/postbox/inbox/msg-1', undefined);
		wrapper.unmount();

		autoAdvance.value = 'back-to-list';
		wrapper = mountList();
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/postbox/inbox', undefined);
	});

	it('goes back to the list when the open row is the last one', async () => {
		const wrapper = mountList({ activeMessageId: 'msg-4' });
		await rowFor(wrapper, 'msg-4').vm.$emit('trash');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', undefined);
	});

	it('builds the route from a custom folder id', async () => {
		const wrapper = mountList({ folderRole: '', folderId: 'fold_1' });
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/fold_1/msg-3', undefined);
	});

	it('returns to the message when the delete fails and the person has not moved on', async () => {
		const wrapper = mountList();
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		expect(currentPath.value).toBe('/dashboard/postbox/inbox/msg-3');
		pending[0]!.settle({ ok: false, result: null });
		await flushPromises();
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/postbox/inbox/msg-2', {
			replace: true,
		});
		expect(visibleIds(wrapper)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
		expect(registerMoveBack).not.toHaveBeenCalled();
	});

	it('stays where the person went if the failure arrives after they moved on', async () => {
		const wrapper = mountList();
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		currentPath.value = '/dashboard/postbox/inbox/msg-4';
		pending[0]!.settle({ ok: false, result: null });
		await flushPromises();
		expect(navigateTo).toHaveBeenCalledTimes(1);
	});

	it('Undo puts the row back without touching the route', async () => {
		const wrapper = mountList();
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		pending[0]!.settle(moved('msg-2'));
		await flushPromises();
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		const entry = registerMoveBack.mock.calls[0]![0] as { after: () => void };
		navigateTo.mockClear();
		entry.after();
		await nextTick();
		expect(visibleIds(wrapper)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('treats a drag onto the Trash folder as a delete, and onto another folder as a move', async () => {
		const drag = usePostboxMessageDrag();
		let wrapper = mountList();
		const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' };
		await rowFor(wrapper, 'msg-2').vm.$emit('drag-start', { dataTransfer } as unknown as DragEvent);
		void drag.session.value!.moveTo!('fld_archive' as Id<'mailFolders'>);
		await nextTick();
		expect(navigateTo).not.toHaveBeenCalled();
		wrapper.unmount();

		wrapper = mountList();
		await rowFor(wrapper, 'msg-2').vm.$emit('drag-start', { dataTransfer } as unknown as DragEvent);
		void drag.session.value!.moveTo!('fld_trash' as Id<'mailFolders'>);
		await nextTick();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox/msg-3', undefined);
	});

	it('hands an in-place host the neighbour, or null to close it', async () => {
		let wrapper = mountList({ selectable: true });
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		expect(wrapper.emitted('select')).toEqual([['msg-3']]);
		expect(navigateTo).not.toHaveBeenCalled();
		wrapper.unmount();

		autoAdvance.value = 'back-to-list';
		wrapper = mountList({ selectable: true });
		await rowFor(wrapper, 'msg-2').vm.$emit('trash');
		expect(wrapper.emitted('select')).toEqual([[null]]);
	});
});
