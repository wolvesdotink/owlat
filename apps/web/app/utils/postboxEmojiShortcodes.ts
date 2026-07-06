/**
 * Pure logic for the Postbox `:shortcode:` emoji picker + ASCII-smiley shortcuts.
 *
 * DOM-free so it can be unit-tested in isolation; the composable
 * (`usePostboxEmojiPicker`) wires these to the contenteditable caret. Covers:
 *   - trigger detection: a `:` followed by >=2 shortcode chars at the caret,
 *     rejected when the colon is part of a word/URL scheme (e.g. `http://`);
 *   - fuzzy filtering the curated emoji set to the top hits;
 *   - a small set of well-known ASCII smileys (`:)` -> 🙂) converted on space.
 */

import { POSTBOX_EMOJI, type PostboxEmoji } from './postboxEmojiData';

/** A detected `:shortcode` trigger at the caret. */
export interface ShortcodeTrigger {
	/** The query typed after the colon (lowercased), e.g. `sm` for `:sm`. */
	query: string;
	/** Index in the source text where the `:` begins. */
	start: number;
}

// The colon must open at the start of the text or after a non-word boundary so a
// colon embedded in a word or a URL scheme (`http:`) never triggers. The query is
// >=2 shortcode chars anchored to the caret (end of the sampled text).
const TRIGGER_RE = /(?:^|[^A-Za-z0-9])(:([A-Za-z0-9_+-]{2,}))$/;

/**
 * Detect a `:shortcode` trigger at the end of the text before the caret. Returns
 * `null` when there is no trigger (too short, or the colon is inside a word/URL).
 */
export function detectShortcodeTrigger(textBeforeCaret: string): ShortcodeTrigger | null {
	const m = TRIGGER_RE.exec(textBeforeCaret);
	if (!m) return null;
	const token = m[1]!; // `:query`, anchored to the end of the string
	return {
		query: m[2]!.toLowerCase(),
		start: textBeforeCaret.length - token.length,
	};
}

/** Score a single emoji against a lowercased query; higher is better, 0 = no match. */
function scoreEmoji(emoji: PostboxEmoji, query: string): number {
	const shortcode = emoji.shortcode.toLowerCase();
	if (shortcode === query) return 1000;
	if (shortcode.startsWith(query)) return 700 - shortcode.length;
	const haystack = `${shortcode} ${emoji.name.toLowerCase()}`;
	// Word-start match inside the name (e.g. "hb" should not, but "happy" should).
	if (haystack.includes(query)) return 400 - shortcode.length;
	// Subsequence fallback: all query chars appear in order in the shortcode.
	if (isSubsequence(query, shortcode)) return 150 - shortcode.length;
	return 0;
}

/** True when every char of `needle` appears in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
	let i = 0;
	for (let j = 0; j < haystack.length && i < needle.length; j++) {
		if (haystack[j] === needle[i]) i++;
	}
	return i === needle.length;
}

/**
 * Fuzzy-filter the curated emoji set to the best `limit` matches for `query`
 * (the raw text after the colon, with or without a leading colon). Stable,
 * highest-score-first, alphabetical tiebreak.
 */
export function fuzzyFilterEmoji(query: string, limit = 8): PostboxEmoji[] {
	const q = query.replace(/^:/, '').toLowerCase().trim();
	if (q.length < 1) return [];
	const scored: Array<{ emoji: PostboxEmoji; score: number }> = [];
	for (const emoji of POSTBOX_EMOJI) {
		const score = scoreEmoji(emoji, q);
		if (score > 0) scored.push({ emoji, score });
	}
	scored.sort((a, b) => b.score - a.score || a.emoji.shortcode.localeCompare(b.emoji.shortcode));
	return scored.slice(0, limit).map((s) => s.emoji);
}

/** A well-known ASCII smiley → emoji mapping. */
export interface AsciiSmiley {
	/** The literal ASCII smiley text, e.g. `:)`. */
	ascii: string;
	/** The emoji character it converts to. */
	char: string;
}

// Ordered longest-first so `:-)` wins over `:)` when both could match the tail.
// prettier-ignore
export const ASCII_SMILEYS: readonly AsciiSmiley[] = Object.freeze([
	{ ascii: ':-)', char: '🙂' },
	{ ascii: ':-(', char: '🙁' },
	{ ascii: ':-D', char: '😀' },
	{ ascii: ':-P', char: '😛' },
	{ ascii: ';-)', char: '😉' },
	{ ascii: ':)', char: '🙂' },
	{ ascii: ':(', char: '🙁' },
	{ ascii: ':D', char: '😀' },
	{ ascii: ':P', char: '😛' },
	{ ascii: ';)', char: '😉' },
	{ ascii: ':o', char: '😮' },
	{ ascii: '<3', char: '❤️' },
]);

/** A matched ASCII smiley at the caret, ready to convert. */
export interface AsciiSmileyMatch extends AsciiSmiley {
	/** Index in the source text where the smiley begins. */
	start: number;
}

/**
 * Match a well-known ASCII smiley at the end of the text before the caret. The
 * smiley must sit at the start of the text or after whitespace so mid-word colons
 * (URLs, timestamps) never convert. Returns `null` when nothing matches.
 */
export function matchAsciiSmiley(textBeforeCaret: string): AsciiSmileyMatch | null {
	for (const smiley of ASCII_SMILEYS) {
		if (!textBeforeCaret.endsWith(smiley.ascii)) continue;
		const start = textBeforeCaret.length - smiley.ascii.length;
		const prev = start > 0 ? textBeforeCaret[start - 1]! : '';
		if (start === 0 || /\s/.test(prev)) {
			return { ...smiley, start };
		}
	}
	return null;
}
