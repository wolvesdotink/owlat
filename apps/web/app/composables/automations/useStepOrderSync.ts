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
	/**
	 * True while `items` holds a move the user has not committed yet (a lifted
	 * keyboard step). A server snapshot then refreshes the data but keeps the
	 * preview's order.
	 */
	isPreviewing: () => boolean;
	/** A failed save replaced the list, preview included. */
	onReplaced?: () => void;
}

const idsOf = (list: readonly { _id: string }[]) => list.map((item) => item._id);
const sameOrder = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The step order on screen and the one saved for it, kept as one.
 *
 * `items` is what the list renders. Every reorder route (pointer drag,
 * keyboard drop, Move up/down) moves it and then calls `persist`, which
 * snapshots that order as the committed one. Only committed orders are saved,
 * so a keyboard move that is still lifted never reaches the server, and
 * `showCommitted` puts the list back when such a move is cancelled.
 *
 * Saves never overlap: a commit made while one is in flight replaces the
 * queued order, and when the save returns the newest committed order is sent,
 * so the last saved order is the last one the user committed. While saves are
 * pending a server snapshot only refreshes the steps' data, in the order on
 * screen, so an echo of an earlier save cannot snap the list back. A failed
 * save drops anything queued and shows the server's order again (the failed
 * operation has already shown its error).
 */
export function useStepOrderSync<T extends { _id: string }>(options: StepOrderSyncOptions<T>) {
	const items = ref([...options.server.value]) as Ref<T[]>;
	const isSaving = ref(false);
	// The order the user last committed, or the server's when nothing is queued.
	let committed = idsOf(options.server.value);
	let queued = false;
	let onSaved: (() => void) | null = null;
	let running: Promise<void> | null = null;

	// Server data in the given id order. Steps the server no longer has drop
	// out; steps it gained go in at their server position.
	const arrange = (server: readonly T[], ids: readonly string[]): T[] => {
		const byId = new Map(server.map((step) => [step._id, step]));
		const next = ids.map((id) => byId.get(id)).filter((step): step is T => step !== undefined);
		const shown = new Set(idsOf(next));
		for (const [index, step] of server.entries()) {
			if (!shown.has(step._id)) next.splice(Math.min(index, next.length), 0, step);
		}
		return next;
	};

	watch(options.server, (steps) => {
		// While saves are queued the committed order stays the user's, minus
		// steps the server dropped and plus ones it gained.
		committed = isSaving.value ? idsOf(arrange(steps, committed)) : idsOf(steps);
		const shownOrder = options.isPreviewing() ? idsOf(items.value) : committed;
		items.value = arrange(steps, shownOrder);
	});

	/** Show the committed order again, e.g. when a keyboard lift is cancelled. */
	const showCommitted = () => {
		items.value = arrange(options.server.value, committed);
	};

	const revert = () => {
		queued = false;
		onSaved = null;
		isSaving.value = false;
		committed = idsOf(options.server.value);
		items.value = [...options.server.value];
		options.onReplaced?.();
	};

	const drain = async () => {
		let sent = idsOf(options.server.value);
		while (queued) {
			queued = false;
			const ids = committed;
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
	 * Commit and save the order on screen. `saved` runs once it is stored; when
	 * commits pile up only the newest one's callback runs, after the last save.
	 */
	const persist = (saved?: () => void): Promise<void> => {
		committed = idsOf(items.value);
		onSaved = saved ?? null;
		queued = true;
		if (isSaving.value && running) return running;
		isSaving.value = true;
		running = Promise.resolve(options.whenReady(drain, revert)).then(() => {
			running = null;
		});
		return running;
	};

	return { items, isSaving, persist, showCommitted };
}
