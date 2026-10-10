/**
 * Verbatim quote matching for interpretation grounding (`./ground.ts`).
 *
 * A model quote counts as verbatim when it appears in the named segment after
 * both sides go through `normalizeForQuote` (`@owlat/shared/quoteNormalize`,
 * which the reader's quote highlighting uses too).
 *
 * Pure and isolate-safe.
 */

import {
	normalizeForQuote,
	normalizeWithMap,
	type NormalizedText,
} from '@owlat/shared/quoteNormalize';

export { normalizeForQuote, normalizeWithMap, type NormalizedText };

export type QuoteFailureReason = 'unknown_segment' | 'empty_quote' | 'not_found';

export type QuoteMatch =
	| { ok: true; segmentId: string; start: number; end: number }
	| { ok: false; segmentId: string; reason: QuoteFailureReason };

interface SegmentRange {
	id: string;
	start: number;
	end: number;
}

/**
 * Find `quote.text` verbatim (after normalization) inside the segment it names.
 * `start`/`end` are canonical-text offsets of the matched original span. The
 * first occurrence wins.
 */
export function matchQuote(
	segments: readonly SegmentRange[],
	canonicalText: string,
	quote: { segmentId: string; text: string },
	cache?: Map<string, NormalizedText>
): QuoteMatch {
	const segment = segments.find((s) => s.id === quote.segmentId);
	if (!segment) return { ok: false, segmentId: quote.segmentId, reason: 'unknown_segment' };
	const needle = normalizeForQuote(quote.text);
	if (!needle) return { ok: false, segmentId: segment.id, reason: 'empty_quote' };
	let hay = cache?.get(segment.id);
	if (!hay) {
		hay = normalizeWithMap(canonicalText.slice(segment.start, segment.end));
		cache?.set(segment.id, hay);
	}
	const at = hay.normalized.indexOf(needle);
	if (at < 0) return { ok: false, segmentId: segment.id, reason: 'not_found' };
	return {
		ok: true,
		segmentId: segment.id,
		start: segment.start + (hay.from[at] as number),
		end: segment.start + (hay.to[at + needle.length - 1] as number),
	};
}

/** The last canonical text normalized by {@link quoteOccurrence} (one run reads one message). */
let occurrenceCache: { text: string; hay: NormalizedText } | null = null;

/**
 * Where the span `canonicalText[start, end)` sits among the matches of its own
 * normalized words in the whole canonical text: `occurrence` is its index
 * (0 = the first) and `total` how many there are. The canonical text is the
 * scanner-stripped text the model read, so hidden copies are not counted. The
 * reader marks the `occurrence`-th match of its VISIBLE text, and only when it
 * sees exactly `total` matches; otherwise it says it could not locate it.
 */
export function quoteOccurrences(
	canonicalText: string,
	start: number,
	end: number
): { occurrence: number; total: number } {
	const needle = normalizeForQuote(canonicalText.slice(start, end));
	if (!needle) return { occurrence: 0, total: 0 };
	if (occurrenceCache?.text !== canonicalText) {
		occurrenceCache = { text: canonicalText, hay: normalizeWithMap(canonicalText) };
	}
	const { normalized, from } = occurrenceCache.hay;
	let occurrence = 0;
	let total = 0;
	for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, at + 1)) {
		if ((from[at] as number) < start) occurrence++;
		total++;
	}
	return { occurrence, total };
}
