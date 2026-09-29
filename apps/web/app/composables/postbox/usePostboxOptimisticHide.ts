/**
 * Optimistic row removal for the message list. The ConvexClient has no native
 * optimistic updates, so a triage action hides its row immediately and the live
 * subscription confirms it; a failed action restores the row. Hidden ids are
 * pruned once the row actually leaves the source list.
 *
 * A triage that starts OUTSIDE the list (the open reader's archive / trash /
 * snooze / mute / spam) reaches every mounted list through
 * `hidePostboxRowEverywhere` / `unhidePostboxRowEverywhere`: each list hides the
 * row only when it renders it, and then treats it exactly like its own triage
 * (restored on failure, pruned once the server drops it).
 */

type RowHideListener = {
	hide: (id: string) => void;
	unhide: (id: string) => void;
};

// Mounted lists, at module scope: a triage in the reader has to reach the
// list pane beside it, and the two are siblings with no shared owner.
const listeners = new Set<RowHideListener>();

/** Hide a row in every mounted list that currently renders it. */
export function hidePostboxRowEverywhere(id: string) {
	for (const listener of listeners) listener.hide(id);
}

/** Restore a row hidden by {@link hidePostboxRowEverywhere} (failure or undo). */
export function unhidePostboxRowEverywhere(id: string) {
	for (const listener of listeners) listener.unhide(id);
}

export function usePostboxOptimisticHide<T extends { _id: string }>(items: Ref<T[]>) {
	const hidden = ref<Set<string>>(new Set());

	const visible = computed(() => items.value.filter((m) => !hidden.value.has(m._id)));

	function hide(id: string) {
		hidden.value = new Set(hidden.value).add(id);
	}
	function unhide(id: string) {
		if (!hidden.value.has(id)) return;
		const next = new Set(hidden.value);
		next.delete(id);
		hidden.value = next;
	}

	// Drop ids whose row has left the source list (the server caught up).
	watch(items, (list) => {
		if (hidden.value.size === 0) return;
		const present = new Set(list.map((m) => m._id));
		const next = new Set([...hidden.value].filter((id) => present.has(id)));
		if (next.size !== hidden.value.size) hidden.value = next;
	});

	// Join the broadcast only where the scope can leave it again: a server
	// render never disposes its component scopes, so it would leak listeners.
	if (!import.meta.server && getCurrentScope()) {
		const listener: RowHideListener = {
			// Only rows this list renders — an id it never showed would sit in
			// `hidden` until the next list change prunes it.
			hide: (id) => {
				if (items.value.some((m) => m._id === id)) hide(id);
			},
			unhide,
		};
		listeners.add(listener);
		onScopeDispose(() => listeners.delete(listener));
	}

	return { visible, hide, unhide };
}
