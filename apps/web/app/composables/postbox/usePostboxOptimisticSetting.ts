/**
 * Optimistic override for a server-persisted setting (the Postbox list
 * renderer and Today↔Browse landing mode both work this way): a tap flips the
 * value IMMEDIATELY via a pending override while the save mutation lands,
 * then hands back to the server value. A failed save surfaces upstream (the
 * caller's useBackendOperation toast) and snaps the override away.
 */
export function usePostboxOptimisticSetting<T extends string>(args: {
	/** The persisted value (still loading → whatever it holds). */
	saved: Ref<T>;
	/** Persist the new value; resolves false when the save failed. */
	apply: (value: T) => Promise<boolean>;
}) {
	const pending = ref<T | null>(null);
	const value = computed<T>(() => pending.value ?? args.saved.value);

	watch(args.saved, (saved) => {
		if (pending.value === saved) pending.value = null;
	});

	function set(next: T) {
		if (next === value.value) return;
		pending.value = next;
		void args.apply(next).then((ok) => {
			if (!ok && pending.value === next) pending.value = null;
		});
	}

	/**
	 * Flip the value WITHOUT persisting — a transient override. Used where a
	 * view is opened as a one-off (the Today roll-up's "view auto-filed mail"
	 * opens Categories) and must not silently overwrite the user's saved
	 * preference. Clears on its own once the saved value catches up.
	 */
	function preview(next: T) {
		pending.value = next;
	}

	return { value, set, preview };
}
