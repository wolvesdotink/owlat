/**
 * The message list's newest/oldest toggle, split out of PostboxLayout.vue
 * (which owns the panes) to keep that file under the file-size cap and to keep
 * the flip testable without mounting a Convex-backed layout.
 *
 * The order is persisted per user (usePostboxSettings, passed in by the layout
 * so the settings query stays a single subscription there). A tap applies
 * immediately as a pending optimistic override — the read re-subscribes on the
 * new order right away — and hands back to the saved value once the mutation
 * lands, or snaps back if it failed. Exactly the contract the view-mode switch
 * uses.
 */

import type { Ref } from 'vue';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { nextPostboxSortOrder } from '~/utils/postboxSortOrder';

export function usePostboxSortToggle(options: {
	savedSortOrder: Ref<PostboxSortOrder>;
	setSortOrder: (order: PostboxSortOrder) => Promise<boolean>;
}) {
	const pending = ref<PostboxSortOrder | null>(null);
	const sortOrder = computed<PostboxSortOrder>(() => pending.value ?? options.savedSortOrder.value);

	// The server caught up with the optimistic value: stop overriding.
	watch(options.savedSortOrder, (saved) => {
		if (pending.value === saved) pending.value = null;
	});

	function toggleSortOrder() {
		const next = nextPostboxSortOrder(sortOrder.value);
		pending.value = next;
		// useBackendOperation already toasts a failed save; the list simply goes
		// back to the order the server still holds.
		void options.setSortOrder(next).then((saved) => {
			if (!saved && pending.value === next) pending.value = null;
		});
	}

	return { sortOrder, toggleSortOrder };
}
