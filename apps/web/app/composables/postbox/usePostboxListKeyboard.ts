/**
 * Shared listbox keyboard navigation for the Postbox message + conversation
 * lists: j/k (and arrows) move, Enter activates, other keys delegate to
 * `onAction`. Exposes `focusedIndex` + `activeId` for the listbox/option ARIA.
 *
 * Focus survives live Convex updates: instead of resetting on every new array
 * reference (which zeroed focus mid-triage), it re-derives the index from the
 * focused row's id, holding the slot when that row is removed (e.g. archived),
 * and only resets when `resetKey` changes (a folder switch).
 */
export function usePostboxListKeyboard<T extends { _id: string }>(opts: {
	items: Ref<T[]>;
	resetKey: Ref<unknown>;
	rowDomId: (item: T) => string;
	onActivate: (item: T) => void;
	onAction?: (key: string, item: T) => void;
}) {
	const focusedIndex = ref(-1);
	let focusedId: string | undefined;

	watch(focusedIndex, (idx) => {
		focusedId = opts.items.value[idx]?._id;
	});

	// Folder switch → drop focus so a destructive key never hits a stale row.
	watch(opts.resetKey, () => {
		focusedIndex.value = -1;
		focusedId = undefined;
	});

	// Live update within a folder → keep focus on the same row id; if it was
	// removed, hold the slot (next row slides up); clamp into range.
	watch(opts.items, (items) => {
		if (focusedIndex.value < 0) return;
		const byId = focusedId ? items.findIndex((i) => i._id === focusedId) : -1;
		focusedIndex.value = byId >= 0 ? byId : Math.min(focusedIndex.value, items.length - 1);
		focusedId = items[focusedIndex.value]?._id;
	});

	const activeId = computed(() => {
		const item = opts.items.value[focusedIndex.value];
		return item ? opts.rowDomId(item) : undefined;
	});

	// Keep the focused row in view (also realizes content-visibility rows).
	watch(focusedIndex, async (idx) => {
		if (idx < 0) return;
		await nextTick();
		const item = opts.items.value[idx];
		if (item) document.getElementById(opts.rowDomId(item))?.scrollIntoView({ block: 'nearest' });
	});

	function onKeydown(event: KeyboardEvent) {
		const items = opts.items.value;
		if (items.length === 0) return;
		const cur = focusedIndex.value;
		switch (event.key) {
			case 'j':
			case 'ArrowDown':
				event.preventDefault();
				focusedIndex.value = Math.min(cur + 1, items.length - 1);
				break;
			case 'k':
			case 'ArrowUp':
				event.preventDefault();
				focusedIndex.value = Math.max(cur - 1, 0);
				break;
			case 'Enter': {
				const m = items[cur];
				if (m) opts.onActivate(m);
				break;
			}
			default: {
				// Never treat a Cmd/Ctrl/Alt chord (browser shortcut / Windows
				// menu accelerator like Alt+E) as a triage key.
				if (event.metaKey || event.ctrlKey || event.altKey) return;
				const m = items[cur];
				if (m && opts.onAction) opts.onAction(event.key, m);
			}
		}
	}

	return { focusedIndex, activeId, onKeydown };
}
