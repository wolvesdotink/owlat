// @vitest-environment happy-dom
/**
 * Cold-start behavior: a component driven by usePostboxOfflineThreads must
 * render the device-cached inbox rows IMMEDIATELY while the live query is still
 * pending, then replace them in place with the live rows the instant they
 * arrive (live always wins).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, defineComponent, h, nextTick, type Ref } from 'vue';

import { usePostboxOfflineThreads } from '../../../composables/postbox/usePostboxOfflineThreads';

type Row = { _id: string; subject: string };

const cachedRows: Row[] = [
	{ _id: 'c1', subject: 'Cached one' },
	{ _id: 'c2', subject: 'Cached two' },
];

const isOffline = ref(false);
const persistThreads = vi.fn(async () => {});
const loadThreadsMeta = vi.fn(async () => ({ savedAt: 1_700_000_000_000 }));

beforeEach(() => {
	persistThreads.mockClear();
	loadThreadsMeta.mockClear();
	isOffline.value = false;
	// usePostboxOfflineThreads reaches for the cache composable via auto-import.
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		loadThreads: vi.fn(async () => cachedRows),
		loadThreadsMeta,
		persistThreads,
		isOffline,
	}));
});

/** A minimal list component that renders whatever rows the bridge yields. */
function mountList(
	liveRows: Ref<Row[]>,
	isLoading: Ref<boolean>,
	extra?: { isRefetching?: Ref<boolean>; folderRole?: Ref<string> }
) {
	const Comp = defineComponent({
		setup() {
			const folderRole = extra?.folderRole ?? ref('inbox');
			const mailboxId = ref('mbx1');
			const { rows, showingCached } = usePostboxOfflineThreads<Row>({
				mailboxId,
				folderRole,
				liveRows,
				isLoading,
				isRefetching: extra?.isRefetching,
			});
			return () =>
				h('div', [
					h('span', { class: 'shimmer' }, showingCached.value ? 'updating' : ''),
					h(
						'ul',
						rows.value.map((r) => h('li', { key: r._id }, r.subject))
					),
				]);
		},
	});
	return mount(Comp);
}

describe('Postbox offline cold start', () => {
	it('renders cached rows while the live query is pending', async () => {
		const liveRows = ref<Row[]>([]);
		const isLoading = ref(true);
		const wrapper = mountList(liveRows, isLoading);
		// Let the onMounted cache load resolve.
		await nextTick();
		await nextTick();

		const items = wrapper.findAll('li').map((li) => li.text());
		expect(items).toEqual(['Cached one', 'Cached two']);
		expect(wrapper.find('.shimmer').text()).toBe('updating');
	});

	it('replaces cached rows with live rows once the query settles', async () => {
		const liveRows = ref<Row[]>([]);
		const isLoading = ref(true);
		const wrapper = mountList(liveRows, isLoading);
		await nextTick();
		await nextTick();
		expect(wrapper.findAll('li')).toHaveLength(2);

		// Live query arrives — live wins, shimmer clears, rows replace in place.
		liveRows.value = [{ _id: 'L1', subject: 'Live only' }];
		isLoading.value = false;
		await nextTick();

		const items = wrapper.findAll('li').map((li) => li.text());
		expect(items).toEqual(['Live only']);
		expect(wrapper.find('.shimmer').text()).toBe('');
		// The fresh live result is persisted back to the device cache.
		expect(persistThreads).toHaveBeenCalledWith('inbox', [{ _id: 'L1', subject: 'Live only' }]);
	});

	it('does not persist the re-subscribe window over the incoming folder cache', async () => {
		// A folder switch drops the feed's accumulated rows synchronously while
		// `keepPreviousData` keeps isLoading FALSE and flips isRefetching instead.
		// Persisting in that window wrote `[]` — with a fresh savedAt — over the
		// incoming folder's cache, so the next cold start showed nothing and
		// dated itself as current.
		const liveRows = ref<Row[]>([{ _id: 'L1', subject: 'Live only' }]);
		const isLoading = ref(false);
		const isRefetching = ref(false);
		const folderRole = ref('sent');
		const wrapper = mountList(liveRows, isLoading, { isRefetching, folderRole });
		await nextTick();
		await nextTick();
		persistThreads.mockClear();

		// Switch to a cacheable folder: rows blank out, isRefetching goes true.
		folderRole.value = 'inbox';
		liveRows.value = [];
		isRefetching.value = true;
		await nextTick();
		await nextTick();
		expect(persistThreads).not.toHaveBeenCalled();
		// ...and the cached snapshot is served rather than a blank list.
		expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['Cached one', 'Cached two']);

		// The real result lands: now it persists.
		liveRows.value = [{ _id: 'L2', subject: 'Inbox row' }];
		isRefetching.value = false;
		await nextTick();
		expect(persistThreads).toHaveBeenCalledWith('inbox', [{ _id: 'L2', subject: 'Inbox row' }]);
	});
});
