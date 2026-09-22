/**
 * RFC 5322 Message-ID canonicalisation — the single shape every ingest path
 * dedupes on.
 *
 * `mailMessages.rfc822MessageId` is indexed (`by_rfc822_message_id`) and is what
 * decides whether an arriving message is already in a mailbox. Every writer of
 * that column and every reader that asks "do we have this one?" has to agree on
 * the exact string, or the same message dedupes against itself in one path and
 * not in another. It lived as a private copy in both `mail/external/delivery.ts`
 * and `mail/archiveImport.ts`; the backfill's pre-download check
 * (`mail/migrationBackfill.ts:findKnownMessageIds`) is a third reader that MUST
 * match the writers exactly, so the definition is shared rather than copied a
 * third time.
 */

/** Strip RFC 5322 angle brackets from a Message-ID for dedup. */
export function canonicalMessageId(raw: string): string {
	return raw.replace(/[<>]/g, '').trim() || raw;
}
