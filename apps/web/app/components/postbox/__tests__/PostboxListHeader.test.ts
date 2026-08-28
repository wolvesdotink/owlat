// @vitest-environment happy-dom
/**
 * The list header's sort control: it names the order the list is IN, offers the
 * other one as its accessible name, and asks the layout to flip — in every
 * folder, not just the inbox (a backlog is cleared oldest-first wherever it
 * sits).
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
const listMessageIds = vi.fn(async () => ({ ids: ['a', 'b', 'c'], capped: false }));

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

beforeEach(() => {
	stateBuckets = new Map();
	listMessageIds.mockClear();
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
	vi.stubGlobal('requireConvex', () => ({ query: listMessageIds }));
	// The real selection composable, over the stubbed state + mutation layers:
	// the point of these cases is the header's reading of that shared bucket.
	vi.stubGlobal('usePostboxBulkActions', usePostboxBulkActions);
});

function mountHeader(
	props: {
		folderRole?: string;
		sortOrder?: string;
		mailboxId?: string;
		pageIds?: string[];
		selectAllScopeMatchesList?: boolean;
	} = {}
) {
	return mount(PostboxListHeader, {
		props: {
			folderName: 'Inbox',
			folderRole: props.folderRole ?? 'inbox',
			sortOrder: props.sortOrder,
			mailboxId: props.mailboxId,
			pageIds: props.pageIds,
			selectAllScopeMatchesList: props.selectAllScopeMatchesList,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				Icon: { props: ['name'], template: '<span />' },
				UiSegmentedControl: { props: ['options', 'modelValue'], template: '<div />' },
			},
		},
	});
}

const sortButton = (w: ReturnType<typeof mountHeader>) =>
	w.findAll('button').find((b) => (b.attributes('aria-label') ?? '').startsWith('Sort by'));

describe('PostboxListHeader sort toggle', () => {
	it('shows newest-first and offers oldest when no order is stored', () => {
		const w = mountHeader();
		const button = sortButton(w);
		expect(button?.text()).toBe('Newest first');
		expect(button?.attributes('aria-label')).toBe('Sort by oldest first');
	});

	it('shows oldest-first and offers newest once the order is flipped', () => {
		const w = mountHeader({ sortOrder: 'oldest' });
		const button = sortButton(w);
		expect(button?.text()).toBe('Oldest first');
		expect(button?.attributes('aria-label')).toBe('Sort by newest first');
	});

	it('asks the layout to flip the order', async () => {
		const w = mountHeader();
		await sortButton(w)?.trigger('click');
		expect(w.emitted('toggle-sort')).toHaveLength(1);
	});

	it('offers the control in a non-inbox folder too', () => {
		const w = mountHeader({ folderRole: 'archive' });
		expect(sortButton(w)).toBeDefined();
	});
});

/**
 * At a 1440px window the list pane is ~380px, which the folder title + sort
 * toggle + view-mode control do not fit on one nowrap row — and the title was
 * the flex item that lost, rendering "In…" for Inbox. The cluster has to wrap as
 * a unit instead.
 */
describe('PostboxListHeader overflow', () => {
	it('wraps rather than squeezing the folder title', () => {
		const header = mountHeader().find('header');
		expect(header.classes()).toContain('flex-wrap');
	});

	it('keeps the control cluster from shrinking into itself', () => {
		const w = mountHeader();
		const cluster = w.findAll('header > div').at(-1);
		expect(cluster?.classes()).toContain('flex-shrink-0');
	});
});

/**
 * The tri-state select-all: it covers the rows the list has LOADED, and the
 * escape hatch past that page goes to the server rather than pretending the
 * page is the folder.
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

	it('offers the whole-folder escape hatch only once the page is covered', async () => {
		const w = mountHeader({ mailboxId: 'mbx', pageIds: ['a', 'b', 'c'] });
		expect(w.text()).not.toContain('Select everything in this folder');

		await selectAllBox(w).trigger('click');
		expect(w.text()).toContain('Select everything in this folder');
	});

	it('asks the server for the folder scope and adopts the answer', async () => {
		const w = mountHeader({ mailboxId: 'mbx', pageIds: ['a', 'b', 'c'], sortOrder: 'oldest' });
		await selectAllBox(w).trigger('click');
		const escapeHatch = w
			.findAll('button')
			.find((b) => b.text() === 'Select everything in this folder');
		await escapeHatch?.trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await w.vm.$nextTick();

		expect(listMessageIds).toHaveBeenCalledTimes(1);
		// The list's own arrival direction rides along, so a capped answer keeps
		// the ids the user is actually looking at.
		expect(listMessageIds.mock.calls[0]?.[1]).toMatchObject({
			mailboxId: 'mbx',
			folderRole: 'inbox',
			sortOrder: 'oldest',
		});
		expect(w.text()).toContain('3 messages selected.');
	});
});

/**
 * The escape hatch queries by FOLDER scope, but a triage chip (unread /
 * starred / attachments) narrows what the list renders below that scope. Offered
 * under a chip it would quietly hand the next bulk verb — trash, archive, spam,
 * snooze — the rows the chip is hiding. It has to be withheld instead.
 */
describe('PostboxListHeader select-all under a triage filter', () => {
	const hatchOf = (w: ReturnType<typeof mountHeader>) =>
		w.findAll('button').find((b) => b.text() === 'Select everything in this folder');

	it('withholds the whole-folder hatch while a chip filters the list', async () => {
		const w = mountHeader({
			mailboxId: 'mbx',
			pageIds: ['a', 'b', 'c'],
			selectAllScopeMatchesList: false,
		});
		await selectAllBox(w).trigger('click');

		expect(hatchOf(w)).toBeUndefined();
		// The page selection itself is untouched — only the promise it can't keep
		// is gone, and the count that tells the user what IS selected stays.
		expect(selectAllBox(w).attributes('aria-checked')).toBe('true');
		expect(w.text()).toContain('All 3 loaded messages are selected.');
	});

	it('offers it again once the filter is cleared', async () => {
		const w = mountHeader({
			mailboxId: 'mbx',
			pageIds: ['a', 'b', 'c'],
			selectAllScopeMatchesList: false,
		});
		await selectAllBox(w).trigger('click');
		await w.setProps({ selectAllScopeMatchesList: true });

		expect(hatchOf(w)).toBeDefined();
	});

	it('never reaches the server for a scope the list is not showing', async () => {
		const w = mountHeader({
			mailboxId: 'mbx',
			pageIds: ['a', 'b', 'c'],
			selectAllScopeMatchesList: false,
		});
		await selectAllBox(w).trigger('click');
		// Belt and braces: the handler itself refuses, so no future caller can
		// re-expose the unsafe query by rendering a control that reaches it.
		const vm = w.vm as unknown as { selectAllMatching: () => Promise<void> };
		expect(typeof vm.selectAllMatching).toBe('function');
		await vm.selectAllMatching();

		expect(listMessageIds).not.toHaveBeenCalled();
	});
});
