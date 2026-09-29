/**
 * The mailbox the Postbox can open with while `identity.list` is still loading
 * (plan 2.5). The page used to hold its spinner until that list answered, and
 * only then start the list and message queries.
 *
 * The seed is taken only from `mail.mailbox.queries.accessible`, the viewer's
 * own active mailboxes, which the dashboard shell already subscribes (the
 * sidebar's inbox groups), so it is usually loaded before the Postbox mounts.
 * A persisted choice that is not in that set is NOT trusted: the device-local
 * caches (offline rows, folders, outbox, bodies) are namespaced by mailbox id
 * alone, so rendering under an unverified id could show another account's
 * cached mail on a shared device. Without a verified seed the page waits for
 * `identity.list` exactly as before.
 *
 * The rule matches what `usePostboxMailbox` resolves once `identity.list` has
 * loaded, so the seeded id does not flip: `accessible` holds the active rows of
 * the same set in the same order, and `identity.list` puts the active rows
 * first.
 */
export function seedPostboxMailboxId(input: {
	/** A `?mailbox=` deep link naming the inbox the thread lives in. */
	requested: string | null;
	/** The persisted active-mailbox choice. */
	persisted: string | null;
	/** The `accessible` rows, or undefined while that query loads. */
	accessible: ReadonlyArray<{ mailboxId: string }> | undefined;
}): string | null {
	const rows = input.accessible;
	if (!rows) return null;
	const ids = new Set(rows.map((row) => row.mailboxId));
	// A deep link wins over the persisted choice, as it does once the list has
	// loaded. An id outside the active set is suspended, deleted or not the
	// viewer's: fall back to waiting for `identity.list`, which decides.
	const wanted = input.requested ?? input.persisted;
	if (wanted) return ids.has(wanted) ? wanted : null;
	return rows[0]?.mailboxId ?? null;
}
