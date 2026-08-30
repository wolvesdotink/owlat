/**
 * The message list's newest/oldest arrival order, split out of PostboxLayout.vue
 * (which owns the panes) to keep that file under the file-size cap and to keep
 * the switch testable without mounting a Convex-backed layout.
 *
 * The order is persisted per user (usePostboxSettings, passed in by the layout
 * so the settings query stays a single subscription there). A pick applies
 * immediately as a pending optimistic override — the read re-subscribes on the
 * new order right away — and hands back to the saved value once the mutation
 * lands, or snaps back if it failed. Exactly the contract the view-mode switch
 * uses.
 *
 * It is a PICK, not a flip: the order is one radio group in the list header's
 * Display menu, where both options are on screen at once, so re-choosing the
 * active one has to be a no-op rather than a toggle back.
 */

import type { Ref } from 'vue';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';

export function usePostboxSortOrder(options: {
	savedSortOrder: Ref<PostboxSortOrder>;
	setSortOrder: (order: PostboxSortOrder) => Promise<boolean>;
}) {
	const pending = ref<PostboxSortOrder | null>(null);
	const sortOrder = computed<PostboxSortOrder>(() => pending.value ?? options.savedSortOrder.value);

	// The server caught up with the optimistic value: stop overriding.
	watch(options.savedSortOrder, (saved) => {
		if (pending.value === saved) pending.value = null;
	});

	function selectSortOrder(order: PostboxSortOrder) {
		if (order === sortOrder.value) return;
		pending.value = order;
		// useBackendOperation already toasts a failed save; the list simply goes
		// back to the order the server still holds.
		void options.setSortOrder(order).then((saved) => {
			if (!saved && pending.value === order) pending.value = null;
		});
	}

	return { sortOrder, selectSortOrder };
}
