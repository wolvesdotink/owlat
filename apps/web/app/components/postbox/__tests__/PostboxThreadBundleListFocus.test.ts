// @vitest-environment happy-dom
/**
 * The bundled feed's focus ring: the keyboard walks every visible message (a
 * plain row, or a row inside an expanded bundle) as one flat list, and exactly
 * the focused one reads as selected. The lookup behind it is an id → index map
 * built once per list change, where it used to be a findIndex per row per
 * render; this pins that the map gives the same answer.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PostboxFeedEntry } from '~/utils/postboxBundles';
import type { PostboxThreadRowMessage } from '../PostboxThreadRow.vue';
import PostboxThreadBundleList from '../PostboxThreadBundleList.vue';
import { BASE_MESSAGE } from './spoofedSenderFixture';

const focusedIndex = ref(-1);

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex,
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
});

function msg(id: string): PostboxThreadRowMessage {
	return { ...BASE_MESSAGE, _id: id as Id<'mailMessages'> };
}

function bundle(id: string, ids: string[]): PostboxFeedEntry<PostboxThreadRowMessage> {
	return {
		kind: 'bundle',
		id,
		category: 'newsletter',
		messages: ids.map(msg),
		count: ids.length,
		latestFrom: 'Northwind Digest',
		unreadCount: 0,
	};
}

const entries: Array<PostboxFeedEntry<PostboxThreadRowMessage>> = [
	{ kind: 'message', message: msg('m-1') },
	bundle('b-open', ['m-2', 'm-3']),
	bundle('b-shut', ['m-4', 'm-5']),
	{ kind: 'message', message: msg('m-6') },
];

function mountList() {
	return mount(PostboxThreadBundleList, {
		props: {
			entries,
			expanded: { 'b-open': true },
			loading: false,
			folderRole: 'inbox',
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: { props: ['name'], template: '<span />' },
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				PostboxThreadRowBody: { template: '<span />' },
				PostboxThreadListSkeleton: true,
				PostboxEmptyState: true,
				UiButton: true,
			},
		},
	});
}

function selectedIds(wrapper: ReturnType<typeof mountList>): string[] {
	return wrapper
		.findAll('[role="option"]')
		.filter((option) => option.attributes('aria-selected') === 'true')
		.map((option) => option.attributes('id')!);
}

describe('PostboxThreadBundleList focus ring', () => {
	it('marks exactly the focused message across plain rows and expanded bundles', async () => {
		focusedIndex.value = -1;
		const wrapper = mountList();
		expect(selectedIds(wrapper)).toEqual([]);

		// Navigable order: m-1, m-2, m-3 (open bundle), m-6 (the shut bundle's
		// rows are not on the page, so they are not in the walk).
		const walk = ['m-1', 'm-2', 'm-3', 'm-6'];
		for (const [index, id] of walk.entries()) {
			focusedIndex.value = index;
			await wrapper.vm.$nextTick();
			expect(selectedIds(wrapper)).toEqual([`postbox-bundled-${id}`]);
		}
		wrapper.unmount();
	});

	it('re-indexes when a bundle opens', async () => {
		focusedIndex.value = 3;
		const wrapper = mountList();
		expect(selectedIds(wrapper)).toEqual(['postbox-bundled-m-6']);

		await wrapper.setProps({ expanded: { 'b-open': true, 'b-shut': true } });
		expect(selectedIds(wrapper)).toEqual(['postbox-bundled-m-4']);
		wrapper.unmount();
	});
});
