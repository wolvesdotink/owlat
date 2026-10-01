import { ref, watch, type Ref } from 'vue';

export interface StepOrderSyncOptions<T extends { _id: string }> {
	/** The order the server last sent. */
	server: Ref<readonly T[]>;
	/** Store a full id order. Resolves `false` when it was not saved. */
	save: (ids: string[]) => Promise<boolean>;
	/**
	 * Run `proceed` once a reorder may be saved (the open step's edits have
	 * landed), or `cancel` when the user backs out instead.
	 */
	whenReady: (proceed: () => Promise<void>, cancel: () => void) => unknown;
	/** The server's order replaced what was on screen. */
	onReplaced?: () => void;
}

const idsOf = (list: readonly { _id: string }[]) => list.map((item) => item._id);
const sameOrder = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The step order on screen and the one saved for it, kept as one.
 *
 * Every reorder route (pointer drag, keyboard drop, Move up/down) moves
 * `items` first and then calls `persist`, which saves the full id list the
 * user sees. Saves never overlap: a move made while one is in flight marks the
 * order dirty, and when the save returns the newest order on screen is sent
 * next, so the last saved order is always the displayed one. While saves are
 * pending a server snapshot only refreshes the steps' data, in the order on
 * screen, so an echo of an earlier save cannot snap the list back. A failed
 * save drops anything queued and shows the server's order again (the failed
 * operation has already shown its error).
 */
export function useStepOrderSync<T extends { _id: string }>(options: StepOrderSyncOptions<T>) {
	const items = ref([...options.server.value]) as Ref<T[]>;
	const isSaving = ref(false);
	let dirty = false;
	let onSaved: (() => void) | null = null;
	let running: Promise<void> | null = null;

	// Fresh server data in the order on screen. Steps the server no longer has
	// drop out; steps it gained go in at their server position.
	const overlay = (server: readonly T[]): T[] => {
		const byId = new Map(server.map((step) => [step._id, step]));
		const next = items.value
			.map((step) => byId.get(step._id))
			.filter((step): step is T => step !== undefined);
		const shown = new Set(idsOf(next));
		for (const [index, step] of server.entries()) {
			if (!shown.has(step._id)) next.splice(Math.min(index, next.length), 0, step);
		}
		return next;
	};

	const showServerOrder = () => {
		items.value = [...options.server.value];
		options.onReplaced?.();
	};

	watch(options.server, (steps) => {
		if (isSaving.value) items.value = overlay(steps);
		else showServerOrder();
	});

	const revert = () => {
		dirty = false;
		onSaved = null;
		isSaving.value = false;
		showServerOrder();
	};

	const drain = async () => {
		let sent = idsOf(options.server.value);
		while (dirty) {
			dirty = false;
			const ids = idsOf(items.value);
			if (sameOrder(ids, sent)) continue;
			sent = ids;
			if (!(await options.save(ids))) {
				revert();
				return;
			}
		}
		isSaving.value = false;
		const done = onSaved;
		onSaved = null;
		done?.();
	};

	/**
	 * Save the order on screen. `saved` runs once it is stored; when moves
	 * pile up only the newest one's callback runs, after the last save.
	 */
	const persist = (saved?: () => void): Promise<void> => {
		onSaved = saved ?? null;
		dirty = true;
		if (isSaving.value && running) return running;
		isSaving.value = true;
		running = Promise.resolve(options.whenReady(drain, revert)).then(() => {
			running = null;
		});
		return running;
	};

	return { items, isSaving, persist };
}
