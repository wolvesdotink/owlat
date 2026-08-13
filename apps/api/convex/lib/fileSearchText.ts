/**
 * The full-text payload for a semantic file.
 *
 * `search_files` indexes exactly one field — `semanticFiles.searchableText` —
 * so anything a user should be able to find a file by has to be folded in
 * here. One builder owns that composition for all three write paths:
 *
 *   - insert (`semanticFiles.insertSemanticFile`): filename, title, tags,
 *   - processing (`semanticFileProcessing.processFile`): + summary, auto-tags
 *     and the head of the extracted body,
 *   - metadata edits (`semanticFiles.update`): rebuilt from the stored row, so
 *     a renamed or re-tagged file doesn't keep a stale index entry.
 *
 * Kept as a pure function (no ctx) so both the mutation and the action runtime
 * can call it and so it is unit-testable without a Convex harness.
 */

/** Chars of extracted body text folded into the index. */
const EXTRACTED_TEXT_BUDGET = 1000;

/** Ceiling on the stored value — the whole field is indexed. */
const SEARCHABLE_TEXT_MAX = 5000;

export interface FileSearchTextParts {
	filename: string;
	title?: string;
	summary?: string;
	tags?: string[];
	autoTags?: string[];
	extractedText?: string;
}

export function buildFileSearchableText(parts: FileSearchTextParts): string {
	const pieces: string[] = [parts.filename];
	// Also emit the filename's separator-split words, so "q3-budget_v2.pdf" is
	// findable by "budget" and not only as one opaque token.
	pieces.push(...parts.filename.replace(/\.[^.]+$/, '').split(/[-_.\s]+/));
	if (parts.title) pieces.push(parts.title);
	if (parts.summary) pieces.push(parts.summary);
	pieces.push(...(parts.tags ?? []), ...(parts.autoTags ?? []));
	if (parts.extractedText) pieces.push(parts.extractedText.slice(0, EXTRACTED_TEXT_BUDGET));

	// De-dup so a tag that repeats the filename (the common case for auto-tags)
	// doesn't eat the budget twice.
	const seen = new Set<string>();
	const out: string[] = [];
	for (const piece of pieces) {
		const trimmed = piece.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out.join(' ').slice(0, SEARCHABLE_TEXT_MAX);
}
