/**
 * The identity of a piece of evidence (source message, content revision,
 * span) and the dedupe the reducer applies with it. Pure.
 */

import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ReduceEvidence } from './reduceInput';

/** The identity of one piece of evidence (its quote aside). */
export interface EvidenceRef {
	source: InterpretationSource;
	contentRevision: string;
	segmentId: string;
	start: number;
	end: number;
}

/** The identity of a piece of evidence: source, content revision and span. Pure. */
export function evidenceKey(e: EvidenceRef): string {
	return `${interpretationSourceKey(e.source)}|${e.contentRevision}|${e.segmentId}:${e.start}:${e.end}`;
}

/** Evidence of `incoming` (from `source` at `contentRevision`) not already held. */
export function newEvidence(
	existing: readonly EvidenceRef[],
	incoming: readonly ReduceEvidence[],
	source: InterpretationSource,
	contentRevision: string
): ReduceEvidence[] {
	const seen = new Set(existing.map(evidenceKey));
	return incoming.filter((e) => !seen.has(evidenceKey({ ...e, source, contentRevision })));
}
