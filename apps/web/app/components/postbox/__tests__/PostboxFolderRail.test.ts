// @vitest-environment happy-dom
/**
 * The mailbox folder rail after the UX review of 2026-09-23.
 *
 * Two things are pinned here. The rail carries no Compose button of its own:
 * the top bar (and the phone tab bar) hold the one create action (#776). And
 * its Answer queue row is the one Answer queue filtered to this mailbox, with a
 * count that names the mailbox, so it no longer reads as a second queue whose
 * number disagrees with the sidebar's (#767).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxFolderRail from '../PostboxFolderRail.vue';
import PostboxRailLink from '../PostboxRailLink.vue';

const replyCount = ref(2);
const collapsed = ref(false);
const sections = ref({
	personal: [{ mailboxId: 'mbx-1', label: 'Ada', unread: 0 }],
	team: [{ mailboxId: 'mbx-2', label: 'Support', unread: 0 }],
});

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ path: '/dashboard/postbox/inbox', params: {}, query: {} }),
		usePostboxFolders: () => ({
			systemFolders: ref([{ _id: 'f1', name: 'Inbox', role: 'inbox' }]),
			customFolders: ref([]),
			unreadByRole: ref({}),
		}),
		usePostboxRailCollapsed: () => ({ collapsed, toggle: vi.fn() }),
		usePostboxReplyQueue: () => ({ count: computed(() => replyCount.value) }),
		usePostboxMailbox: () => ({ sections }),
		usePostboxManageDialog: () => ({
			openManager: vi.fn(),
			pendingFolderDelete: ref(null),
			requestFolderDelete: vi.fn(),
			clearFolderDelete: vi.fn(),
		}),
		usePostboxFolderActions: () => ({ remove: vi.fn() }),
		usePostboxSavedSearches: () => ({ pinnedSearches: ref([]), setPinned: vi.fn() }),
		useCommandPalette: () => ({ open: vi.fn() }),
		useSidebarState: () => ({ toggleHidden: vi.fn() }),
	});
});

beforeEach(() => {
	replyCount.value = 2;
	collapsed.value = false;
});

const nuxtLinkStub = {
	props: ['to'],
	template: '<a :href="to" v-bind="$attrs"><slot /></a>',
};

function mountRail() {
	return mount(PostboxFolderRail, {
		props: { mailboxId: 'mbx-1' as never, folderRole: 'inbox' },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxRailLink, NuxtLink: nuxtLinkStub },
			stubs: {
				Icon: true,
				PostboxMailboxSwitcher: true,
				PostboxFolderList: true,
				PostboxLabelTree: true,
				PostboxRailMoreGroup: true,
				PostboxLabelManager: true,
				UiConfirmationDialog: true,
				UiContextMenu: true,
			},
		},
	});
}

describe('PostboxFolderRail', () => {
	it('has no Compose button of its own (#776)', () => {
		const wrapper = mountRail();
		expect(wrapper.text()).not.toContain('Compose');
		expect(wrapper.html()).not.toMatch(/compose-?button/i);
	});

	it('links the Answer queue row to the one queue, filtered to this mailbox (#767)', () => {
		const link = mountRail().find('a[href="/dashboard/answer?in=mbx-1"]');
		expect(link.exists()).toBe(true);
		expect(link.text()).toContain('Answer queue');
	});

	it('says which mailbox the count covers', () => {
		const link = mountRail().find('a[href="/dashboard/answer?in=mbx-1"]');
		expect(link.text()).toContain('2 in Ada');
		expect(link.attributes('title')).toBe('Answer queue, 2 waiting in Ada');
	});

	it('keeps a number badge and a scoped name on the icon strip', () => {
		collapsed.value = true;
		const link = mountRail().find('a[href="/dashboard/answer?in=mbx-1"]');
		expect(link.text()).toBe('2');
		expect(link.attributes('aria-label')).toBe('Answer queue, 2 waiting in Ada');
	});

	it('shows no count when nothing is waiting', () => {
		replyCount.value = 0;
		const link = mountRail().find('a[href="/dashboard/answer?in=mbx-1"]');
		expect(link.text()).toBe('Answer queue');
	});
});
