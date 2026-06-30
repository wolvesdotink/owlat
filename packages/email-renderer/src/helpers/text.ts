/**
 * Plaintext extraction helpers. Used by text/rawHtml/table block modules to
 * convert HTML fragments into the multipart text/plain body.
 */

/**
 * Strip HTML tags, decode common entities, and collapse whitespace.
 */
export const stripHtml = (html: string): string =>
	html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<\/div>/gi, '\n')
		.replace(/<\/h[1-6]>/gi, '\n\n')
		.replace(/<li>/gi, '  - ')
		.replace(/<\/li>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\n{3,}/g, '\n\n')
		.trim();

/**
 * Expand `<a href="X">Y</a>` to `Y (X)` so links survive plaintext output.
 * Bare anchors (no visible text or text equal to href) collapse to just the URL.
 */
export const extractLinks = (html: string): string => {
	const linkRegex = /<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
	let text = html;
	let match: RegExpExecArray | null;

	while ((match = linkRegex.exec(html)) !== null) {
		const fullMatch = match[0];
		const url = match[1];
		const label = match[2];
		const cleanLabel = stripHtml(label ?? '');
		if (cleanLabel && url && cleanLabel !== url) {
			text = text.replace(fullMatch, `${cleanLabel} (${url})`);
		} else if (url) {
			text = text.replace(fullMatch, url);
		}
	}

	return text;
};
