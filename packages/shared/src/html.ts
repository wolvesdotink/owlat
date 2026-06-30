/**
 * Escape the HTML metacharacters &, <, >, ", '.
 *
 * Quote escaping makes the output safe in attribute values as well as text
 * nodes — the codebase once had five local escapeHtml copies with divergent
 * guarantees under the same name; this is the single canonical one.
 */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Escape HTML and convert newlines to <br> (for embedding plain text as HTML). */
export function escapeHtmlWithBreaks(s: string): string {
	return escapeHtml(s).replace(/\n/g, '<br>');
}
