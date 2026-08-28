/**
 * The bounded LIFO stack behind the Postbox's "Undo" (Cmd/Ctrl+Z).
 *
 * Triage used to keep exactly ONE undoable action: archiving three messages in
 * a row left only the third reversible, and the second Cmd+Z did nothing. This
 * is the same registry generalised to a stack — newest first, capped at
 * {@link POSTBOX_UNDO_STACK_LIMIT} entries, each with its own deadline, so a
 * burst of triage can be walked back in the order it happened.
 *
 * Pure: entries carry only ids and timestamps here, and the composable keeps
 * the callbacks (and the toasts) beside them. That way the whole eviction /
 * expiry contract is unit-testable without a DOM or a Convex client.
 */

/**
 * How many actions stay undoable at once. Ten is generous for a triage burst
 * and small enough that the oldest entry is still something the user remembers
 * doing; past it, the oldest is evicted rather than the newest refused.
 */
export const POSTBOX_UNDO_STACK_LIMIT = 10;

/** The serializable half of an undo entry (the callback lives elsewhere). */
export interface PostboxUndoEntry {
	/** Stable key the composable maps back to the inverse callback + toast. */
	id: string;
	/** Absolute deadline; a Cmd+Z after this is ignored even if a timer lags. */
	expiresAt: number;
}

/**
 * Push a newest-first entry, dropping whatever no longer fits: entries whose
 * deadline has passed, then — only if the stack is still full — the oldest.
 * Returns the evicted entries so the caller can drop their toasts and
 * callbacks in the same step (an entry that leaves the stack must leave every
 * side table with it, or a stale closure outlives its toast).
 */
export function pushUndoEntry<E extends PostboxUndoEntry>(
	stack: readonly E[],
	entry: E,
	now: number,
	limit: number = POSTBOX_UNDO_STACK_LIMIT
): { stack: E[]; evicted: E[] } {
	const live: E[] = [];
	const evicted: E[] = [];
	for (const e of stack) {
		if (e.expiresAt > now) live.push(e);
		else evicted.push(e);
	}
	const next = [entry, ...live];
	// A limit of 0 or less means "nothing is undoable" — honour it literally
	// rather than always keeping the entry just pushed.
	const keep = Math.max(0, limit);
	while (next.length > keep) {
		const dropped = next.pop();
		if (dropped) evicted.push(dropped);
	}
	return { stack: next, evicted };
}

/**
 * Drop every entry past its deadline. Called on a timer tick and before any
 * read, so an expired entry is never handed out even if its timer never fired
 * (a backgrounded tab throttles timers; the deadline does not move).
 */
export function pruneUndoStack<E extends PostboxUndoEntry>(
	stack: readonly E[],
	now: number
): { stack: E[]; expired: E[] } {
	const live: E[] = [];
	const expired: E[] = [];
	for (const e of stack) {
		if (e.expiresAt > now) live.push(e);
		else expired.push(e);
	}
	return { stack: live, expired };
}

/**
 * Take the newest still-live entry (LIFO). Entries that expired while sitting
 * in the stack come back as `expired` so the caller cleans up after them
 * instead of reversing an action the user has stopped expecting to reverse.
 */
export function popUndoEntry<E extends PostboxUndoEntry>(
	stack: readonly E[],
	now: number
): { stack: E[]; entry: E | null; expired: E[] } {
	const pruned = pruneUndoStack(stack, now);
	const [entry, ...rest] = pruned.stack;
	return {
		stack: entry ? rest : [],
		entry: entry ?? null,
		expired: pruned.expired,
	};
}
