/**
 * Presentation-only tidying of a SANITIZED message body before it renders.
 *
 * Mail clients pad the end of a reply with empty paragraphs (Outlook writes a
 * `<p class="MsoNormal">&nbsp;</p>` per blank line above its reply header). Once
 * the quoted original is folded away behind "Show quoted text", that padding is
 * all that is left at the bottom of the body: a tall empty band between the
 * signature and the message actions. Trimming it changes nothing the reader
 * could miss — the blocks hold no text.
 */

/**
 * One blank block (a <p> or <div> holding only whitespace, nbsp, <br> and empty
 * spans) or a lone <br>, followed by the closing tags that end the document.
 */
const TRAILING_BLANK =
	/(?:<(p|div)\b[^>]*>(?:\s|&nbsp;| |<br\s*\/?>|<\/?span\b[^>]*>)*<\/\1>|<br\s*\/?>)\s*((?:<\/[a-z][a-z0-9]*>\s*)*)$/i;

/**
 * Only the tail is examined, so the anchored pattern never scans a large
 * newsletter from every offset. Blank padding longer than this is not a thing
 * mail clients write.
 */
const TAIL_WINDOW = 4096;

/** Removes empty trailing paragraphs / line breaks, keeping closing tags. */
export function trimTrailingBlankBlocks(html: string): string {
	const cut = Math.max(0, html.length - TAIL_WINDOW);
	const head = html.slice(0, cut);
	let tail = html.slice(cut);
	for (;;) {
		const next = tail.replace(TRAILING_BLANK, '$2');
		if (next === tail) break;
		tail = next;
	}
	return head + tail;
}
