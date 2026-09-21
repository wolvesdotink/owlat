// @vitest-environment happy-dom
/**
 * The rail's "More" group.
 *
 * Folding eight destinations away is only safe if two things hold: nothing
 * unread can hide behind the fold (Spam's count badges the group header), and
 * the fold can never hide where you currently are (a route inside the group
 * forces it open regardless of the saved preference). Import is asserted
 * explicitly because linking `/dashboard/postbox/migrate` at all is the point —
 * before this group the wizard was reachable only by typing the URL.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxRailMoreGroup from '../PostboxRailMoreGroup.vue';

const routePath = ref('/dashboard/postbox/inbox');
const moreOpen = ref(false);
const toggle = vi.fn(() => {
	moreOpen.value = !moreOpen.value;
});
const openManager = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ path: routePath.value }),
		usePostboxRailMore: () => ({ isOpen: moreOpen, toggle, setOpen: vi.fn() }),
		usePostboxManageDialog: () => ({ openManager }),
	});
});

beforeEach(() => {
	routePath.value = '/dashboard/postbox/inbox';
	moreOpen.value = false;
	toggle.mockClear();
	openManager.mockClear();
});

const iconStub = { props: ['name'], template: '<span class="icon" :data-name="name" />' };
const railLinkStub = {
	props: ['to', 'icon', 'label', 'collapsed', 'count', 'active', 'countLabel', 'muted'],
	template: '<a class="rail-link" :href="to" :data-active="active">{{ label }}</a>',
};
const folderListStub = {
	props: ['folders', 'unreadCounts', 'activeFolder', 'collapsed'],
	template:
		'<nav class="folder-list"><span v-for="f in folders" :key="f._id">{{ f.role }}</span></nav>',
};

const folders = [
	{ _id: 'f5', name: 'Spam', role: 'spam', unseenCount: 3, totalCount: 12 },
	{ _id: 'f6', name: 'Trash', role: 'trash', unseenCount: 0, totalCount: 4 },
];

function mountGroup(props: Record<string, unknown> = {}) {
	return mount(PostboxRailMoreGroup, {
		props: { collapsed: false, folders, folderRole: 'inbox', ...props },
		global: {
			plugins: [createTestI18n()],
			components: {
				Icon: iconStub,
				PostboxRailLink: railLinkStub,
				PostboxFolderList: folderListStub,
			},
		},
	});
}

describe('PostboxRailMoreGroup', () => {
	it('is folded by default and badges the header with Spam unread', () => {
		const w = mountGroup();
		const header = w.get('button[aria-expanded]');
		expect(header.attributes('aria-expanded')).toBe('false');
		expect(header.text()).toContain('3');
		expect(w.findAll('.rail-link')).toHaveLength(0);
	});

	it('drops the badge once the group is open (the count is visible below)', async () => {
		const w = mountGroup();
		await w.get('button[aria-expanded]').trigger('click');
		expect(toggle).toHaveBeenCalledOnce();
		expect(w.get('button[aria-expanded]').attributes('aria-expanded')).toBe('true');
		expect(w.get('button[aria-expanded]').text()).not.toContain('3');
	});

	it('holds itself open on a route it owns, whatever the saved preference says', () => {
		routePath.value = '/dashboard/postbox/files';
		const w = mountGroup();
		expect(w.get('button[aria-expanded]').attributes('aria-expanded')).toBe('true');
	});

	it('holds itself open while a folder it owns is the active one', () => {
		const w = mountGroup({ folderRole: 'spam' });
		expect(w.get('button[aria-expanded]').attributes('aria-expanded')).toBe('true');
	});

	it('links every destination the rail gave up, Import included', () => {
		moreOpen.value = true;
		const w = mountGroup();
		const hrefs = w.findAll('.rail-link').map((link) => link.attributes('href'));
		expect(hrefs).toEqual([
			'/dashboard/postbox/snoozed',
			'/dashboard/postbox/files',
			'/dashboard/postbox/subscriptions',
			'/dashboard/postbox/contacts',
			'/dashboard/postbox/migrate',
			'/dashboard/preferences',
		]);
		// Spam and Trash ride along as real folder rows.
		expect(w.get('.folder-list').text()).toContain('spam');
		expect(w.get('.folder-list').text()).toContain('trash');
	});

	it('opens the one manage surface from inside the group', async () => {
		moreOpen.value = true;
		const w = mountGroup();
		const buttons = w.findAll('button');
		await buttons[buttons.length - 1]!.trigger('click');
		expect(openManager).toHaveBeenCalledWith({ section: 'folders' });
	});
});
