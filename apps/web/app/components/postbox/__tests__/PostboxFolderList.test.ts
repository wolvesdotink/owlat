/**
 * PostboxFolderList in both rail states:
 *   - expanded renders labelled rows with an inline unread count
 *   - collapsed renders an icon-only strip (no label text) with the unread
 *     count as a corner badge and a tooltip/aria-label carrying the name, and
 *   - flipping `collapsed` back re-expands to the labelled rows.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import PostboxFolderList from '../PostboxFolderList.vue';
import { usePostboxMessageDrag } from '~/composables/postbox/usePostboxMessageDrag';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { tooltipOf } from '~/__tests__/tooltip';

const bulk = {
	markAllRead: vi.fn(),
	requestEmpty: vi.fn(),
	mayEmpty: true,
	canEmpty: (folder: { role?: string | null; totalCount: number }) =>
		bulk.mayEmpty && (folder.role === 'trash' || folder.role === 'spam') && folder.totalCount > 0,
};

// The rows render their copy through vue-i18n; `useI18n` is a Nuxt auto-import.
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		usePostboxFolderBulk: () => bulk,
	});
});

/** Renders the row and keeps the menu's items where a test can reach them. */
type MenuItem = { id: string; label: string; disabled?: boolean; run: () => void };
const menus: MenuItem[][] = [];
const contextMenuStub = {
	props: ['items'],
	setup(props: { items: MenuItem[] }) {
		menus.push(props.items);
	},
	template: '<div><slot :on-contextmenu="() => {}" :on-keydown="() => {}" /></div>',
};

const nuxtLinkStub = {
	props: ['to', 'title', 'ariaLabel'],
	template: '<a :href="to" :title="title" :aria-label="ariaLabel"><slot /></a>',
};

const folders = [
	{ _id: 'f1', name: 'Inbox', role: 'inbox', unseenCount: 4, totalCount: 10 },
	{ _id: 'f2', name: 'Sent', role: 'sent', unseenCount: 0, totalCount: 3 },
];

function mountList(collapsed: boolean) {
	return mount(PostboxFolderList, {
		props: {
			mailboxId: 'mbx-1' as never,
			folders,
			unreadCounts: { inbox: 4 },
			activeFolder: 'inbox',
			collapsed,
		},
		global: {
			plugins: [createTestI18n()],
			components: { NuxtLink: nuxtLinkStub, UiContextMenu: contextMenuStub },
		},
	});
}

describe('PostboxFolderList', () => {
	it('renders labelled rows with an inline unread count when expanded', () => {
		const w = mountList(false);
		expect(w.text()).toContain('Inbox');
		expect(w.text()).toContain('Sent');
		// unread count present
		expect(w.text()).toContain('4');
	});

	it('renders an icon-only strip with badges + tooltips when collapsed', () => {
		const w = mountList(true);
		// Icons for every folder still render.
		expect(w.findAll('svg')).toHaveLength(2);
		// No label text in the strip.
		expect(w.text().toLowerCase()).not.toContain('inbox');
		expect(w.text().toLowerCase()).not.toContain('sent');
		// The name lives on the link tooltip/aria-label for hover + a11y.
		const links = w.findAll('a');
		expect(tooltipOf(w, links[0]!)).toBe('Inbox');
		expect(links[0].attributes('aria-label')).toContain('Inbox');
		expect(links[0].attributes('aria-label')).toContain('4 unread');
		// Unread count still surfaced as a badge.
		expect(w.text()).toContain('4');
	});

	it('re-expands to labelled rows when collapsed flips back to false', async () => {
		const w = mountList(true);
		expect(w.text().toLowerCase()).not.toContain('inbox');
		await w.setProps({ collapsed: false });
		expect(w.text()).toContain('Inbox');
		expect(w.text()).toContain('Sent');
	});
});

describe('PostboxFolderList as a drop target', () => {
	const dropFolders = [
		{ _id: 'f1', name: 'Inbox', role: 'inbox', unseenCount: 0, totalCount: 10 },
		{ _id: 'f2', name: 'Sent', role: 'sent', unseenCount: 0, totalCount: 3 },
		{ _id: 'f3', name: 'Archive', role: 'archive', unseenCount: 0, totalCount: 7 },
	];
	const moveTo = vi.fn(async () => {});

	function mountTargets() {
		return mount(PostboxFolderList, {
			props: {
				mailboxId: 'mbx-1' as never,
				folders: dropFolders,
				unreadCounts: {},
				activeFolder: 'inbox',
			},
			global: {
				plugins: [createTestI18n()],
				components: { NuxtLink: nuxtLinkStub, UiContextMenu: contextMenuStub },
			},
		});
	}

	/** Pick up one message from the inbox of `mailboxId`, as a list row would. */
	function startDrag(mailboxId = 'mbx-1') {
		const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn() };
		usePostboxMessageDrag().start(
			{ dataTransfer } as unknown as DragEvent,
			{
				mailboxId: mailboxId as never,
				messageIds: ['m1' as never],
				sourceFolder: 'inbox',
				moveTo,
			},
			'Subject'
		);
	}

	/** Dispatch a cancelable drag event; `true` means the row claimed it. */
	function fire(el: Element, type: string) {
		const event = new Event(type, { bubbles: true, cancelable: true });
		el.dispatchEvent(event);
		return event.defaultPrevented;
	}

	afterEach(() => {
		usePostboxMessageDrag().end();
		moveTo.mockClear();
	});

	it('highlights a destination and moves the dragged messages there on drop', async () => {
		const w = mountTargets();
		startDrag();
		const archive = w.findAll('a')[2]!;
		expect(fire(archive.element, 'dragover')).toBe(true);
		await nextTick();
		expect(archive.classes()).toContain('pbx-drop-target');

		expect(fire(archive.element, 'drop')).toBe(true);
		expect(moveTo).toHaveBeenCalledWith('f3');
		// The drop closes the session, so the highlight goes with it.
		expect(usePostboxMessageDrag().session.value).toBeNull();
		await nextTick();
		expect(archive.classes()).not.toContain('pbx-drop-target');
	});

	it('refuses Sent and the folder the messages came from', async () => {
		const w = mountTargets();
		startDrag();
		const [inbox, sent] = w.findAll('a');
		expect(fire(sent!.element, 'dragover')).toBe(false);
		expect(fire(inbox!.element, 'dragover')).toBe(false);
		expect(fire(sent!.element, 'drop')).toBe(false);
		await nextTick();
		expect(sent!.classes()).not.toContain('pbx-drop-target');
		expect(moveTo).not.toHaveBeenCalled();
	});

	it("refuses messages dragged from another mailbox's list", () => {
		const w = mountTargets();
		startDrag('mbx-2');
		expect(fire(w.findAll('a')[2]!.element, 'dragover')).toBe(false);
	});

	it('ignores drags that are not message drags (files, text)', () => {
		const w = mountTargets();
		expect(fire(w.findAll('a')[2]!.element, 'dragover')).toBe(false);
	});
});

describe('PostboxFolderList right-click menu', () => {
	const menuFolders = [
		{ _id: 'f1', name: 'Inbox', role: 'inbox', unseenCount: 4, totalCount: 10 },
		{ _id: 'f2', name: 'Drafts', role: 'drafts', unseenCount: 1, totalCount: 1 },
		{ _id: 'f3', name: 'Archive', role: 'archive', unseenCount: 0, totalCount: 7 },
		{ _id: 'f4', name: 'Trash', role: 'trash', unseenCount: 0, totalCount: 5 },
	];

	function menusFor(mayEmpty = true) {
		bulk.mayEmpty = mayEmpty;
		menus.length = 0;
		mount(PostboxFolderList, {
			props: {
				mailboxId: 'mbx-1' as never,
				folders: menuFolders,
				unreadCounts: {},
				activeFolder: 'inbox',
			},
			global: {
				plugins: [createTestI18n()],
				components: { NuxtLink: nuxtLinkStub, UiContextMenu: contextMenuStub },
			},
		});
		return menus.map((items) =>
			items.map((item) => `${item.label}${item.disabled ? ' (off)' : ''}`)
		);
	}

	afterEach(() => {
		bulk.markAllRead.mockClear();
		bulk.requestEmpty.mockClear();
	});

	it('offers "Mark all as read" on every folder but Drafts, off while nothing is unread', () => {
		expect(menusFor()).toEqual([
			['Mark all as read'],
			[],
			['Mark all as read (off)'],
			['Mark all as read (off)', 'Empty trash'],
		]);
		menus[0]![0]!.run();
		expect(bulk.markAllRead).toHaveBeenCalledWith(menuFolders[0]);
		menus[3]![1]!.run();
		expect(bulk.requestEmpty).toHaveBeenCalledWith(menuFolders[3]);
	});

	it('leaves "Empty trash" out for someone who may not empty it', () => {
		expect(menusFor(false)[3]).toEqual(['Mark all as read (off)']);
	});
});
