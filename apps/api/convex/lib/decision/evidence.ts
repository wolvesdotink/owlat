/**
 * The evidence builder for the Phase 2 mail bundles (ADR-0073): the one place
 * that turns a message into the bounded state a decision question is asked
 * about. Production (`decisions/teamBundles.ts`, `decisions/postboxBundle.ts`)
 * and the decision eval (`mail/interpret/__eval__/decisionQuestions.ts`) both
 * build their states here, so the calibration report measures exactly the state
 * production sends.
 *
 * The state is the message ALONE: its sender, recipients, header signals,
 * subject and segmented body. No history, no retrieval, no later message and
 * no label. Two reasons. D11 asks triage before retrieval and interpretation,
 * so it can only read the message. And a Team thread's earlier messages may
 * still be waiting for the D13 guard, which would turn a shadow observation
 * into paid guard calls.
 *
 * Redaction follows ADR-0060 §9: the body is interpretation's scoped,
 * segmented text ({@link evidenceSegments}), so quoted history and signatures
 * arrive labelled rather than as the sender's own words, hidden HTML is gone,
 * and the whole body is capped. Attachments never enter a state.
 *
 * Pure and isolate-safe.
 */

import type { SegmentedMessage } from '@owlat/shared/mailSegments';
import type { DecisionState } from '../decisionProviders/types';
import { sha256Hex } from '../aiRouting/routeDigest';

/** Characters of body in a state. Matches the eval's measured bound. */
export const STATE_BODY_CHARS = 4000;

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
}

/**
 * A segmented body as evidence: each segment's kind and text. The body is
 * scoped and segmented by interpretation's own helpers
 * (`mail/interpret/scope.ts` `scopeForInterpretation` and `segmentScoped`), so
 * an encrypted body never becomes evidence, a clearsigned message is read only
 * inside its signed block, and hidden HTML is stripped.
 */
export function evidenceSegments(segmented: SegmentedMessage): EvidenceSegment[] {
	return segmented.segments.map((segment) => ({
		kind: segment.kind,
		text: segmented.canonicalText.slice(segment.start, segment.end),
	}));
}

/** Segments as one text: fresh text as is, everything else under its kind, then capped. */
export function evidenceBody(
	segments: readonly EvidenceSegment[],
	limit: number = STATE_BODY_CHARS
): string {
	return segments
		.map((s) => (s.kind === 'fresh' ? s.text : `[${s.kind}] ${s.text}`))
		.join('\n\n')
		.slice(0, limit);
}

/** The bounded, message-only state every Phase 2 mail bundle is asked about. */
export function decisionMessageState(evidence: DecisionEvidence): DecisionState {
	const own = new Set(evidence.ownAddresses.map((address) => address.toLowerCase()));
	return {
		mailbox: evidence.surface === 'team' ? 'team inbox' : 'personal mailbox',
		from: evidence.from,
		to: [...evidence.to],
		cc: [...evidence.cc],
		addressedToOwner: evidence.to.some((address) => own.has(address.toLowerCase())),
		...(evidence.senderKnown === undefined ? {} : { senderKnown: evidence.senderKnown }),
		bulkHeaders: evidence.bulkHeaders,
		subject: evidence.subject,
		body: evidenceBody(evidence.segments),
	};
}

/**
 * The content hash a decision artifact is keyed by: SHA-256 of the state's
 * JSON. The builder fixes the key order, so equal evidence hashes equally.
 */
export function stateContentHash(state: DecisionState): string {
	return sha256Hex(JSON.stringify(state));
}
