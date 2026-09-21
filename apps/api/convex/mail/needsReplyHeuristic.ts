/**
 * Deterministic "could this message want a reply from me?" screen — stage 1 of
 * the Reply Queue (see mail/needsReply.ts for the module overview). Pure, so it
 * unit-tests without Convex, and split out of `mail/needsReply.ts` because that
 * file sits at the domain-file size cap (CONVENTIONS.md → "Split only above
 * ~500 LOC").
 *
 * The screen is the cheap half of the two-stage signal: everything it rejects
 * never reaches the LLM refinement pass at all (no spend, no queue row). It is
 * therefore deliberately conservative — it only rejects mail where the REJECTION
 * is the cheap, checkable fact (an RFC 3834 header, an unattended From address),
 * and leaves every judgement call about content to stage 2
 * (mail/ai/replyIntent.ts).
 *
 * Three families of rejection:
 *   • machine-generated headers — Auto-Submitted / List-Id / Precedence.
 *   • unattended senders — a From (or Reply-To) local part that names a mailbox
 *     no human reads: `no-reply@`, `notifications@`, `drive-shares-noreply@`.
 *   • publishing address + informational subject — a sender that PUBLISHES
 *     ("…-notes@", "digest@", "reports@") mailing something whose subject is a
 *     recap ("Notes: 'Tech Jour Fixe'", "Meeting minutes — …"). Neither half is
 *     conclusive alone: a person at `team-notes@` asking "can you review this?"
 *     stays a candidate, and so does a colleague sending "Notes from today".
 */

// ─── Sender-name screens ─────────────────────────────────────────────────────

/**
 * Multi-word markers of an unattended address, matched against the local part
 * with every separator removed — so `drive-shares-noreply`, `no.reply` and
 * `do_not_reply` all land on the same needle.
 */
const UNATTENDED_PHRASES = [
	'noreply',
	'donotreply',
	'dontreply',
	'mailerdaemon',
	'autoreply',
	'autoresponder',
	'autoconfirm',
	'autonotification',
] as const;

/**
 * Single-word local-part tokens that name an unattended mailbox. Matched per
 * token (the local part is split on `.`, `+`, `_` and `-`) so `notifications`,
 * `github+notifications` and `team-alerts` all match while a person whose name
 * merely contains one of them (`replyn@`, `botanist@`) does not.
 */
const UNATTENDED_TOKENS = new Set([
	'noreply',
	'postmaster',
	'mailer',
	'daemon',
	'bounce',
	'bounces',
	'notification',
	'notifications',
	'notify',
	'alert',
	'alerts',
	'newsletter',
	'newsletters',
	'marketing',
	'update',
	'updates',
	'automated',
	'automation',
	'bot',
	'robot',
]);

/**
 * Local-part tokens of an address that PUBLISHES rather than converses. Weaker
 * than {@link UNATTENDED_TOKENS} — a human may well read `reports@` — so these
 * only suppress in combination with an informational subject.
 */
const PUBLISHING_TOKENS = new Set([
	'notes',
	'minutes',
	'digest',
	'digests',
	'summary',
	'summaries',
	'recap',
	'recaps',
	'report',
	'reports',
	'transcript',
	'transcripts',
	'recording',
	'recordings',
	'calendar',
	'feed',
	'news',
	'noreplies',
]);

/**
 * Subjects that announce a record of something that already happened. Anchored
 * at the start (after an optional Re:/Fwd: prefix) and followed by a separator
 * or preposition, so "Notes: 'Tech Jour Fixe'" and "Minutes from Monday" match
 * while "Summary needed — can you send yours?" does not. German variants are
 * included because the Postbox ships de/en.
 */
const INFORMATIONAL_SUBJECT_PREFIX =
	/^\s*(?:(?:re|fwd?|aw|wg)\s*:\s*)*(?:notes|minutes|summary|recap|transcript|recording|digest|changelog|notizen|protokoll|zusammenfassung|mitschrift|wochenbericht)\b\s*(?::|-|–|—|from\b|for\b|of\b|on\b|von\b|zu\b|für\b)/i;

/** Phrases anywhere in the subject that mark a record-of-a-meeting mail. */
const INFORMATIONAL_SUBJECT_PHRASE =
	/\b(meeting notes|notes from|notes for|meeting summary|meeting minutes|meeting recap|besprechungsnotizen|protokoll der)\b/i;

/** Lowercased local part of an address, without the domain. */
function localPartOf(address: string): string {
	return (address.split('@', 1)[0] ?? '').trim().toLowerCase();
}

/** The local part split into separator-delimited tokens (`a.b+c-d` → 4). */
function localPartTokens(localPart: string): string[] {
	return localPart.split(/[.+_\-]/).filter((token) => token.length > 0);
}

/** True when an address names a mailbox no human reads. */
export function isUnattendedAddress(address: string): boolean {
	const localPart = localPartOf(address);
	if (localPart.length === 0) return false;
	const squashed = localPart.replace(/[.+_\-]/g, '');
	if (UNATTENDED_PHRASES.some((phrase) => squashed.includes(phrase))) return true;
	return localPartTokens(localPart).some((token) => UNATTENDED_TOKENS.has(token));
}

/** True when an address looks like a publishing endpoint (weak signal). */
export function isPublishingAddress(address: string): boolean {
	return localPartTokens(localPartOf(address)).some((token) => PUBLISHING_TOKENS.has(token));
}

/**
 * True when a subject announces a record of something that already happened.
 *
 * A question mark disqualifies it outright: "Report: Q3 numbers — can you
 * confirm?" is someone asking, whatever noun they opened with, and this screen
 * skips the LLM entirely, so it gets the benefit of the doubt.
 */
export function isInformationalSubject(subject: string | undefined): boolean {
	const value = subject?.trim();
	if (!value) return false;
	if (value.includes('?')) return false;
	return INFORMATIONAL_SUBJECT_PREFIX.test(value) || INFORMATIONAL_SUBJECT_PHRASE.test(value);
}

// ─── Header screens ──────────────────────────────────────────────────────────

/** Precedence header values that mark bulk/automated mail (RFC 2076 §3.9). */
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk', 'auto_reply']);

/** Ingest-time headers of the triggering message — none are persisted on the row. */
export interface NeedsReplyHeaders {
	/** RFC 3834 Auto-Submitted; anything but `no` means machine-generated. */
	autoSubmitted?: string;
	/** RFC 2919 List-Id; its presence means mailing-list traffic. */
	listId?: string;
	/** RFC 2076 Precedence. */
	precedence?: string;
}

/**
 * True when the message headers say a machine generated this mail.
 *
 * Deliberately NOT `lib/inboundClassification.isAutomatedMail`: that helper also
 * counts `X-Owlat-Forwarded`, which is right for auto-reply loop prevention but
 * wrong here — a human's message forwarded by another Owlat mailbox still wants
 * a reply. Precedence keeps living in {@link isBulkOrNoReplySender} so the
 * existing `bulk_sender` verdict is unchanged.
 */
export function isAutomatedByHeaders(headers: NeedsReplyHeaders): boolean {
	const autoSubmitted = headers.autoSubmitted?.trim().toLowerCase();
	// RFC 3834 §5: `auto-generated`, `auto-replied`, `auto-notified`, … — only
	// the explicit `no` means a human pressed send.
	if (autoSubmitted && autoSubmitted !== 'no') return true;
	return (headers.listId?.trim().length ?? 0) > 0;
}

/** True when the sender looks like bulk/no-reply mail nobody should answer. */
export function isBulkOrNoReplySender(msg: {
	fromAddress: string;
	hasListUnsubscribe: boolean;
	/** Raw Precedence header value, only known at ingest time. */
	precedence?: string;
	/** Reply-To of the message, when it carries one. */
	replyToAddress?: string;
}): boolean {
	if (msg.hasListUnsubscribe) return true;
	const precedence = msg.precedence?.trim().toLowerCase();
	if (precedence && BULK_PRECEDENCE.has(precedence)) return true;
	// A Reply-To pointing at an unattended mailbox is the sender telling us
	// outright that answers go nowhere — it outranks a friendly From address.
	if (msg.replyToAddress && isUnattendedAddress(msg.replyToAddress)) return true;
	return isUnattendedAddress(msg.fromAddress);
}

// ─── The candidate screen ────────────────────────────────────────────────────

export interface NeedsReplyMessageInput {
	fromAddress: string;
	toAddresses: string[];
	ccAddresses: string[];
	/** A List-Unsubscribe target was parsed at ingest (bulk/list mail). */
	hasListUnsubscribe: boolean;
	/** Sent by the mailbox owner (outbound / self-sent). */
	isFromOwner: boolean;
	receivedAt: number;
	/** Subject line — read by the publishing-address screen. */
	subject?: string;
	/** Reply-To address, when the message carries one. */
	replyToAddress?: string;
}

type NeedsReplyEvaluation =
	| { candidate: true; latestInboundIndex: number }
	| {
			candidate: false;
			reason: 'no_inbound' | 'owner_replied' | 'bulk_sender' | 'automated' | 'not_in_to';
	  };

/**
 * Deterministic "needs a reply from me" candidate check over a thread's
 * messages (any order). Pure so it unit-tests without Convex.
 *
 * The headers apply to the latest inbound message only — they are not persisted
 * on the row, so they are available at ingest but not on re-sweeps. A sweep that
 * loses them falls back to the sender/subject screens, which is why those exist
 * rather than trusting `Auto-Submitted` alone.
 */
export function evaluateNeedsReplyCandidate(
	opts: {
		/** Lowercased addresses that count as "me" (mailbox address). */
		ownerAddresses: string[];
		messages: NeedsReplyMessageInput[];
	} & NeedsReplyHeaders
): NeedsReplyEvaluation {
	const owners = new Set(opts.ownerAddresses.map((a) => a.toLowerCase()));
	const ordered = opts.messages
		.map((m, index) => ({ m, index }))
		.sort((a, b) => a.m.receivedAt - b.m.receivedAt);

	let latestInbound: { m: NeedsReplyMessageInput; index: number } | undefined;
	for (const entry of ordered) {
		if (!entry.m.isFromOwner && !owners.has(entry.m.fromAddress.toLowerCase())) {
			latestInbound = entry;
		}
	}
	if (!latestInbound) return { candidate: false, reason: 'no_inbound' };

	// Owner sent a later message → already replied (or moved on).
	const ownerRepliedAfter = ordered.some(
		(e) =>
			(e.m.isFromOwner || owners.has(e.m.fromAddress.toLowerCase())) &&
			e.m.receivedAt >= latestInbound.m.receivedAt
	);
	if (ownerRepliedAfter) return { candidate: false, reason: 'owner_replied' };

	// RFC 3834 / list traffic: the message says outright that a machine sent it.
	if (isAutomatedByHeaders(opts)) return { candidate: false, reason: 'automated' };

	if (
		isBulkOrNoReplySender({
			fromAddress: latestInbound.m.fromAddress,
			hasListUnsubscribe: latestInbound.m.hasListUnsubscribe,
			precedence: opts.precedence,
			replyToAddress: latestInbound.m.replyToAddress,
		})
	) {
		return { candidate: false, reason: 'bulk_sender' };
	}

	// A publishing address mailing a record of a past meeting: the combination
	// is the signal (see the module header for why neither half suffices).
	if (
		isPublishingAddress(latestInbound.m.fromAddress) &&
		isInformationalSubject(latestInbound.m.subject)
	) {
		return { candidate: false, reason: 'automated' };
	}

	// Addressed to me directly (To), not only Cc'd.
	const inTo = latestInbound.m.toAddresses.some((a) => owners.has(a.toLowerCase()));
	if (!inTo) return { candidate: false, reason: 'not_in_to' };

	return { candidate: true, latestInboundIndex: latestInbound.index };
}
