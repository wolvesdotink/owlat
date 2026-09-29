/**
 * RFC 5322 Message-ID canonicalisation — the single shape every ingest path
 * dedupes on.
 *
 * `mailMessages.rfc822MessageId` is indexed (`by_rfc822_message_id`) and is what
 * decides whether an arriving message is already in a mailbox. Every writer of
 * that column and every reader that asks "do we have this one?" has to agree on
 * the exact string, or the same message dedupes against itself in one path and
 * not in another. The writer is `mail/deliveryPipeline/insert.ts`; the readers
 * are its `findDuplicateInMailbox` (hosted MX, IMAP sync, archive import) and
 * the backfill's pre-download check (`mail/migrationBackfill.ts:findKnownMessageIds`).
 * All of them go through this function, so a change here (say, lowercasing)
 * moves every side at once.
 */

/** Strip RFC 5322 angle brackets from a Message-ID for dedup. */
export function canonicalMessageId(raw: string): string {
	return canonicalOptionalMessageId(raw) ?? raw;
}

/**
 * The same canonical form for an optional header such as `In-Reply-To`: absent,
 * blank or bracket-only input comes back as `undefined` rather than as the raw
 * string, so the column is simply left unset.
 */
export function canonicalOptionalMessageId(raw?: string): string | undefined {
	return raw?.replace(/[<>]/g, '').trim() || undefined;
}
