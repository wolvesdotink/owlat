/**
 * "Forgot the attachment?" detection for the Postbox composer.
 *
 * The original version was one English regex (`attach|enclosed`) over the whole
 * body. It fired on "attached to the project", on the quoted mail you were
 * replying to, and on "I'll attach it tomorrow"; it saw nothing in German; and
 * it spoke through a native `window.confirm`. A guard that mis-fires is worse
 * than no guard — it teaches people to dismiss every warning this composer will
 * ever show — so this module is built around being quiet when unsure:
 *
 *   • only the FRESH half of the body counts (utils/postboxDraftText), so the
 *     original's "see attached" never accuses the reply;
 *   • every positive match is re-checked against NEGATIVE context — "attached
 *     to the ticket", "no attachment needed", "I'll attach it later";
 *   • the phrasing that never says "attach" at all ("see the deck", "the PDF
 *     below") is matched too, but only in the shape where it names a document;
 *   • German is a first-class language, not a gap: the active locale's patterns
 *     run alongside English, which people write in whatever the UI says;
 *   • a FORWARD whose quoted body references an attachment that is no longer on
 *     the draft is its own finding — the forward case the old regex could not
 *     express (a plain reply to a mail that mentioned an attachment is NOT one).
 *
 * Pure and module scope: it returns the matched phrase, and the composer's guard
 * resolves the copy with `t()` at the render boundary.
 */

import { clipForDisplay, draftTextParts } from '~/utils/postboxDraftText';

export type AttachmentHintKind = 'mention' | 'forwardedQuote';

export interface AttachmentHint {
	kind: AttachmentHintKind;
	/**
	 * The phrase that fired, clipped for display. Quoting the evidence back is
	 * what lets someone judge the warning instead of reflexively confirming it.
	 */
	phrase: string;
}

export interface AttachmentMentionInput {
	subject: string;
	bodyHtml: string;
	/** Whether the draft actually carries an attachment. */
	hasAttachments: boolean;
	/** Active UI locale ('de', 'de-DE', …); anything unknown is English-only. */
	locale?: string;
}

/**
 * One way of claiming an attachment, plus the contexts that take the claim back.
 * Negatives are per-rule on purpose: the "the document is somewhere else"
 * exception has to disarm "have a look at the deck" (it may well be the deck on
 * the website) without disarming "see attached", where the sender said outright
 * that something is on this message.
 */
interface MentionRule {
	pattern: RegExp;
	negatives: RegExp[];
}

type LanguagePatterns = MentionRule[];

/**
 * "attached to the project", "attached it to the ticket" — the object being
 * attached may sit in between. "attached to this email" is a real claim and is
 * excluded by the lookahead.
 */
const EN_ATTACHED_TO =
	/\battach(?:ed|ing)?\s+(?:\w+\s+){0,2}to\s+(?!(?:this|the|my)\s+(?:e-?mail|message|mail|note|thread)\b)/i;
/** "no attachment needed", "without attachments". */
const EN_NO_ATTACHMENT = /\b(?:no|not|without)\s+(?:\w+\s+){0,2}attach/i;
/** A promise, not a claim: "I'll attach it once it's signed". */
const EN_FUTURE =
	/\b(?:will|'ll|would|can|could|shall|going to|about to|plan(?:ning)? to|need to|have to)\s+(?:also\s+|then\s+)?attach/i;
/** The document lives elsewhere: only ever disarms the indirect phrasing. */
const EN_ELSEWHERE =
	/\b(?:link(?:ed|s)?|website|web site|url|online|below|above|in the (?:thread|drive|folder))\b/i;

/**
 * English. The first rule is the direct claim (`attach*` / `enclose*`); the
 * second is the indirect one ("have a look at the deck"), which requires a
 * document noun within a short window so "check out our pricing page" stays
 * quiet.
 */
const EN: LanguagePatterns = [
	{
		pattern: /\b(?:attach(?:ed|ing|ment|ments)?|enclosed|enclosing|enclosure)\b/i,
		negatives: [
			EN_ATTACHED_TO,
			EN_NO_ATTACHMENT,
			EN_FUTURE,
			/\battachments?\s+(?:removed|stripped|dropped)\b/i,
		],
	},
	{
		pattern:
			/\b(?:see|find|check out|look at|review|sending)\b[^.!?]{0,24}\b(?:deck|slides?|spreadsheet|pdf|doc|document|presentation|invoice|contract|report|file)s?\b/i,
		negatives: [EN_NO_ATTACHMENT, EN_FUTURE, EN_ELSEWHERE],
	},
];

const DE_NO_ATTACHMENT =
	/\b(?:kein|keine|keinen|ohne)\s+(?:\w+\s+){0,2}(?:anhang|anhänge|anlage|anlagen|dokument)/i;
const DE_FUTURE = /\b(?:werde|würde|will|kann|muss|sende)\b[^.!?]{0,24}\banh(?:ängen|änge)\b/i;
const DE_ELSEWHERE = /\b(?:link|webseite|website|url|unten|oben|im ordner|im laufwerk)\b/i;

/** German, with the same two shapes: the direct claim and the indirect one. */
const DE: LanguagePatterns = [
	{
		pattern:
			/\b(?:anbei|beigefügt|beiliegend|beigelegt|angehängt|anhang|anhänge|anlage|anlagen)\b/i,
		negatives: [DE_NO_ATTACHMENT, DE_FUTURE, /\banh(?:ang|änge)\s+(?:entfernt|gelöscht)\b/i],
	},
	{
		pattern:
			/\b(?:siehe|schick(?:e|t)|im)\b[^.!?]{0,24}\b(?:pdf|dokument|unterlagen|präsentation|tabelle|rechnung|vertrag|bericht|datei)e?n?\b/i,
		negatives: [DE_NO_ATTACHMENT, DE_FUTURE, DE_ELSEWHERE],
	},
];

/** A forward, by its subject prefix or by the separator the client inserted. */
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg)\s*:/i;
const FORWARD_MARKER =
	/(?:-{2,}\s*(?:forwarded message|weitergeleitete nachricht)\s*-{2,}|begin forwarded message|anfang der weitergeleiteten nachricht)/i;

/** How much text around a match counts as its context. */
const CONTEXT_BEFORE = 32;
const CONTEXT_AFTER = 48;

function languagesFor(locale: string | undefined): LanguagePatterns[] {
	// English always runs: it is what people write in regardless of UI language.
	return locale?.toLowerCase().startsWith('de') ? [EN, DE] : [EN];
}

/**
 * The first phrase in `text` that claims an attachment without a negative
 * context around it, or null when nothing survives the negative check.
 */
function firstUnnegatedMatch(text: string, languages: LanguagePatterns[]): string | null {
	for (const language of languages) {
		for (const rule of language) {
			const global = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
			let match: RegExpExecArray | null;
			while ((match = global.exec(text)) !== null) {
				const start = Math.max(0, match.index - CONTEXT_BEFORE);
				const context = text.slice(start, match.index + match[0].length + CONTEXT_AFTER);
				if (rule.negatives.some((no) => no.test(context))) continue;
				return match[0];
			}
		}
	}
	return null;
}

/**
 * Decide whether this draft looks like it forgot its attachment. Returns null
 * when there is nothing honest to say — including whenever the draft actually
 * has an attachment.
 */
export function detectMissingAttachment(input: AttachmentMentionInput): AttachmentHint | null {
	if (input.hasAttachments) return null;
	const languages = languagesFor(input.locale);
	const body = draftTextParts(input.bodyHtml);

	const own = firstUnnegatedMatch(`${input.subject}. ${body.fresh}`, languages);
	if (own) return { kind: 'mention', phrase: clipForDisplay(own) };

	// The forward case: the message being passed on referenced an attachment
	// that did not survive into this draft. Restricted to forwards on purpose —
	// on a plain reply the quoted "see attached" belongs to the other person and
	// warning about it would be exactly the mis-fire this module exists to end.
	const isForward =
		FORWARD_SUBJECT.test(input.subject) || FORWARD_MARKER.test(body.fresh + body.quoted);
	if (isForward && body.hasQuote) {
		const quoted = firstUnnegatedMatch(body.quoted, languages);
		if (quoted) return { kind: 'forwardedQuote', phrase: clipForDisplay(quoted) };
	}
	return null;
}
