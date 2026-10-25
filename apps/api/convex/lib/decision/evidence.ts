/**
 * The evidence builder for the Phase 2 mail bundles: the one place
 * that turns a message into the bounded state a decision question is asked
 * about. Production (`decisions/teamBundles.ts`, `decisions/postboxBundle.ts`)
 * and the decision eval (`mail/interpret/__eval__/decisionQuestions.ts`) both
 * build their states here, so the calibration report measures exactly the state
 * production sends.
 *
 * The state is the message ALONE: its sender, recipients, header signals,
 * subject and segmented body. No history, no retrieval, no later message and
 * no label. Two reasons. Triage runs before retrieval and interpretation,
 * so it can only read the message. And a Team thread's earlier messages may
 * still be waiting for the injection guard, which would turn a shadow observation
 * into paid guard calls.
 *
 * Redaction:
 * - the body is interpretation's scoped, segmented text
 *   ({@link evidenceSegments}): HTML reduced to visible text with the
 *   injection scan's hidden-content strip, a clearsigned message read inside
 *   its signed block, an encrypted body never read;
 * - quoted history, signatures and disclaimers are removed
 *   ({@link REDACTED_SEGMENT_KINDS});
 * - attachments never enter a state (no field carries them);
 * - the whole state is capped ({@link STATE_MAX_CHARS}), metadata field by
 *   field and the body keeping its head and tail.
 *
 * Pure and isolate-safe.
 */

import type { SegmentedMessage } from '@owlat/shared/mailSegments';
import type { DecisionState } from '../decisionProviders/types';
import { sha256Hex } from '../aiRouting/routeDigest';

/**
 * The redaction budget. The whole state stays within
 * {@link STATE_MAX_CHARS} of JSON: metadata is capped field by field, and the
 * body gets what is left, at most {@link STATE_BODY_CHARS}, head and tail kept.
 */
export const STATE_MAX_CHARS = 6000;
export const STATE_BODY_CHARS = 4000;
export const STATE_SUBJECT_CHARS = 300;
export const STATE_ADDRESS_CHARS = 254;
export const STATE_ADDRESSES = 5;
/** Between the kept head and tail of a cut text. */
export const CUT_MARKER = '\n[…]\n';

/** Segment kinds a state never carries: earlier mail, signatures, legal footers. */
export const REDACTED_SEGMENT_KINDS: ReadonlySet<string> = new Set([
	'quoted',
	'signature',
	'disclaimer',
]);

export type DecisionSurface = 'team' | 'postbox';

/** One segment of a message body, as `@owlat/shared/mailSegments` cuts it. */
export interface EvidenceSegment {
	readonly kind: string;
	readonly text: string;
}

export interface DecisionEvidence {
	readonly surface: DecisionSurface;
	readonly from: string;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	/** The mailbox's own addresses, lowercased: is the message addressed to the owner? */
	readonly ownAddresses: readonly string[];
	readonly subject: string;
	readonly segments: readonly EvidenceSegment[];
	/** List-Unsubscribe present, or `Precedence: bulk|list`. */
	readonly bulkHeaders: boolean;
	/**
	 * Whether the owner already corresponds with the sender. Absent where the
	 * surface has no honest answer (the Team Inbox creates a contact for every
	 * sender), and then left out of the state rather than guessed.
	 */
	readonly senderKnown?: boolean;
	/**
	 * Whether scoping read the whole message: nothing omitted (an unavailable
	 * body, text outside a signed block) and the HTML within the scanner's cap.
	 * An incomplete message is never an exact sender-memory match.
	 */
	readonly isScopeComplete: boolean;
}

/**
 * A segmented body as evidence: each segment's kind and text. The body is
 * scoped and segmented by interpretation's own helpers
 * (`mail/interpret/scopeLoad.ts` `scopeForInterpretation` and
 * `mail/interpret/scope.ts` `segmentScoped`), so
 * an encrypted body never becomes evidence, a clearsigned message is read only
 * inside its signed block, and hidden HTML is stripped.
 */
export function evidenceSegments(segmented: SegmentedMessage): EvidenceSegment[] {
	return segmented.segments.map((segment) => ({
		kind: segment.kind,
		text: segmented.canonicalText.slice(segment.start, segment.end),
	}));
}

/** `text` within `max` characters: unchanged, or its head and tail around {@link CUT_MARKER}. */
export function capHeadTail(text: string, max: number): { text: string; isCut: boolean } {
	if (text.length <= max) return { text, isCut: false };
	if (max <= CUT_MARKER.length) return { text: text.slice(0, Math.max(0, max)), isCut: true };
	const room = max - CUT_MARKER.length;
	const head = Math.ceil((room * 2) / 3);
	const tail = room - head;
	return {
		text: `${text.slice(0, head)}${CUT_MARKER}${text.slice(text.length - tail)}`,
		isCut: true,
	};
}

/**
 * The body a state carries: the sender's own text and anything they forwarded
 * (labelled), never quoted history, signatures or disclaimers.
 */
export function redactedBody(segments: readonly EvidenceSegment[]): string {
	return segments
		.filter((segment) => !REDACTED_SEGMENT_KINDS.has(segment.kind))
		.map((segment) =>
			segment.kind === 'fresh' ? segment.text : `[${segment.kind}] ${segment.text}`
		)
		.join('\n\n');
}

function capAddresses(addresses: readonly string[]): { list: string[]; isCut: boolean } {
	const list = addresses
		.slice(0, STATE_ADDRESSES)
		.map((address) => address.slice(0, STATE_ADDRESS_CHARS));
	const isCut =
		addresses.length > STATE_ADDRESSES ||
		addresses.some((address) => address.length > STATE_ADDRESS_CHARS);
	return { list, isCut };
}

/** A state, whether it carries the whole redacted message, and the message's fingerprint. */
export interface BuiltDecisionState {
	readonly state: DecisionState;
	/** Nothing was cut and scoping read the whole message. */
	readonly isComplete: boolean;
	/**
	 * SHA-256 over every input of the state, uncut: the complete scoped message
	 * (every segment) and all its metadata. The sender-memory exact-match key:
	 * two messages that agree on their first 4,000 characters and differ after
	 * them, or differ in any metadata the model reads, never share it.
	 */
	readonly contentFingerprint: string;
}

/** The bounded, redacted, message-only state every Phase 2 mail bundle is asked about. */
export function buildDecisionState(evidence: DecisionEvidence): BuiltDecisionState {
	const own = new Set(evidence.ownAddresses.map((address) => address.toLowerCase()));
	const from = capHeadTail(evidence.from, STATE_ADDRESS_CHARS);
	const to = capAddresses(evidence.to);
	const cc = capAddresses(evidence.cc);
	const subject = capHeadTail(evidence.subject, STATE_SUBJECT_CHARS);
	const metadata = {
		mailbox: evidence.surface === 'team' ? 'team inbox' : 'personal mailbox',
		from: from.text,
		to: to.list,
		cc: cc.list,
		addressedToOwner: evidence.to.some((address) => own.has(address.toLowerCase())),
		...(evidence.senderKnown === undefined ? {} : { senderKnown: evidence.senderKnown }),
		bulkHeaders: evidence.bulkHeaders,
		subject: subject.text,
	};
	const room = STATE_MAX_CHARS - JSON.stringify({ ...metadata, body: '' }).length;
	// JSON escapes can lengthen the body; shrink until the whole state fits.
	let budget = Math.min(STATE_BODY_CHARS, Math.max(0, room));
	let body = capHeadTail(redactedBody(evidence.segments), budget);
	let state = { ...metadata, body: body.text };
	while (JSON.stringify(state).length > STATE_MAX_CHARS && budget > 0) {
		budget = Math.max(0, budget - Math.max(64, JSON.stringify(state).length - STATE_MAX_CHARS));
		body = capHeadTail(redactedBody(evidence.segments), budget);
		state = { ...metadata, body: body.text };
	}
	// Only metadata full of characters JSON escapes can still be over: then the
	// recipient lists go and the subject shrinks, which always fits.
	const isOversize = JSON.stringify(state).length > STATE_MAX_CHARS;
	if (isOversize) {
		state = {
			...metadata,
			to: [],
			cc: [],
			subject: capHeadTail(evidence.subject, 64).text,
			body: '',
		};
	}
	const isCut = isOversize || from.isCut || to.isCut || cc.isCut || subject.isCut || body.isCut;
	return {
		state,
		isComplete: evidence.isScopeComplete && !isCut,
		// Every value the state is built from, uncut: the metadata a model reads
		// (surface, addressing, bulk headers, sender familiarity) and the whole
		// scoped body, so two messages share a fingerprint only when every input
		// to their states is identical.
		contentFingerprint: sha256Hex(
			JSON.stringify([
				metadata.mailbox,
				evidence.from,
				evidence.to,
				evidence.cc,
				metadata.addressedToOwner,
				evidence.senderKnown ?? null,
				evidence.bulkHeaders,
				evidence.subject,
				evidence.segments.map((segment) => [segment.kind, segment.text]),
			])
		),
	};
}

/**
 * The content hash a decision artifact is keyed by: SHA-256 of the state's
 * JSON. The builder fixes the key order, so equal evidence hashes equally.
 */
export function stateContentHash(state: DecisionState): string {
	return sha256Hex(JSON.stringify(state));
}
