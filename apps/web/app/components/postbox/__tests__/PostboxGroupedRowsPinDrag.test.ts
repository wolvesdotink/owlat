/**
 * Drag-to-pin from the grouped renderers (Conversations, Categories, Bundled,
 * Sections). Their rows have no selection and no move verb, so a row starts a
 * pin-only session carrying its one message (a conversation row: its newest):
 * an empty pinned band appears for it and takes the drop, while the rail's
 * folders and labels refuse it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, type Component } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	providePostboxListMailbox,
	usePostboxMessageDrag,
	usePostboxMessageDropTargets,
} from '~/composables/postbox/usePostboxMessageDrag';
import PostboxPinnedBand from '../PostboxPinnedBand.vue';
import PostboxThreadGroupList from '../PostboxThreadGroupList.vue';
import PostboxThreadCategoryList from '../PostboxThreadCategoryList.vue';
import PostboxThreadBundleList from '../PostboxThreadBundleList.vue';
import PostboxThreadSectionList from '../PostboxThreadSectionList.vue';
import PostboxSectionedThreadList from '../PostboxSectionedThreadList.vue';
import PostboxConversationRow from '../PostboxConversationRow.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import { BASE_MESSAGE } from './spoofedSenderFixture';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const pins = ref<{ conversations: unknown[]; limit: number }>({ conversations: [], limit: 5 });
const run = vi.fn();

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable') }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useConvexQuery', () => ({
		data: pins,
		isLoading: ref(false),
		error: ref(null),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

beforeEach(() => {
	pins.value = { conversations: [], limit: 5 };
	run.mockReset();
	run.mockResolvedValue({ ok: true, result: { ok: true } });
});

afterEach(() => usePostboxMessageDrag().end());

const conversation = {
	_id: 'thread-1',
	latestMessageId: 'msg-latest',
	latestFromAddress: 'ines@example.com',
	latestSubject: 'Quarterly numbers',
	latestSnippet: 'See attached',
	lastMessageAt: 1_700_000_000_000,
	messageCount: 3,
	unreadCount: 0,
	hasFlagged: false,
	hasAttachments: false,
};
const message = { ...BASE_MESSAGE, _id: 'msg-row' as Id<'mailMessages'> };

const RENDERERS: Array<{
	name: string;
	component: Component;
	props: Record<string, unknown>;
	carries: string;
}> = [
	{
		name: 'Conversations',
		component: PostboxThreadGroupList,
		props: { threads: [conversation] },
		carries: 'msg-latest',
	},
	{
		name: 'Categories',
		component: PostboxThreadCategoryList,
		props: {
			sections: [
				{ key: 'person', label: 'shared.mailCategory.person', icon: 'x', threads: [conversation] },
			],
			collapsed: {},
		},
		carries: 'msg-latest',
	},
	{
		name: 'Bundled',
		component: PostboxThreadBundleList,
		props: { entries: [{ kind: 'message', message }], expanded: {} },
		carries: 'msg-row',
	},
	{
		name: 'Sections',
		component: PostboxThreadSectionList,
		props: {
			sections: [
				{
					name: null,
					key: '',
					messages: [message],
					unreadCount: 0,
					isUnreadCapped: false,
					canLoadMore: false,
				},
			],
			collapsed: {},
		},
		carries: 'msg-row',
	},
];

/** The Browse column in miniature: a provided mailbox, the band, one renderer. */
function mountColumn(renderer: Component, props: Record<string, unknown>, provide = true) {
	const Host = defineComponent({
		setup() {
			if (provide) providePostboxListMailbox(ref('mbx-1' as Id<'mailboxes'>));
			const rail = usePostboxMessageDropTargets(ref('mbx-1' as Id<'mailboxes'>));
			return () =>
				h('div', [
					h(PostboxPinnedBand, { mailboxId: 'mbx-1' as Id<'mailboxes'> }),
					h('div', { 'data-testid': 'folder', ...rail.folder({ _id: 'f-9', role: null }) }),
					h('div', { 'data-testid': 'label', ...rail.label('l-1', vi.fn()) }),
					h(renderer, { loading: false, folderRole: 'inbox', ...props }),
				]);
		},
	});
	return mount(Host, {
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxSectionedThreadList,
				PostboxConversationRow,
				PostboxThreadListSkeleton,
				PostboxEmptyState,
			},
			stubs: {
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				PostboxThreadRowBody: { template: '<span />' },
				UiModal: { template: '<span />' },
				UiButton: true,
				UiSkeleton: true,
			},
		},
	});
}

/** Dispatch a cancelable drag event; `true` means the target claimed it. */
function fire(el: Element, type: string, dataTransfer?: object) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	if (dataTransfer) Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
	el.dispatchEvent(event);
	return event.defaultPrevented;
}

const band = (w: ReturnType<typeof mountColumn>) => w.find('[data-testid="postbox-pinned-band"]');

describe('drag-to-pin from the grouped renderers', () => {
	it.each(RENDERERS)('$name: a dragged row pins through the band', async (r) => {
		const w = mountColumn(r.component, r.props);
		expect(band(w).exists()).toBe(false);
		const row = w.get('a[draggable="true"]');
		const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' };
		fire(row.element, 'dragstart', dataTransfer);
		await nextTick();

		expect(dataTransfer.setData).toHaveBeenCalledWith(
			'application/x-owlat-messages',
			JSON.stringify([r.carries])
		);
		expect(band(w).text()).toContain('Drop here to pin');
		// Pin-only: the rail's folders and labels refuse the drag.
		expect(fire(w.get('[data-testid="folder"]').element, 'dragover')).toBe(false);
		expect(fire(w.get('[data-testid="label"]').element, 'dragover')).toBe(false);
		expect(fire(band(w).element, 'dragover')).toBe(true);
		expect(fire(band(w).element, 'drop')).toBe(true);
		expect(run).toHaveBeenCalledWith({ messageIds: [r.carries], pinned: true });
	});

	it('a dragend without a drop closes the session and hides the empty band', async () => {
		const w = mountColumn(PostboxThreadGroupList, { threads: [conversation] });
		const row = w.get('a[draggable="true"]');
		fire(row.element, 'dragstart', { setData: vi.fn(), setDragImage: vi.fn() });
		await nextTick();
		expect(band(w).exists()).toBe(true);
		fire(row.element, 'dragend');
		await nextTick();
		expect(band(w).exists()).toBe(false);
	});

	it('leaves rows undraggable outside a list that provides its mailbox', () => {
		const w = mountColumn(PostboxThreadGroupList, { threads: [conversation] }, false);
		expect(w.find('a[draggable="true"]').exists()).toBe(false);
	});
});
