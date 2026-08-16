/**
 * Multi-select state for the Review Queue browse list (piece C2), following
 * the `usePostboxBulkActions` idiom: a `useState`-bucketed Set of selected row
 * ids, pruned as rows leave the visible list (approved elsewhere, live
 * updates), driving the sticky bulk action bar.
 *
 * Selection is capped at `REVIEW_BULK_ACTION_LIMIT` — the same 50 the backend
 * batch mutations enforce (`inbox/bulkMutations.ts`) and the queue page size —
 * so "select all visible" can never assemble a batch the server would refuse.
 */

/** Client mirror of the server-side bulk batch cap (BULK_DECISION_LIMIT). */
export const REVIEW_BULK_ACTION_LIMIT = 50;

export function useReviewBulkSelect(items: Ref<Array<{ _id: string }>>) {
	const selected = useState<Set<string>>('review:bulk-select', () => new Set());

	function isSelected(id: string) {
		return selected.value.has(id);
	}

	/** Add ids up to the cap (silently stops at the limit, Postbox-style). */
	function selectMany(ids: string[]) {
		const next = new Set(selected.value);
		for (const id of ids) {
			if (next.size >= REVIEW_BULK_ACTION_LIMIT && !next.has(id)) break;
			next.add(id);
		}
		selected.value = next;
	}

	function toggle(id: string) {
		if (selected.value.has(id)) {
			const next = new Set(selected.value);
			next.delete(id);
			selected.value = next;
		} else {
			selectMany([id]);
		}
	}

	function selectAllVisible() {
		selectMany(items.value.map((row) => row._id));
	}

	function clear() {
		selected.value = new Set();
	}

	// Drop ids whose row has left the visible list (approved/rejected elsewhere,
	// or hidden optimistically and confirmed by the live subscription) so the
	// bar's count never includes rows the member can no longer see.
	watch(items, (list) => {
		if (selected.value.size === 0) return;
		const present = new Set(list.map((row) => row._id));
		const next = new Set([...selected.value].filter((id) => present.has(id)));
		if (next.size !== selected.value.size) selected.value = next;
	});

	const count = computed(() => selected.value.size);
	const ids = computed(() => Array.from(selected.value));

	return { selected, ids, count, isSelected, toggle, selectMany, selectAllVisible, clear };
}
