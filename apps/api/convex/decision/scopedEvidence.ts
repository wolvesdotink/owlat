/**
 * A scoped message's body as decision evidence: segmented by
 * interpretation's own `segmentScoped` (hidden HTML stripped, the HTML body
 * read as HTML), and marked incomplete whenever scoping or segmentation could
 * not vouch for the whole message: something omitted (text outside a signed
 * block, an unavailable body), HTML past the scanner's cap, or an uncertain
 * segmentation, which includes a text alternative at odds with the HTML. An
 * incomplete message is never an exact sender-memory match. Pure.
 */

import { segmentScoped, type ScopedMessage } from '../mail/interpret/scope';
import { evidenceSegments, type EvidenceSegment } from '../lib/decision/evidence';

export function scopedEvidence(scoped: Extract<ScopedMessage, { ok: true }>): {
	segments: EvidenceSegment[];
	isScopeComplete: boolean;
} {
	const segmentation = segmentScoped(scoped);
	return {
		segments: evidenceSegments(segmentation.segmented),
		isScopeComplete:
			scoped.omitted.length === 0 && !segmentation.isTruncated && !segmentation.segmented.uncertain,
	};
}
