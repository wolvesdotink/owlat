/**
 * Send composition (module) — Feedback-ID leaf.
 *
 * Single V8-pure builder for the Gmail Feedback Loop (FBL) `Feedback-ID`
 * header, shared by the campaign and transactional composers. Gmail's
 * Postmaster Tools aggregate spam-complaint data per `Feedback-ID`, giving
 * per-stream / per-campaign FBL granularity instead of the domain-aggregate
 * view exposed by the Postmaster API alone.
 *
 * Google's format (https://support.google.com/mail/answer/6254652) is four
 * colon-separated fields, processed right-to-left:
 *
 *   Feedback-ID: <a>:<b>:<c>:<SenderId>
 *
 * - `a`,`b`,`c` are sender-defined identifiers (campaign / customer / other).
 * - `SenderId` is the mandatory final field and MUST be consistent across the
 *   mail stream for the same sender — it anchors the aggregation. Per-message
 *   identifiers (e.g. a Message-ID) MUST NOT be used, or no useful data is
 *   produced.
 * - The whole header value is kept `<= 127` bytes.
 *
 * Field layout chosen here:
 *
 *   <streamType>:<campaignId-or-empty>:<audienceType-or-empty>:<senderId>
 *
 *   field 1 — stream type token: `campaign` for bulk, `txn` for
 *             transactional / automation sends (distinct streams get distinct
 *             FBL buckets).
 *   field 2 — the `campaignId` for bulk sends (per-campaign granularity);
 *             the `EMPTY_FIELD` placeholder for transactional / automation.
 *   field 3 — the campaign `audienceType` (`topic` / `segment`) when known;
 *             the `EMPTY_FIELD` placeholder otherwise. A stable sub-stream
 *             discriminator, never a per-message value.
 *   field 4 — the SenderId: a stable, short token derived from the
 *             `organizationId` so every message from the same deployment
 *             shares one consistent sender anchor.
 *
 * Gmail tolerates empty `a`/`b`/`c` fields, but a fixed non-empty placeholder
 * keeps every emitted header a clean four-segment value (and keeps the
 * structure greppable).
 *
 * The builder is V8-pure (no `node:crypto`) so the composers stay runnable
 * from the Convex V8 runtime, mirroring the `trackingUrl.ts` leaf.
 */

const MAX_FEEDBACK_ID_BYTES = 127;

// Placeholder for an unused optional identifier field, keeping the header a
// clean four non-empty segments. Colon-free so it never adds a delimiter.
const EMPTY_FIELD = 'none';

/**
 * Stream type token placed in field 1. `campaign` for bulk marketing sends,
 * `txn` for transactional + automation (1:1) sends — distinct streams get
 * distinct FBL aggregation buckets.
 */
export type FeedbackStreamType = 'campaign' | 'txn';

export type BuildFeedbackIdInput = {
	streamType: FeedbackStreamType;
	organizationId: string;
	campaignId?: string;
	audienceType?: 'topic' | 'segment';
};

/**
 * Deterministic, V8-pure 32-bit FNV-1a hash → base36, yielding a stable short
 * token. Used to derive the SenderId from the (potentially long) Convex
 * `organizationId` while satisfying Gmail's 5–15 char SenderId guidance and
 * keeping the value opaque (the raw org id is not leaked into the header).
 *
 * Same input → same output, always — the SenderId stays consistent across the
 * mail stream, which is what FBL aggregation requires.
 */
function stableSenderId(organizationId: string): string {
	let hash = 0x811c9dc5; // FNV offset basis
	for (let i = 0; i < organizationId.length; i++) {
		hash ^= organizationId.charCodeAt(i);
		// FNV prime multiply, kept in 32-bit unsigned space via Math.imul.
		hash = Math.imul(hash, 0x01000193);
	}
	// >>> 0 → unsigned; base36 keeps it compact (max 7 chars for a 32-bit int).
	const token = (hash >>> 0).toString(36);
	// Pad to Gmail's 5-char floor so very small hashes still satisfy the spec.
	return token.length >= 5 ? token : token.padStart(5, '0');
}

/**
 * Build the Gmail FBL `Feedback-ID` header value, or `null` when there is no
 * stable sender anchor (no `organizationId`) — an empty SenderId produces no
 * FBL data, so the header is omitted entirely rather than emitted broken.
 *
 * The optional identifier fields are sanitized (colons stripped — the
 * delimiter — plus surrounding whitespace) and the whole value is capped at
 * 127 bytes to stay within Gmail's limit.
 */
export function buildFeedbackId(input: BuildFeedbackIdInput): string | null {
	const senderId = input.organizationId ? stableSenderId(input.organizationId) : '';
	if (!senderId) {
		return null;
	}

	const sanitize = (value: string | undefined): string => {
		const cleaned = (value ?? '').replace(/:/g, '').trim();
		return cleaned.length > 0 ? cleaned : EMPTY_FIELD;
	};

	const streamType = input.streamType;
	const campaignField = sanitize(input.campaignId);
	const audienceField = sanitize(input.audienceType);

	const value = [streamType, campaignField, audienceField, senderId].join(':');

	// Stay within Gmail's 127-byte cap. The SenderId (field 4) is small and
	// load-bearing, so on overflow we trim only the second field (the
	// campaignId) from the right rather than risk corrupting the anchor.
	if (byteLength(value) <= MAX_FEEDBACK_ID_BYTES) {
		return value;
	}

	const overflow = byteLength(value) - MAX_FEEDBACK_ID_BYTES;
	const sliced = campaignField.slice(0, Math.max(0, campaignField.length - overflow));
	// Never collapse field 2 to empty (it would break the four-segment shape) —
	// fall back to the placeholder if the campaignId trims away entirely.
	const trimmedCampaignId = sliced.length > 0 ? sliced : EMPTY_FIELD;
	const capped = [streamType, trimmedCampaignId, audienceField, senderId].join(':');
	return capped.slice(0, MAX_FEEDBACK_ID_BYTES);
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}
