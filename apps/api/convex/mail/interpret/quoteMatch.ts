/**
 * Verbatim quote matching for interpretation grounding (`./ground.ts`).
 *
 * A model quote counts as verbatim when it appears in the named segment after
 * both sides go through {@link normalizeForQuote}: Unicode NFKC, curly quotes
 * and dashes folded to ASCII, invisible format characters (zero-width
 * spaces and joiners, soft hyphens, BOM) dropped, and every whitespace run
 * collapsed to one space. Case and everything else must match.
 *
 * Pure and isolate-safe.
 */

const SINGLE_QUOTES = /[‘’‚‛′´`]/g;
const DOUBLE_QUOTES = /[“”„‟″«»]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
const INVISIBLE = /^[­​-‍⁠﻿]$/;
/** A run of code points normalized as one beyond this many: hostile input only. */
const MAX_RUN = 32;

function fold(normalized: string): string {
	return normalized.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(DASHES, '-');
}

/** The normalized form of `text` (see the module header). */
export function normalizeForQuote(text: string): string {
	return normalizeWithMap(text).normalized;
}

export interface NormalizedText {
	normalized: string;
	/** Per normalized UTF-16 unit: the original range it came from. */
	from: number[];
	to: number[];
}

/**
 * {@link normalizeForQuote}, plus a map from each normalized UTF-16 unit back
 * to `text`. NFKC runs over the whole string: code points that compose or
 * reorder with what comes before them (`ｶ` + `ﾞ` into `ガ`, conjoining Hangul
 * jamo into a syllable, a base with its marks) are normalized as one run and
 * map to that run's range. A run is found by checking whether normalizing it
 * with the next code point differs from normalizing them apart; an ASCII code
 * point never composes with what precedes it, so it always starts a new run.
 */
export function normalizeWithMap(text: string): NormalizedText {
	const out: string[] = [];
	const from: number[] = [];
	const to: number[] = [];
	const emit = (run: string, start: number, end: number) => {
		for (const char of fold(run)) {
			if (/\s/.test(char)) {
				if (out.length === 0) continue;
				if (out[out.length - 1] === ' ') {
					to[to.length - 1] = end;
					continue;
				}
				out.push(' ');
				from.push(start);
				to.push(end);
				continue;
			}
			// One entry per UTF-16 unit: matching indexes the joined string by unit,
			// and an astral character is two of them.
			for (let k = 0; k < char.length; k++) {
				out.push(char[k] as string);
				from.push(start);
				to.push(end);
			}
		}
	};
	let run = '';
	let runNormalized = '';
	let runLength = 0;
	let runStart = 0;
	let runEnd = 0;
	let i = 0;
	for (const cp of text) {
		const start = i;
		i += cp.length;
		if (INVISIBLE.test(cp)) {
			// Never visible: dropped before normalization, its range joins the run.
			if (run) runEnd = i;
			continue;
		}
		const single = cp.normalize('NFKC');
		if (run && cp.charCodeAt(0) >= 0x80 && runLength < MAX_RUN) {
			const joined = (run + cp).normalize('NFKC');
			if (joined !== runNormalized + single) {
				run += cp;
				runNormalized = joined;
				runLength++;
				runEnd = i;
				continue;
			}
		}
		if (run) emit(runNormalized, runStart, runEnd);
		run = cp;
		runNormalized = single;
		runLength = 1;
		runStart = start;
		runEnd = i;
	}
	if (run) emit(runNormalized, runStart, runEnd);
	if (out[out.length - 1] === ' ') {
		out.pop();
		from.pop();
		to.pop();
	}
	return { normalized: out.join(''), from, to };
}

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
