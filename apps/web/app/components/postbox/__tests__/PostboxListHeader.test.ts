// @vitest-environment happy-dom
/**
 * The list header after the Display menu took the preferences: what is left is
 * the folder title, the drawer handle, the page select-all checkbox, the
 * inbox's Today|Browse switch, and one menu trigger. The four preferences it
 * used to render as permanent chrome are asserted on the menu itself
 * (PostboxListDisplayMenu.test.ts); the whole-folder select-all hatch moved to
 * the bulk bar (PostboxBulkSelectAllRow.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxListHeader from '../PostboxListHeader.vue';
import { usePostboxBulkActions } from '~/composables/postbox/usePostboxBulkActions';

// The header holds the shared per-mailbox selection bucket, so the Nuxt state
// + Convex layers it reaches through have to exist for any mount.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stateBuckets: Map<string, any>;

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

beforeEach(() => {
	stateBuckets = new Map();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	vi.stubGlobal('useBackendOperation', () => ({
		run: vi.fn(async () => ({ ok: true, result: {} })),
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePostboxTriageUndo', () => ({
		register: vi.fn(),
		registerMoveBack: vi.fn(),
	}));
	// The real selection composable, over the stubbed state + mutation layers:
	// the point of these cases is the header's reading of that shared bucket.
	vi.stubGlobal('usePostboxBulkActions', usePostboxBulkActions);
});

const displayMenuStub = {
	props: ['viewMode', 'viewModeOptions', 'sortOrder', 'density', 'readingPane'],
	template:
		'<div class="display-menu" :data-view-mode="viewMode" :data-sort="sortOrder" :data-view-modes="viewModeOptions ? \'yes\' : \'no\'" />',
};
const inboxModeToggleStub = {
	props: ['mode'],
	emits: ['select'],
	template:
		'<div class="inbox-mode-toggle" :data-mode="mode"><button type="button" data-segment="browse" @click="$emit(\'select\', \'browse\')">Browse</button></div>',
};

function mountHeader(
	props: {
		folderRole?: string;
		folderId?: string;
		activeMessageId?: string | null;
		sortOrder?: string;
		inboxMode?: string;
		mailboxId?: string;
		pageIds?: string[];
	} = {}
) {
	return mount(PostboxListHeader, {
		props: {
			folderName: 'Inbox',
			folderRole: props.folderRole ?? 'inbox',
			folderId: props.folderId,
			activeMessageId: props.activeMessageId,
			viewMode: 'flat',
			viewModeOptions: [{ value: 'flat', label: 'Flat' }],
			sortOrder: props.sortOrder,
			inboxMode: props.inboxMode ?? 'browse',
			mailboxId: props.mailboxId,
			pageIds: props.pageIds,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				Icon: { props: ['name'], template: '<span />' },
				PostboxListDisplayMenu: displayMenuStub,
				PostboxInboxModeToggle: inboxModeToggleStub,
			},
		},
	});
}

/**
 * Four persisted preferences used to be four separate controls (one of which
 * needed its own horizontal scroller to reach its labels). The header now
 * renders exactly one entrance to all of them, and hands it the state.
 */
describe('PostboxListHeader display menu', () => {
	it('renders one menu and hands it the current preferences', () => {
		const w = mountHeader({ sortOrder: 'oldest' });
		const menu = w.find('.display-menu');
		expect(menu.exists()).toBe(true);
		expect(menu.attributes('data-sort')).toBe('oldest');
	});

	it('offers it in a non-inbox folder too, minus the view mode', () => {
		// Every folder but the inbox renders flat, so a view-mode group there
		// would be a control that changes nothing.
		const menu = mountHeader({ folderRole: 'archive' }).find('.display-menu');
		expect(menu.exists()).toBe(true);
		expect(menu.attributes('data-view-modes')).toBe('no');
		expect(mountHeader().find('.display-menu').attributes('data-view-modes')).toBe('yes');
	});

	it('routes each pick back to the layout', async () => {
		const w = mountHeader();
		const menu = w.findComponent(displayMenuStub);
		menu.vm.$emit('select-view-mode', 'categories');
		menu.vm.$emit('select-sort-order', 'oldest');
		menu.vm.$emit('select-density', 'compact');
		menu.vm.$emit('select-reading-pane', 'bottom');
		await w.vm.$nextTick();

		expect(w.emitted('select-view-mode')).toEqual([['categories']]);
		expect(w.emitted('select-sort-order')).toEqual([['oldest']]);
		expect(w.emitted('select-density')).toEqual([['compact']]);
		expect(w.emitted('select-reading-pane')).toEqual([['bottom']]);
	});
});

/**
 * The one-way "Today" jump became a two-way switch on the title it describes,
 * and it only exists where a landing surface does: the inbox root, no message
 * open, no custom folder standing in for it.
 */
describe('PostboxListHeader inbox mode switch', () => {
	it('sits on the Inbox title and reports the surface on screen', () => {
		const toggle = mountHeader({ inboxMode: 'browse' }).find('.inbox-mode-toggle');
		expect(toggle.exists()).toBe(true);
		expect(toggle.attributes('data-mode')).toBe('browse');
	});

	it('asks the layout to switch surfaces', async () => {
		const w = mountHeader();
		await w.find('[data-segment="browse"]').trigger('click');
		expect(w.emitted('switch-inbox-mode')).toEqual([['browse']]);
	});

	it('is absent outside the inbox, with a message open, or in a custom folder', () => {
		expect(mountHeader({ folderRole: 'archive' }).find('.inbox-mode-toggle').exists()).toBe(false);
		expect(mountHeader({ activeMessageId: 'm-1' }).find('.inbox-mode-toggle').exists()).toBe(false);
		expect(mountHeader({ folderId: 'fld-1' }).find('.inbox-mode-toggle').exists()).toBe(false);
	});
});

/**
 * At a 1440px window the list pane is ~380px, which the folder title plus the
 * control cluster can still overflow in a long locale — and the title was the
 * flex item that lost, rendering "In…" for Inbox.
 */
describe('PostboxListHeader overflow', () => {
	it('wraps rather than squeezing the folder title', () => {
		const header = mountHeader().find('header');
		expect(header.classes()).toContain('flex-wrap');
	});
});

/**
 * The tri-state select-all: it covers the rows the list has LOADED. The escape
 * hatch past that page now lives in the bulk bar, next to the verbs it feeds.
 */
const selectAllBox = (w: ReturnType<typeof mountHeader>) => w.find('button[role="checkbox"]');

describe('PostboxListHeader select-all', () => {
	it('is absent without a selection model or without rows', () => {
		expect(selectAllBox(mountHeader()).exists()).toBe(false);
		expect(selectAllBox(mountHeader({ mailboxId: 'mbx', pageIds: [] })).exists()).toBe(false);
	});

	it('walks unchecked → checked over the loaded page and back', async () => {
		const w = mountHeader({ mailboxId: 'mbx', pageIds: ['a', 'b', 'c'] });
		expect(selectAllBox(w).attributes('aria-checked')).toBe('false');

		await selectAllBox(w).trigger('click');
		expect(selectAllBox(w).attributes('aria-checked')).toBe('true');

		await selectAllBox(w).trigger('click');
		expect(selectAllBox(w).attributes('aria-checked')).toBe('false');
	});

	it('reads as mixed while only some of the page is picked', async () => {
		const w = mountHeader({ mailboxId: 'mbx', pageIds: ['a', 'b', 'c'] });
		// A row toggled from the list writes into the same per-mailbox bucket.
		stateBuckets.get('postbox:bulk:mbx').value = new Set(['b']);
		await w.vm.$nextTick();
		expect(selectAllBox(w).attributes('aria-checked')).toBe('mixed');
	});

	it('no longer renders the whole-folder hatch itself', async () => {
		const w = mountHeader({ mailboxId: 'mbx', pageIds: ['a', 'b', 'c'] });
		await selectAllBox(w).trigger('click');
		expect(w.text()).not.toContain('Select everything in this folder');
	});
});
