/**
 * Build a short, single-line plaintext preview for a message.
 *
 * Used to denormalize `conversationThreads.lastPreview` at intake so the
 * team-inbox row can render a snippet line without joining to the newest
 * message. Prefers a plaintext body; falls back to a crude tag-strip of HTML.
 * Collapses whitespace, trims, and truncates with an ellipsis — the row already
 * clamps visually, so this only bounds the stored string.
 */
const MAX_PREVIEW_CHARS = 140;

export function buildMessagePreview(input: {
	text?: string;
	html?: string;
	max?: number;
}): string | undefined {
	const max = input.max ?? MAX_PREVIEW_CHARS;
	const source = input.text?.trim()
		? input.text
		: input.html
			? // Strip tags and decode the few entities that survive a tag-strip so a
				// preview never shows raw `&nbsp;` / markup.
				input.html
					.replace(/<[^>]*>/g, ' ')
					.replace(/&nbsp;/g, ' ')
					.replace(/&amp;/g, '&')
					.replace(/&lt;/g, '<')
					.replace(/&gt;/g, '>')
			: '';
	const collapsed = source.replace(/\s+/g, ' ').trim();
	if (!collapsed) return undefined;
	return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}
