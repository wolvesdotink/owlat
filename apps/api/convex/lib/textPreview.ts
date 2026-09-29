import { htmlToPlainText } from '@owlat/shared/html';

/**
 * Build a short, single-line plaintext preview for a message.
 *
 * Used to derive `conversationThreads.lastPreview` at intake; the thread module
 * seals the result before storage so the
 * team-inbox row can render a snippet line without joining to the newest
 * message. Prefers a plaintext body; falls back to the shared HTML→text pass
 * (no `<style>` CSS, no markup, entities decoded).
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
	const source = input.text?.trim() ? input.text : input.html ? htmlToPlainText(input.html) : '';
	const collapsed = source.replace(/\s+/g, ' ').trim();
	if (!collapsed) return undefined;
	return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}
