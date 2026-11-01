/**
 * THE LEDGER — entries nothing can start, written down as pre-existing debt.
 * Exact in both directions: a new orphan fails until it is registered, called
 * or deleted; a listed entry that gains a caller or is deleted fails until its
 * line comes off. Empty, and the empty state is the point.
 * `check-entry-wiring.ts` holds it exact; kept in its own file so a lane that
 * wires an entry edits data, not the walk.
 */
export const UNREACHED_ENTRIES: readonly string[] = [];
