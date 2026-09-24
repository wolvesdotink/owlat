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

/**
 * Escape a plain-text reply body into the minimal HTML fragment it is sent as.
 * The body is final, non-templated text, so it is escaped and its newlines
 * become `<br>` rather than going through the block renderer.
 *
 * The one definition: the server sends a Team inbox reply with it
 * (`agent/agentPipeline`, `inbox/followUps`), and the web composer runs its
 * pre-send checks on its output, so the checks see what the recipient gets.
 */
export function replyBodyToHtml(text: string): string {
	return `<div>${escapeHtmlWithBreaks(text.replace(/\r\n/g, '\n'))}</div>`;
}
