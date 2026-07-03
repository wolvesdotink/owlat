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

beforeEach(() => {
	persistThreads.mockClear();
	isOffline.value = false;
	// usePostboxOfflineThreads reaches for the cache composable via auto-import.
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		loadThreads: vi.fn(async () => cachedRows),
		persistThreads,
		isOffline,
	}));
});

/** A minimal list component that renders whatever rows the bridge yields. */
function mountList(liveRows: Ref<Row[]>, isLoading: Ref<boolean>) {
	const Comp = defineComponent({
		setup() {
			const folderRole = ref('inbox');
			const mailboxId = ref('mbx1');
			const { rows, showingCached } = usePostboxOfflineThreads<Row>({
				mailboxId,
				folderRole,
				liveRows,
				isLoading,
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
});
