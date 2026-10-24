import type { Ref } from 'vue';
import { rangeBetween } from '~/utils/postboxRangeSelect';

/**
 * The Team Inbox list's multi-selection: the selected conversation ids and the
 * anchor a Shift+click or Shift+J/K extends from. The one owner of both, so the
 * keyboard, the row checkboxes, the bulk bar and the row menus all read the
 * same set.
 *
 * The selection only ever holds rows the list is showing. A row that leaves the
 * list (resolved by a teammate, filtered out by a live update) drops out of it,
 * so a bulk verb can never reach a conversation nobody can see, and a change of
 * view (tab, assignee, sort) starts from nothing.
 *
 * Focus and selection stay separate, as in the Postbox: j/k move the focus
 * ring, `x` toggles the focused row, and a verb with nothing selected acts on
 * the focused row alone.
 */
export function useInboxSelection<T extends { _id: string }>(opts: {
	/** The rows on screen, in the order the list renders them. */
	rows: Ref<T[]>;
	/** Changes when the view does (tab, assignee, sort); clears the selection. */
	resetKey: Ref<unknown>;
}) {
	const selected = ref<ReadonlySet<string>>(new Set());
	// An id rather than an index: rows shift under the selection as the live
	// list updates, and an index would silently re-anchor to a neighbour.
	const anchorId = ref<string | null>(null);

	const orderedIds = computed(() => opts.rows.value.map((row) => row._id));

	function clear() {
		if (selected.value.size > 0) selected.value = new Set();
		anchorId.value = null;
	}

	watch(opts.resetKey, clear);

	// Keep only what is still on screen.
	watch(orderedIds, (ids) => {
		if (selected.value.size === 0) return;
		const live = new Set(ids);
		const kept = [...selected.value].filter((id) => live.has(id));
		if (kept.length !== selected.value.size) selected.value = new Set(kept);
		if (anchorId.value !== null && !live.has(anchorId.value)) anchorId.value = null;
	});

	function isSelected(id: string): boolean {
		return selected.value.has(id);
	}

	/** A plain toggle; the row becomes the anchor whether it was picked or dropped. */
	function toggle(id: string) {
		const next = new Set(selected.value);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected.value = next;
		anchorId.value = id;
	}

	/**
	 * Add every row between the anchor and `targetId`. Without a live anchor it
	 * starts from `fallbackAnchorId` (the row Shift+J left), else selects the
	 * target alone; never a range that spans the whole list.
	 */
	function extendTo(targetId: string, fallbackAnchorId?: string) {
		const anchor = anchorId.value ?? fallbackAnchorId ?? null;
		const range = rangeBetween(orderedIds.value, anchor, targetId);
		if (range.length === 0) return;
		const next = new Set(selected.value);
		for (const id of range) next.add(id);
		selected.value = next;
		anchorId.value = anchor ?? targetId;
	}

	/** Replace the selection with exactly these ids (a partial failure keeps its failures). */
	function replace(ids: readonly string[]) {
		const live = new Set(orderedIds.value);
		selected.value = new Set(ids.filter((id) => live.has(id)));
		if (selected.value.size === 0) anchorId.value = null;
	}

	/** The selected rows, in list order. */
	const selectedRows = computed(() => opts.rows.value.filter((row) => selected.value.has(row._id)));
	const count = computed(() => selected.value.size);

	/**
	 * The rows a verb on `row` acts on: the whole selection when `row` is part
	 * of it, else `row` alone. Right-clicking an unselected row must not act on
	 * a selection made elsewhere in the list.
	 */
	function targetsFor(row: T): T[] {
		return selected.value.has(row._id) ? selectedRows.value : [row];
	}

	return {
		selected,
		count,
		selectedRows,
		isSelected,
		toggle,
		extendTo,
		replace,
		clear,
		targetsFor,
	};
}
