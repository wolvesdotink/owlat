/**
 * Optimistic row removal for the message list. The ConvexClient has no native
 * optimistic updates, so a triage action hides its row immediately and the live
 * subscription confirms it; a failed action restores the row. Hidden ids are
 * pruned once the row actually leaves the source list.
 */
export function usePostboxOptimisticHide<T extends { _id: string }>(items: Ref<T[]>) {
	const hidden = ref<Set<string>>(new Set());

	const visible = computed(() => items.value.filter((m) => !hidden.value.has(m._id)));

	function hide(id: string) {
		hidden.value = new Set(hidden.value).add(id);
	}
	function unhide(id: string) {
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

	return { visible, hide, unhide };
}
