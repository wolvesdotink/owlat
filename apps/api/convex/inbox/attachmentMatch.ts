/**
 * Attachment-suggestion matcher (pure).
 *
 * "See attached" / "can you send me the …" is one of the highest-friction reply
 * shapes for the agent: the draft can write the words but has no way to propose
 * the actual FILE, so the owner has to leave the draft to go dig it out — which
 * caps the road to a zero-edit send. This module owns the two deterministic,
 * model-free halves of closing that gap:
 *
 *   1. `detectAttachmentRequest` — does the inbound actually ask for a document
 *      to be sent back ("can you send X", "please forward the …", "see attached
 *      / attached is")? A cheap regex gate so we only pay for a file search when
 *      an attachment is genuinely in play.
 *   2. `pickAttachmentSuggestion` — given the contact-scoped `semanticFiles`
 *      matches (already RRF-rank-ordered, best first — see
 *      `semanticFileProcessing.semanticSearch`), decide between a single
 *      confident one-tap suggestion and a genuinely AMBIGUOUS choice that should
 *      be handed to the clarify loop instead of guessed at.
 *
 * Pure (no 'use node', no Convex ctx) so it imports cleanly into BOTH the
 * inbound `clarify` step (which asks when the choice is ambiguous) and the
 * `draft` step (which surfaces the single confident suggestion), and unit-tests
 * without a live model or database. The autonomous send path never consumes any
 * of this — attachment suggestions are HUMAN-CONFIRMED only (recipient-lock
 * forbids a new attachment on an unattended reply).
 */

/** A single candidate file the draft could propose attaching. */
export interface AttachmentCandidate {
	fileId: string;
	filename: string;
	title?: string | undefined;
	/** Fusion score from the file search (best first); advisory only. */
	score: number;
}

/** Outcome of ranking the contact-scoped file matches. Generic over the
 * candidate shape so callers keep the extra fields (storageId, mimeType, …) they
 * need to persist / attach — the ranker only reads `score`. */
export interface AttachmentSuggestionResult<T extends AttachmentCandidate = AttachmentCandidate> {
	/** The proposed file(s). One entry when we are confident; the shortlist when
	 * the choice is ambiguous. Empty when nothing matched. */
	candidates: T[];
	/** True when there is more than one comparable match and no clear winner —
	 * the caller should ASK (clarify loop) rather than guess. */
	ambiguous: boolean;
}

/** Minimum fusion score for the top hit to count as a *confident* single
 * suggestion. Below this, a runner-up of similar strength makes it ambiguous. */
export const MATCH_FLOOR = 0.3;
/** How far ahead the top hit must be to be treated as the clear winner. */
export const AMBIGUITY_MARGIN = 0.15;
/** Hard cap on how many candidates we ever surface / ask about. */
export const MAX_CANDIDATES = 4;

// ─── Request detection ───────────────────────────────────────────────────────

/**
 * Verb-led phrasings that signal the SENDER expects a document sent back, plus
 * the "see attached / attached is" reference to an attachment. Each capture
 * group grabs the rough object phrase so we can seed the file search with it.
 * Case-insensitive; anchored on a verb so ordinary prose ("I already sent the
 * report last week") is far less likely to trip it.
 */
const REQUEST_PATTERNS: RegExp[] = [
	/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:send|forward|share|attach|resend)\s+(?:me\s+|us\s+|over\s+|through\s+)?(?:the\s+|a\s+|an\s+|your\s+|our\s+)?([^.?!\n]{2,80})/i,
	/\b(?:please|kindly)\s+(?:send|forward|share|attach|resend)\s+(?:me\s+|us\s+|over\s+)?(?:the\s+|a\s+|an\s+|your\s+|our\s+)?([^.?!\n]{2,80})/i,
	/\b(?:send|forward|share)\s+(?:me\s+|us\s+)(?:the\s+|a\s+|an\s+|your\s+|our\s+)?([^.?!\n]{2,80})/i,
	/\b(?:see|find)\s+attached\b\s*([^.?!\n]{0,80})/i,
	/\battached\s+(?:is|are|please\s+find|you'?ll\s+find)\b\s*([^.?!\n]{0,80})/i,
];

/** Noise words trimmed from the extracted object phrase before it seeds the
 * file search. Keeps the query on the document nouns. */
const QUERY_STOPWORDS = new Set([
	'me',
	'us',
	'the',
	'a',
	'an',
	'to',
	'my',
	'your',
	'our',
	'over',
	'please',
	'copy',
	'of',
]);

/** Trim a captured object phrase down to its meaningful document tokens. */
function cleanQuery(raw: string): string {
	const tokens = raw
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
		.split(/\s+/);
	const words: string[] = [];
	for (const token of tokens) {
		if (token.length > 0 && !QUERY_STOPWORDS.has(token)) words.push(token);
	}
	return words.join(' ').trim();
}

/**
 * Deterministically decide whether the inbound email is asking for a file to be
 * sent back, and extract a rough query phrase to seed the contact-scoped file
 * search. Pure + model-free. `query` is a best-effort noun phrase (may be '' —
 * the caller then falls back to the wider context). Never throws.
 */
export function detectAttachmentRequest(text: string): { requested: boolean; query: string } {
	if (!text) return { requested: false, query: '' };
	for (const pattern of REQUEST_PATTERNS) {
		const match = pattern.exec(text);
		if (match) {
			return { requested: true, query: cleanQuery(match[1] ?? '') };
		}
	}
	return { requested: false, query: '' };
}

// ─── Candidate ranking ───────────────────────────────────────────────────────

/**
 * Rank the contact-scoped file matches (already best-first) into either a single
 * confident suggestion or an ambiguous shortlist. The input order is the search's
 * fused ranking, so `files[0]` is the strongest hit.
 *
 *   - no matches                         → empty, not ambiguous.
 *   - exactly one match                  → suggest it (not ambiguous).
 *   - top hit clearly ahead (floor+margin) → suggest only the top (not ambiguous).
 *   - otherwise (≥2 comparable matches)  → AMBIGUOUS shortlist — ask, don't guess.
 *
 * Pure + exported for tests. Never throws.
 */
export function pickAttachmentSuggestion<T extends AttachmentCandidate>(
	files: T[],
): AttachmentSuggestionResult<T> {
	const ranked = files.slice(0, MAX_CANDIDATES);
	if (ranked.length === 0) return { candidates: [], ambiguous: false };
	if (ranked.length === 1) return { candidates: [ranked[0]!], ambiguous: false };

	const top = ranked[0]!;
	const second = ranked[1]!;
	const topDominant = top.score >= MATCH_FLOOR && top.score - second.score >= AMBIGUITY_MARGIN;
	if (topDominant) return { candidates: [top], ambiguous: false };

	return { candidates: ranked, ambiguous: true };
}
