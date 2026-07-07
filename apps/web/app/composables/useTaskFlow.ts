/**
 * useTaskFlow — the state machine behind the focused card-stack that shows ONE
 * agent task at a time and auto-advances on completion. Drives BOTH queues
 * (personal Reply Queue and the team Review Queue) from the same logic; each
 * mount supplies its own live source, so the two flows stay fully separate.
 *
 * SNAPSHOT SEMANTICS. `start()` freezes an ordered snapshot of the queue (via
 * orderTaskFlow). From then on the live subscription may only:
 *   - APPEND newly-arrived items to the end (they never jump ahead of, or
 *     reorder, the card you are on), surfaced as a quiet "+n new" hint; and
 *   - MARK items that vanished from the source (resolved elsewhere) as removed,
 *     so the peek and future advances skip them — but the CURRENT card is never
 *     yanked out from under you. The last-known copy is cached so it keeps
 *     rendering even after it leaves the source.
 *
 * PROGRESS MONOTONICITY. `position` is a cursor that only moves forward as you
 * complete cards; new arrivals grow the total (m) and the "+n new" hint but
 * never push `position` backwards. The one sanctioned exception is `undo()`,
 * which is an explicit reversal of your last action and therefore restores the
 * prior card AND its position.
 *
 * UNDO. `complete()` may register an inverse callback; `undo()` (Cmd/Ctrl+Z,
 * mirroring usePostboxUndoSend / usePostboxTriageUndo) pops the last action,
 * restores the flow position, un-tallies the outcome, and runs that inverse.
 */

import { isEditableTarget } from '~/utils/postboxShortcuts';
import {
	estimateTaskFlowSeconds,
	orderTaskFlow,
	summarizeTaskFlow,
	type TaskFlowKind,
	type TaskFlowOrderKey,
	type TaskFlowTally,
} from '~/utils/taskFlow';

export interface UseTaskFlowOptions<T> {
	/** Project a source item onto its ordering key (id + kind + thread/contact). */
	key: (item: T) => TaskFlowOrderKey;
}

/** Options for completing (or skipping) the current card. */
export interface TaskFlowCompleteOptions {
	/** Outcome bucket for the end-state summary, e.g. 'answered' / 'approved'. */
	outcome?: string;
	/** Inverse to run if this action is later undone (Cmd/Ctrl+Z). */
	inverse?: () => void | Promise<void>;
}

export function useTaskFlow<T>(source: Ref<readonly T[]>, options: UseTaskFlowOptions<T>) {
	const keyOf = options.key;

	/** The frozen, ordered list of ids; grows only by append. */
	const orderedIds = ref<string[]>([]);
	/** Ids present at snapshot time — everything else is a later arrival. */
	const snapshotIds = ref<Set<string>>(new Set());
	/** Every id we have ever placed in `orderedIds` (so re-arrivals aren't re-appended). */
	const knownIds = ref<Set<string>>(new Set());
	/** Ids we ourselves completed (so their disappearance isn't "external"). */
	const completedIds = ref<Set<string>>(new Set());
	/** Ids that vanished from the source without us completing them. */
	const externallyRemoved = ref<Set<string>>(new Set());
	/** Last-known copy of every ordered item, so the current card survives removal. */
	const itemCache = new Map<string, T>();

	/** How many cards we have advanced past — monotonic except through undo(). */
	const cursor = ref(0);
	const active = ref(false);

	/** Ordered outcome tallies for the end-state summary. */
	const tallies = ref<TaskFlowTally[]>([]);

	interface UndoEntry {
		id: string;
		prevCursor: number;
		outcome?: string;
		inverse?: () => void | Promise<void>;
	}
	const undoStack = ref<UndoEntry[]>([]);

	const itemsById = computed(() => {
		const map = new Map<string, T>();
		for (const item of source.value) map.set(keyOf(item).id, item);
		return map;
	});

	/** Freeze the current source order as the flow snapshot and enter the flow. */
	function start() {
		const ordered = orderTaskFlow(source.value, keyOf).map((item) => keyOf(item).id);
		orderedIds.value = [...ordered];
		snapshotIds.value = new Set(ordered);
		knownIds.value = new Set(ordered);
		completedIds.value = new Set();
		externallyRemoved.value = new Set();
		itemCache.clear();
		for (const item of source.value) itemCache.set(keyOf(item).id, item);
		cursor.value = 0;
		tallies.value = [];
		undoStack.value = [];
		active.value = true;
	}

	// Live reconciliation: append arrivals, mark external removals, refresh cache.
	// Never touches `cursor` or reorders `orderedIds` — snapshot semantics.
	watch(
		source,
		(list) => {
			if (!active.value) return;
			const present = new Set<string>();
			for (const item of list) {
				const id = keyOf(item).id;
				present.add(id);
				itemCache.set(id, item);
				if (!knownIds.value.has(id)) {
					orderedIds.value = [...orderedIds.value, id];
					knownIds.value = new Set(knownIds.value).add(id);
				}
			}
			// Anything we knew but no longer see (and did not complete ourselves)
			// was resolved elsewhere — mark it so peek/advance skip it.
			const removed = new Set<string>();
			for (const id of knownIds.value) {
				if (!present.has(id) && !completedIds.value.has(id)) removed.add(id);
			}
			externallyRemoved.value = removed;
		},
		{ deep: false }
	);

	/** The id of the card currently in focus (may point past the end when done). */
	const currentId = computed<string | null>(() => orderedIds.value[cursor.value] ?? null);

	/** The current card's live item, falling back to its last-known cached copy. */
	const current = computed<T | null>(() => {
		const id = currentId.value;
		if (id === null) return null;
		return itemsById.value.get(id) ?? itemCache.get(id) ?? null;
	});

	/** The next still-actionable card after the current one (the muted peek). */
	const nextItem = computed<T | null>(() => {
		for (let i = cursor.value + 1; i < orderedIds.value.length; i++) {
			const id = orderedIds.value[i]!;
			if (externallyRemoved.value.has(id)) continue;
			return itemsById.value.get(id) ?? itemCache.get(id) ?? null;
		}
		return null;
	});

	const total = computed(() => orderedIds.value.length);
	/** 1-based position; clamped to total for the end state. */
	const position = computed(() => Math.min(cursor.value + 1, Math.max(total.value, 1)));
	const isComplete = computed(() => active.value && cursor.value >= orderedIds.value.length);

	/** Count of pending items that arrived AFTER the snapshot (the "+n new" hint). */
	const newCount = computed(() => {
		let n = 0;
		for (let i = cursor.value; i < orderedIds.value.length; i++) {
			const id = orderedIds.value[i]!;
			if (!snapshotIds.value.has(id) && !externallyRemoved.value.has(id)) n++;
		}
		return n;
	});

	/** Rough remaining-time budget (seconds) over the still-pending cards. */
	const remainingSeconds = computed(() => {
		const kinds: TaskFlowKind[] = [];
		for (let i = cursor.value; i < orderedIds.value.length; i++) {
			const id = orderedIds.value[i]!;
			if (externallyRemoved.value.has(id)) continue;
			const item = itemsById.value.get(id) ?? itemCache.get(id);
			if (item) kinds.push(keyOf(item).kind);
		}
		return estimateTaskFlowSeconds(kinds);
	});

	const summary = computed(() => summarizeTaskFlow(tallies.value));

	function bumpTally(label: string, delta: number) {
		const next = tallies.value.map((t) => ({ ...t }));
		const existing = next.find((t) => t.label === label);
		if (existing) existing.count += delta;
		else if (delta > 0) next.push({ label, count: delta });
		tallies.value = next.filter((t) => t.count > 0);
	}

	/** Move the cursor forward one card, skipping any that vanished externally. */
	function advance() {
		let next = cursor.value + 1;
		while (next < orderedIds.value.length && externallyRemoved.value.has(orderedIds.value[next]!)) {
			next++;
		}
		cursor.value = next;
	}

	/**
	 * Complete the current card and auto-advance. `outcome` feeds the end-state
	 * summary; `inverse` (if given) is what undo() will run. No-ops unless `id`
	 * is the current card, so a stale click can't advance the wrong task.
	 */
	function complete(id: string, opts: TaskFlowCompleteOptions = {}) {
		if (!active.value || id !== currentId.value) return;
		undoStack.value = [
			...undoStack.value,
			{ id, prevCursor: cursor.value, outcome: opts.outcome, inverse: opts.inverse },
		];
		completedIds.value = new Set(completedIds.value).add(id);
		if (opts.outcome) bumpTally(opts.outcome, 1);
		advance();
	}

	/** Skip the current card forward without recording an outcome or an undo. */
	function skip(id: string) {
		if (!active.value || id !== currentId.value) return;
		advance();
	}

	/**
	 * Reverse the last completion: restore its position and outcome and run its
	 * inverse. Returns true when an undo actually happened.
	 */
	async function undo(): Promise<boolean> {
		const entry = undoStack.value[undoStack.value.length - 1];
		if (!entry) return false;
		undoStack.value = undoStack.value.slice(0, -1);
		cursor.value = entry.prevCursor;
		const restored = new Set(completedIds.value);
		restored.delete(entry.id);
		completedIds.value = restored;
		if (entry.outcome) bumpTally(entry.outcome, -1);
		if (entry.inverse) await entry.inverse();
		return true;
	}

	const canUndo = computed(() => undoStack.value.length > 0);

	/** Leave the flow, preserving cursor/tallies so re-entry can resume. */
	function exit() {
		active.value = false;
	}

	/** Cmd/Ctrl+Z anywhere outside a text field → undo the last action. */
	function onWindowKeydown(event: KeyboardEvent) {
		if (!active.value) return;
		if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
		if (event.key.toLowerCase() !== 'z') return;
		if (isEditableTarget(event.target)) return;
		if (!canUndo.value) return;
		event.preventDefault();
		void undo();
	}

	return {
		active,
		start,
		exit,
		current,
		currentId,
		nextItem,
		position,
		total,
		newCount,
		isComplete,
		remainingSeconds,
		summary,
		tallies,
		canUndo,
		complete,
		skip,
		undo,
		onWindowKeydown,
	};
}
