/**
 * Turning a composer draft's HTML into the plain text the deterministic
 * pre-send checks read.
 *
 * Both the pre-send preflight (`postboxPreflight.ts`) and the forgot-attachment
 * hint (`attachmentMention.ts`) match prose against a body that is HTML, and
 * both must NOT match the quoted reply chain: a `[TODO]` or an "attached" in
 * the mail you are replying to belongs to its author, not to this draft.
 * Getting that split wrong is what makes a warning fire on a message that is
 * fine — the fastest way to teach people to dismiss every warning — so the
 * splitting lives in one tested place.
 *
 * Pure string work (no DOM), so it runs identically in unit tests and in the
 * browser.
 */

import { splitQuotedHtml } from '@owlat/shared/quotedText';

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	apos: "'",
	gt: '>',
	lt: '<',
	nbsp: ' ',
	quot: '"',
};

/** Decode the handful of entities a composer body realistically carries. */
function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
		if (body.startsWith('#')) {
			const code =
				body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: whole;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

/**
 * The visible text of an HTML fragment: script/style contents dropped, tags
 * replaced by a space (so `<b>at</b>tached` never welds into a false match),
 * entities decoded, whitespace collapsed.
 */
export function draftPlainText(html: string): string {
	return decodeEntities(
		html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
	)
		.replace(/\s+/g, ' ')
		.trim();
}

const MAX_DISPLAY_LENGTH = 40;

/**
 * Clip a snippet of the draft down to something that fits in a one-line chip or
 * a dialog sentence. Both guards quote the evidence back at the sender, and
 * both need the same ceiling.
 */
export function clipForDisplay(value: string, max = MAX_DISPLAY_LENGTH): string {
	const trimmed = value.trim().replace(/\s+/g, ' ');
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export interface DraftTextParts {
	/** Plain text of what the sender actually wrote. */
	fresh: string;
	/** Plain text of the quoted original, empty when there is no quote. */
	quoted: string;
	/** Whether a quote boundary was detected at all. */
	hasQuote: boolean;
	/** The fresh half as HTML — link checks need the markup, not the text. */
	freshHtml: string;
}

/** Split a draft body into its fresh and quoted halves, each as plain text. */
export function draftTextParts(bodyHtml: string): DraftTextParts {
	const split = splitQuotedHtml(bodyHtml);
	return {
		fresh: draftPlainText(split.fresh),
		quoted: draftPlainText(split.quoted),
		hasQuote: split.hasQuote,
		freshHtml: split.fresh,
	};
}
