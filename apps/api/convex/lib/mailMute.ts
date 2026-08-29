/**
 * A conversation is "muted" while `mailThreads.mutedAt` is set: new inbound
 * mail on it skips the Inbox, it never fires a desktop notification, and it is
 * excluded from the Reply Queue.
 *
 * The predicate lives here — beside `mailSnooze.ts`, and NOT in `mail/mute.ts`
 * where the verb itself lives — because `mail/mute.ts` imports
 * `mail/needsReply.ts` (to clear the queue flag on mute) and `needsReply.ts`
 * needs the predicate back. A leaf module both can import keeps that from being
 * an import cycle.
 */
export function isThreadMuted(thread: { mutedAt?: number | null } | null | undefined): boolean {
	return thread?.mutedAt != null;
}
