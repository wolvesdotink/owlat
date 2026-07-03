/**
 * Pure helpers for the composer's snippet ("/" canned response) picker.
 *
 * Kept framework-free so the trigger/ranking/placeholder logic is unit-testable
 * without a DOM: the editor component owns the Selection/Range plumbing and
 * calls into these.
 */

import { escapeHtml } from '@owlat/shared/html';

export interface SnippetTrigger {
	/** Text typed after the "/" (the live filter query). */
	query: string;
	/** Index of the triggering "/" within the sampled text-before-caret. */
	triggerStart: number;
}

/**
 * Decide whether the text immediately before the caret is an active snippet
 * trigger. A trigger is a "/" that sits at the very start of the input or is
 * preceded by whitespace (i.e. the start of a line or a new word) followed by a
 * run of non-whitespace characters (the filter query still being typed).
 *
 * Returns null for a mid-word slash ("foo/bar"), or when whitespace already
 * follows the slash (the token is finished, so it's literal text again).
 */
export function detectSnippetTrigger(textBeforeCaret: string): SnippetTrigger | null {
	const slash = textBeforeCaret.lastIndexOf('/');
	if (slash < 0) return null;
	const prev = slash === 0 ? '' : (textBeforeCaret[slash - 1] ?? '');
	// Must be at start-of-input, start-of-line, or after whitespace.
	if (prev !== '' && !/\s/.test(prev)) return null;
	const query = textBeforeCaret.slice(slash + 1);
	// Any whitespace in the query means the "/" token has been closed off.
	if (/\s/.test(query)) return null;
	return { query, triggerStart: slash };
}

export interface RankableSnippet {
	name: string;
	shortcut: string;
}

/**
 * Filter + rank snippets against the live query. Empty query returns every
 * snippet unranked (stable order). Ranking prefers, in order: exact shortcut,
 * shortcut prefix, name prefix, shortcut substring, name substring. Ties break
 * alphabetically by name.
 */
export function rankSnippets<T extends RankableSnippet>(snippets: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...snippets];
	const scored: { snippet: T; score: number }[] = [];
	for (const snippet of snippets) {
		const name = snippet.name.toLowerCase();
		const shortcut = snippet.shortcut.toLowerCase();
		let score = -1;
		if (shortcut && shortcut === q) score = 5;
		else if (shortcut && shortcut.startsWith(q)) score = 4;
		else if (name.startsWith(q)) score = 3;
		else if (shortcut && shortcut.includes(q)) score = 2;
		else if (name.includes(q)) score = 1;
		if (score >= 0) scored.push({ snippet, score });
	}
	scored.sort((a, b) => b.score - a.score || a.snippet.name.localeCompare(b.snippet.name));
	return scored.map((x) => x.snippet);
}

/** First whitespace-delimited token of a display name (the "{{firstName}}"). */
export function firstNameOf(displayName: string | null | undefined): string | undefined {
	const first = (displayName ?? '').trim().split(/\s+/)[0];
	return first || undefined;
}

/**
 * Resolve `{{token}}` placeholders in a snippet body against known values.
 *
 * A token with a non-empty value is replaced by that value (HTML-escaped — the
 * value is untrusted recipient data). A token with no value inserts a visible
 * `[token]` marker the user can fill in by hand, so an unknown recipient never
 * produces an empty or broken greeting.
 */
export function resolveSnippetPlaceholders(
	html: string,
	values: Record<string, string | null | undefined>
): string {
	return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => {
		const value = values[token];
		if (value && value.trim()) return escapeHtml(value.trim());
		return `[${token}]`;
	});
}
