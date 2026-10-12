/**
 * Header evidence for inbound mail, read once and shared (AI routing plan,
 * gap L2).
 *
 * Several consumers decide "is this machine-generated / bulk mail?", and each
 * used to read the headers its own way. This module is where the headers are
 * read. Each consumer keeps its own predicate, written here next to the others,
 * so the differences between them are visible in one place instead of being
 * spread across the codebase. No predicate here changed its outcome when it
 * moved; `__tests__/mailEvidence.test.ts` runs the previous implementations
 * side by side with these over a header matrix and the eval corpus.
 *
 * The intentional differences, by consumer:
 *
 *   - Loop suppression ({@link isLoopSuppressedMail}): Team Inbox ingest, the
 *     Postbox forwarding and vacation hooks, and live Postbox knowledge
 *     extraction. RFC 3834: Auto-Submitted other than `no`, any List-Id,
 *     Precedence `bulk|list|junk`, and our own `X-Owlat-Forwarded`. Raw
 *     values: a whitespace-only Auto-Submitted or List-Id counts.
 *   - Reply candidacy ({@link isMachineGeneratedForReply},
 *     {@link isBulkPrecedenceForReply}): trimmed values, so a blank header
 *     does not count. `X-Owlat-Forwarded` deliberately does NOT count: a
 *     person's mail forwarded by another Owlat mailbox can still want a reply.
 *     Precedence also takes `auto_reply`.
 *   - Smart-inbox category ({@link isBulkPrecedenceForCategory}): Precedence
 *     `bulk|list` only; List-Id and Auto-Submitted are not read.
 *   - Interpretation eligibility ({@link isBulkHeaderForInterpretation}):
 *     List-Unsubscribe, List-Id, or a Precedence that STARTS with
 *     `bulk|list|junk`. Postbox reads a non-empty List-Id, Team Inbox any
 *     List-Id header at all (`listIdRule`).
 *   - Attachment capture ({@link isAutomatedForAttachments}, used only behind
 *     the `attachmentGates` routing switch).
 *
 * Address book, screener and prior-correspondence evidence for Postbox mail
 * is in `mail/senderEvidence.ts`.
 *
 * Pure and isolate-safe: imported from v8 mutations and Node actions alike.
 */

/** The header values the evidence carries, raw (untrimmed, original case). */
export interface HeaderEvidence {
	/** RFC 3834 Auto-Submitted. */
	autoSubmitted?: string;
	/** RFC 2919 List-Id. */
	listId?: string;
	/** RFC 2076 Precedence. */
	precedence?: string;
	/** Set by an Owlat mailbox that forwarded the message. */
	owlatForwarded?: string;
	/**
	 * RFC 2369 List-Unsubscribe. Postbox reads it from the parsed target stored
	 * on the row (`mailMessages.unsubscribe`), Team Inbox from the stored
	 * header, so the caller says which.
	 */
	hasListUnsubscribe: boolean;
}

/** An empty evidence: no header known. */
export const NO_HEADER_EVIDENCE: HeaderEvidence = { hasListUnsubscribe: false };

/**
 * Evidence from a header map whose keys may be in any case. Keys are
 * lowercased with the last occurrence winning, which is how the loop check
 * has always read a map.
 */
export function headerEvidenceFromMap(
	headers: Record<string, string>,
	opts: { hasListUnsubscribe?: boolean } = {}
): HeaderEvidence {
	const h: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) h[key.toLowerCase()] = value;
	return {
		...(h['auto-submitted'] !== undefined ? { autoSubmitted: h['auto-submitted'] } : {}),
		...(h['list-id'] !== undefined ? { listId: h['list-id'] } : {}),
		...(h['precedence'] !== undefined ? { precedence: h['precedence'] } : {}),
		...(h['x-owlat-forwarded'] !== undefined ? { owlatForwarded: h['x-owlat-forwarded'] } : {}),
		hasListUnsubscribe: opts.hasListUnsubscribe ?? h['list-unsubscribe'] !== undefined,
	};
}

/** Evidence from the individual ingest-time values (the Postbox classify arguments). */
export function headerEvidenceOf(fields: {
	autoSubmitted?: string;
	listId?: string;
	precedence?: string;
	hasListUnsubscribe?: boolean;
}): HeaderEvidence {
	return {
		...(fields.autoSubmitted !== undefined ? { autoSubmitted: fields.autoSubmitted } : {}),
		...(fields.listId !== undefined ? { listId: fields.listId } : {}),
		...(fields.precedence !== undefined ? { precedence: fields.precedence } : {}),
		hasListUnsubscribe: fields.hasListUnsubscribe ?? false,
	};
}

/**
 * One header from a Team Inbox row's stored `headers` JSON: an array of
 * `[name, value]` or `{ key, value }` pairs, or an object (an array value reads
 * its first element). The first match wins; unparseable JSON reads as absent.
 */
export function storedHeaderValue(
	headersJson: string | undefined,
	name: string
): string | undefined {
	if (!headersJson) return undefined;
	try {
		const parsed: unknown = JSON.parse(headersJson);
		const lower = name.toLowerCase();
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (Array.isArray(entry) && String(entry[0]).toLowerCase() === lower) {
					return String(entry[1]);
				}
				if (entry && typeof entry === 'object' && 'key' in entry && 'value' in entry) {
					const pair = entry as { key: unknown; value: unknown };
					if (String(pair.key).toLowerCase() === lower) return String(pair.value);
				}
			}
			return undefined;
		}
		if (parsed && typeof parsed === 'object') {
			for (const [key, value] of Object.entries(parsed)) {
				if (key.toLowerCase() === lower)
					return Array.isArray(value) ? String(value[0]) : String(value);
			}
		}
	} catch {
		// Unparseable headers read as absent.
	}
	return undefined;
}

/** Evidence from a Team Inbox row's stored `headers` JSON (see {@link storedHeaderValue}). */
export function headerEvidenceFromStoredJson(headersJson: string | undefined): HeaderEvidence {
	const read = (name: string) => storedHeaderValue(headersJson, name);
	const autoSubmitted = read('auto-submitted');
	const listId = read('list-id');
	const precedence = read('precedence');
	const owlatForwarded = read('x-owlat-forwarded');
	return {
		...(autoSubmitted !== undefined ? { autoSubmitted } : {}),
		...(listId !== undefined ? { listId } : {}),
		...(precedence !== undefined ? { precedence } : {}),
		...(owlatForwarded !== undefined ? { owlatForwarded } : {}),
		hasListUnsubscribe: read('list-unsubscribe') !== undefined,
	};
}

const lowerTrim = (value: string | undefined) => value?.trim().toLowerCase();

// ── Loop suppression ───────────────────────────────────────────────────────

const LOOP_PRECEDENCE: ReadonlySet<string> = new Set(['bulk', 'list', 'junk']);

/**
 * RFC 3834 anti-loop / bulk-mail check: the message must not set off another
 * machine reply (an auto-reply, a forward, a Team Inbox agent run) or feed live
 * Postbox knowledge extraction.
 */
export function isLoopSuppressedMail(e: HeaderEvidence): boolean {
	if (e.autoSubmitted && lowerTrim(e.autoSubmitted) !== 'no') return true;
	if (e.listId) return true;
	const precedence = lowerTrim(e.precedence);
	if (precedence && LOOP_PRECEDENCE.has(precedence)) return true;
	return !!e.owlatForwarded;
}

// ── Reply candidacy (mail/needsReplyHeuristic.ts) ──────────────────────────

const REPLY_BULK_PRECEDENCE: ReadonlySet<string> = new Set(['bulk', 'list', 'junk', 'auto_reply']);

/** The Reply Queue's "a machine sent this" header check (not `X-Owlat-Forwarded`). */
export function isMachineGeneratedForReply(
	e: Pick<HeaderEvidence, 'autoSubmitted' | 'listId'>
): boolean {
	const autoSubmitted = lowerTrim(e.autoSubmitted);
	// RFC 3834 §5: `auto-generated`, `auto-replied`, … — only `no` means a person.
	if (autoSubmitted && autoSubmitted !== 'no') return true;
	return (e.listId?.trim().length ?? 0) > 0;
}

/** The Reply Queue's bulk Precedence values (RFC 2076 §3.9 plus `auto_reply`). */
export function isBulkPrecedenceForReply(e: Pick<HeaderEvidence, 'precedence'>): boolean {
	const precedence = lowerTrim(e.precedence);
	return !!precedence && REPLY_BULK_PRECEDENCE.has(precedence);
}

// ── Smart-inbox category (mail/category.ts) ────────────────────────────────

/** Precedence values the category heuristic reads as broadcast mail. */
export function isBulkPrecedenceForCategory(e: Pick<HeaderEvidence, 'precedence'>): boolean {
	const precedence = lowerTrim(e.precedence);
	return precedence === 'bulk' || precedence === 'list';
}

// ── Interpretation eligibility (mail/interpret/eligibility.ts) ─────────────

/** Precedence that starts with `bulk`, `list` or `junk`. */
function startsWithBulkPrecedence(precedence: string | undefined): boolean {
	return !!precedence && /^\s*(?:bulk|list|junk)\b/i.test(precedence);
}

/**
 * The bulk-header half of the interpretation bulk rule. `listIdRule`:
 * `non_empty` for Postbox (the value parsed off the wire), `present` for Team
 * Inbox (any stored List-Id header, even an empty one).
 */
export function isBulkHeaderForInterpretation(
	e: Pick<HeaderEvidence, 'listId' | 'precedence' | 'hasListUnsubscribe'>,
	listIdRule: 'non_empty' | 'present'
): boolean {
	const hasListId = listIdRule === 'present' ? e.listId !== undefined : !!e.listId;
	return e.hasListUnsubscribe || hasListId || startsWithBulkPrecedence(e.precedence);
}

// ── Attachment capture (L6, behind `attachmentGates`) ──────────────────────

/**
 * Mail whose attachments the `attachmentGates` switch keeps out of the file
 * library: the loop-suppression headers, plus List-Unsubscribe (newsletters),
 * WITHOUT `X-Owlat-Forwarded`: a person's attachment forwarded by another
 * Owlat mailbox is still a person's attachment.
 */
export function isAutomatedForAttachments(e: HeaderEvidence): boolean {
	return isLoopSuppressedMail({ ...e, owlatForwarded: undefined }) || e.hasListUnsubscribe;
}
