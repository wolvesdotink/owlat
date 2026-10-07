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

/** Grapheme-ish clusters: a base character with its combining marks. */
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;
const SINGLE_QUOTES = /[‘’‚‛′´`]/g;
const DOUBLE_QUOTES = /[“”„‟″«»]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
const INVISIBLE = /[­​-‍⁠﻿]/g;

function foldCluster(cluster: string): string {
	return cluster
		.normalize('NFKC')
		.replace(INVISIBLE, '')
		.replace(SINGLE_QUOTES, "'")
		.replace(DOUBLE_QUOTES, '"')
		.replace(DASHES, '-');
}

/** The normalized form of `text` (see the module header). */
export function normalizeForQuote(text: string): string {
	return normalizeWithMap(text).normalized;
}

export interface NormalizedText {
	normalized: string;
	/** Per normalized character: the original range it came from. */
	from: number[];
	to: number[];
}

/** {@link normalizeForQuote}, plus a map from each normalized char back to `text`. */
export function normalizeWithMap(text: string): NormalizedText {
	const out: string[] = [];
	const from: number[] = [];
	const to: number[] = [];
	for (const match of text.matchAll(CLUSTER)) {
		const start = match.index;
		const end = start + match[0].length;
		for (const char of foldCluster(match[0])) {
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
	}
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
