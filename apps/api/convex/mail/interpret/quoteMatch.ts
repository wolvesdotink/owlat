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
/** Sequences joined into one run beyond this many: hostile input only. */
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

/** A combining mark: it joins the combining sequence before it. */
const MARK = /^\p{M}$/u;

/**
 * {@link normalizeForQuote}, plus a map from each normalized UTF-16 unit back
 * to `text`. Invisible characters go first. NFKC then runs per complete
 * combining sequence: a starter with ALL the marks after it, composing or not,
 * so canonical reordering inside the sequence is the one whole-string NFKC
 * does. Neighbouring sequences that still interact (halfwidth `ｶ` + `ﾞ` into
 * `ガ`, conjoining Hangul jamo into a syllable) are joined into one run: a
 * sequence joins the run before it when normalizing them together differs
 * from normalizing them apart. A sequence starting with ASCII never joins.
 * Every output unit maps to its run's source range.
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

	// 1. Combining sequences over the visible code points.
	const sequences: { text: string; start: number; end: number }[] = [];
	let i = 0;
	for (const cp of text) {
		const start = i;
		i += cp.length;
		const open = sequences[sequences.length - 1];
		if (INVISIBLE.test(cp)) {
			// Never visible: dropped before normalization, its range joins the sequence.
			if (open) open.end = i;
			continue;
		}
		if (open && MARK.test(cp)) {
			open.text += cp;
			open.end = i;
		} else {
			sequences.push({ text: cp, start, end: i });
		}
	}

	// 2. Runs of sequences that interact, each normalized as a whole.
	let run = '';
	let runNormalized = '';
	let runLength = 0;
	let runStart = 0;
	let runEnd = 0;
	for (const sequence of sequences) {
		const single = sequence.text.normalize('NFKC');
		if (run && sequence.text.charCodeAt(0) >= 0x80 && runLength < MAX_RUN) {
			const joined = (run + sequence.text).normalize('NFKC');
			if (joined !== runNormalized + single) {
				run += sequence.text;
				runNormalized = joined;
				runLength++;
				runEnd = sequence.end;
				continue;
			}
		}
		if (run) emit(runNormalized, runStart, runEnd);
		run = sequence.text;
		runNormalized = single;
		runLength = 1;
		runStart = sequence.start;
		runEnd = sequence.end;
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
