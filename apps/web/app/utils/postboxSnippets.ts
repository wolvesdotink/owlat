/**
 * Pure helpers for the saved-reply picker of both composers: the `;` trigger
 * typed into the text and the ranking the picker lists replies in.
 *
 * Kept framework-free so the trigger/ranking logic is unit-testable without a
 * DOM: the editors own the Selection/Range (or textarea caret) plumbing and
 * call into these. Variable resolution lives in `postboxSnippetVariables.ts`.
 */

import { fuzzyMatch } from '~/lib/commandPalette';

export interface SnippetTrigger {
	/** Text typed after the trigger character (the live filter query). */
	query: string;
	/** Index of the trigger character within the sampled text-before-caret. */
	triggerStart: number;
}

/**
 * The characters that open the picker. `;` is the one the docs teach, because
 * prose almost never puts it at the start of a word; `/` is what the Postbox
 * used before saved replies, and stays for the people who learned it.
 */
const TRIGGER_CHARS = [';', '/'] as const;

/**
 * Decide whether the text immediately before the caret is an active trigger: a
 * `;` (or `/`) at the very start of the input or after whitespace (the start
 * of a line or a new word), followed by a run of non-whitespace characters (the
 * filter query still being typed).
 *
 * Returns null for a mid-word trigger ("and/or", "x;y"), or when whitespace
 * already follows it (the token is finished, so it's literal text again).
 */
export function detectSnippetTrigger(textBeforeCaret: string): SnippetTrigger | null {
	const start = Math.max(...TRIGGER_CHARS.map((char) => textBeforeCaret.lastIndexOf(char)));
	if (start < 0) return null;
	const prev = start === 0 ? '' : (textBeforeCaret[start - 1] ?? '');
	// Must be at start-of-input, start-of-line, or after whitespace.
	if (prev !== '' && !/\s/.test(prev)) return null;
	const query = textBeforeCaret.slice(start + 1);
	// Any whitespace in the query means the token has been closed off.
	if (/\s/.test(query)) return null;
	return { query, triggerStart: start };
}

export interface RankableSnippet {
	name: string;
	shortcut: string;
	/** How often the reply was inserted; absent counts as never. */
	useCount?: number;
	/** When it was last inserted; absent or null counts as never. */
	lastUsedAt?: number | null;
}

/** Most used first, then most recently used, then by name. */
function byUsage(a: RankableSnippet, b: RankableSnippet): number {
	return (
		(b.useCount ?? 0) - (a.useCount ?? 0) ||
		(b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
		a.name.localeCompare(b.name)
	);
}

/** An exact shortcut always wins; this keeps it above any fuzzy score. */
const EXACT_SHORTCUT = 10_000;

/**
 * Filter + rank replies against the live query. An empty query lists every
 * reply, the ones used most (then most recently) first. Otherwise the query is
 * matched fuzzily (as a subsequence, the command palette's matcher) against the
 * shortcut and the name: an exact shortcut first, then the better of the two
 * scores, ties by usage.
 */
export function rankSnippets<T extends RankableSnippet>(snippets: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...snippets].sort(byUsage);
	const scored: { snippet: T; score: number }[] = [];
	for (const snippet of snippets) {
		const shortcut = snippet.shortcut.toLowerCase();
		if (shortcut && shortcut === q) {
			scored.push({ snippet, score: EXACT_SHORTCUT });
			continue;
		}
		const scores = [shortcut ? fuzzyMatch(shortcut, q) : null, fuzzyMatch(snippet.name, q)]
			.filter((match) => match !== null)
			.map((match) => match.score);
		if (scores.length > 0) scored.push({ snippet, score: Math.max(...scores) });
	}
	scored.sort((a, b) => b.score - a.score || byUsage(a.snippet, b.snippet));
	return scored.map((x) => x.snippet);
}

/** First whitespace-delimited token of a display name (the "{{firstName}}"). */
export function firstNameOf(displayName: string | null | undefined): string | undefined {
	const first = (displayName ?? '').trim().split(/\s+/)[0];
	return first || undefined;
}

/** Everything after the first name ("Lovelace" of "Ada Lovelace"), or undefined. */
export function lastNameOf(displayName: string | null | undefined): string | undefined {
	const rest = (displayName ?? '').trim().split(/\s+/).slice(1).join(' ');
	return rest || undefined;
}

/** Reply and forward markers a subject collects, in the languages mail clients write. */
const SUBJECT_PREFIX = /^\s*(?:re|fwd?|aw|wg|sv|vs|tr|antw)\s*(?:\[\d+\])?\s*:\s*/i;

/** The conversation's own subject for `{{thread.subject}}`: "Re: Re: Invoice" is "Invoice". */
export function threadSubjectOf(subject: string | null | undefined): string {
	let rest = (subject ?? '').trim();
	while (SUBJECT_PREFIX.test(rest)) rest = rest.replace(SUBJECT_PREFIX, '');
	return rest.trim();
}
