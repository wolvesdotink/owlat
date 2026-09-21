// @vitest-environment happy-dom
/**
 * The grouped renderers (conversation view, smart-inbox categories) window their
 * rows with fixed-height arithmetic: rows are positioned by
 * POSTBOX_ROW_HEIGHT[density] against a translateY offset (conversations) or
 * padTop/padBottom spacers (categories), and section headers are charged a flat
 * POSTBOX_SECTION_HEADER_HEIGHT.
 *
 * That math only holds if the painted boxes are those exact heights. A row left
 * at its natural height is off by the divider hairline (divide-y / border-b) and
 * by whatever the padding actually resolves to — small per row, but it
 * accumulates with the window's start index until the rows no longer line up
 * with the offset they were positioned by. So: the pinning class has to be on
 * the row (and the header) whenever the list is virtualizing, and must NOT be
 * there when it isn't — a small list keeps its natural, content-sized rows.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadGroupList from '../PostboxThreadGroupList.vue';
import PostboxThreadCategoryList from '../PostboxThreadCategoryList.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';

// Both renderers virtualize above 100 rows; these bracket that threshold.
const SMALL = 5;
const LARGE = 150;

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('compact') }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
});

function makeThread(i: number) {
	return {
		_id: `thread-${i}`,
		latestMessageId: `msg-${i}`,
		latestFromAddress: `sender${i}@example.com`,
		latestSubject: `Subject ${i}`,
		latestSnippet: `Snippet ${i}`,
		lastMessageAt: 1_700_000_000_000 - i * 60_000,
		messageCount: 1,
		unreadCount: 0,
		hasFlagged: false,
		hasAttachments: false,
	};
}

const globalOptions = {
	plugins: [createTestI18n()],
	components: { PostboxThreadListSkeleton, PostboxEmptyState },
	// Auto-imports the TEMPLATES call resolve through the component context, not
	// globalThis, so a vi.stubGlobal would never be seen by the row markup.
	mocks: { formatThreadTimestamp: () => '10:24' },
	stubs: {
		Icon: { props: ['name'], template: '<span />' },
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		UiModal: { template: '<span />' },
		UiSkeleton: { template: '<span />' },
	},
};

function mountGroupList(count: number) {
	return mount(PostboxThreadGroupList, {
		props: {
			threads: Array.from({ length: count }, (_, i) => makeThread(i)),
			loading: false,
			folderRole: 'inbox',
		},
		global: globalOptions,
	});
}

function mountCategoryList(count: number) {
	return mount(PostboxThreadCategoryList, {
		props: {
			sections: [
				{
					key: 'person' as const,
					label: 'shared.postbox.usePostboxThreadCategories.sections.person',
					icon: 'lucide:user',
					threads: Array.from({ length: count }, (_, i) => makeThread(i)),
				},
			],
			collapsed: {},
			loading: false,
			folderRole: 'inbox',
		},
		global: globalOptions,
	});
}

describe('PostboxThreadGroupList windowed rows', () => {
	it('pins every mounted row to the height the window math assumes', () => {
		const rows = mountGroupList(LARGE).findAll('li');
		expect(rows.length).toBeGreaterThan(0);
		// Every row, not just some: one unpinned row shifts all of its successors.
		expect(rows.every((li) => li.classes().includes('pbx-virtual-row'))).toBe(true);
	});

	it('leaves a small list at its natural row height', () => {
		const rows = mountGroupList(SMALL).findAll('li');
		expect(rows).toHaveLength(SMALL);
		expect(rows.some((li) => li.classes().includes('pbx-virtual-row'))).toBe(false);
	});

	it('mounts only a window of a large list, not every row', () => {
		expect(mountGroupList(LARGE).findAll('li').length).toBeLessThan(LARGE);
	});
});

describe('PostboxThreadCategoryList windowed rows', () => {
	const rowsOf = (w: ReturnType<typeof mountCategoryList>) =>
		w.findAll('li').filter((li) => li.find('a').exists());

	it('pins every mounted row to the height the spacer math assumes', () => {
		const rows = rowsOf(mountCategoryList(LARGE));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((li) => li.classes().includes('pbx-virtual-row'))).toBe(true);
	});

	it('pins the sticky section header to its charged constant', () => {
		const header = mountCategoryList(LARGE).find('li.sticky');
		expect(header.classes()).toContain('pbx-section-header');
	});

	it('leaves a small list — rows and header — at natural height', () => {
		const w = mountCategoryList(SMALL);
		expect(rowsOf(w)).toHaveLength(SMALL);
		expect(rowsOf(w).some((li) => li.classes().includes('pbx-virtual-row'))).toBe(false);
		expect(w.find('li.sticky').classes()).not.toContain('pbx-section-header');
	});
});
