/**
 * Optimistic flag painting for the message list — the read/star siblings of
 * usePostboxOptimisticHide.
 *
 * Archive, trash and snooze remove their row the instant they are invoked, but
 * star and mark-read were fire-and-forget: the icon only moved once the Convex
 * subscription delivered the mutated row, so the two highest-frequency verbs
 * were the only laggy ones. This keeps a per-row override of `flagFlagged` /
 * `flagSeen` that the rendered rows are derived through, so the click paints
 * immediately.
 *
 * The override is a claim about a mutation in flight, never a second source of
 * truth: each overridden field is dropped the moment the live row agrees with
 * it (the server caught up), and a failed mutation drops it explicitly so the
 * row snaps back to the server value.
 */

export type PostboxFlagOverride = { flagSeen?: boolean; flagFlagged?: boolean };

/** The overridable fields, listed once so merge and prune cannot drift. */
const FLAG_KEYS = ['flagSeen', 'flagFlagged'] as const;

type FlaggedRow = { _id: string; flagSeen: boolean; flagFlagged: boolean };

export function usePostboxOptimisticFlags<T extends FlaggedRow>(items: Ref<T[]>) {
	const overrides = ref<Map<string, PostboxFlagOverride>>(new Map());

	/** The source rows with any in-flight flag claim painted over them. */
	const rows = computed<T[]>(() => {
		if (overrides.value.size === 0) return items.value;
		return items.value.map((row) => {
			const patch = overrides.value.get(row._id);
			return patch ? { ...row, ...patch } : row;
		});
	});

	/** Paint a flag change for one row while its mutation is in flight. */
	function setFlags(id: string, patch: PostboxFlagOverride) {
		const next = new Map(overrides.value);
		next.set(id, { ...next.get(id), ...patch });
		overrides.value = next;
	}

	/** Drop a row's claim — the mutation failed, so the server value wins. */
	function clearFlags(id: string) {
		if (!overrides.value.has(id)) return;
		const next = new Map(overrides.value);
		next.delete(id);
		overrides.value = next;
	}

	// Prune per FIELD, not per row: a second toggle while the first is still in
	// flight leaves a claim the (now-confirmed) first mutation would otherwise
	// clear, flashing the row back to a value the user already moved past.
	watch(items, (list) => {
		if (overrides.value.size === 0) return;
		const byId = new Map(list.map((row) => [row._id, row]));
		const next = new Map<string, PostboxFlagOverride>();
		let changed = false;
		for (const [id, patch] of overrides.value) {
			const row = byId.get(id);
			// A row that left the list (archived, filtered away) takes its claim
			// with it: if it comes back, it comes back with the server's flags.
			if (!row) {
				changed = true;
				continue;
			}
			const remaining: PostboxFlagOverride = {};
			let pending = false;
			for (const key of FLAG_KEYS) {
				const claimed = patch[key];
				if (claimed === undefined) continue;
				if (row[key] === claimed) {
					changed = true;
					continue;
				}
				remaining[key] = claimed;
				pending = true;
			}
			if (pending) next.set(id, remaining);
			else changed = true;
		}
		if (changed) overrides.value = next;
	});

	return { rows, setFlags, clearFlags };
}
