/**
 * THE LEDGER — entries nothing can start, written down as pre-existing debt.
 * Exact in both directions: a new orphan fails until it is registered, called
 * or deleted; a listed entry that gains a caller or is deleted fails until its
 * line comes off. Empty, and the empty state is the point (issue #528).
 * `check-entry-wiring.ts` holds it exact; kept in its own file so a lane that
 * wires an entry edits data, not the walk.
 */
export const UNREACHED_ENTRIES: readonly string[] = [
	// Thread brief: wired by the wiring and web lanes, which delete each line (none may survive).
	'mail/interpret/scope.ts#loadSourceForScope',
	// ADR-0060 §9 hosted-decision opt-out (decisions lane): the web lane's
	// mailbox and Team Inbox toggles call it and delete this line.
	'decision/exclusion.ts#setHostedDecisionExclusion',
];
