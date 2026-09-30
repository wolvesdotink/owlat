/**
 * The Answer mode draft body, as plain rules: where the part the person (or
 * the AI) writes ends, how an AI draft replaces it, which gap placeholders are
 * left in it, and what the backend's "gaps left" refusal looks like.
 *
 * A reply body is `<fresh part>` followed by the tail the composer seeded: the
 * signature block (`data-postbox-signature`) and the quoted original
 * (`gmail_quote`), each with its `<br><br>` spacing. An AI draft replaces the
 * fresh part only, so the quote the sent message carries and the signature the
 * person chose stay byte for byte what they were.
 *
 * Pure string work (no DOM), so it runs the same in tests and in the browser.
 */
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import { findDraftGaps, type DraftGap } from '@owlat/shared/answerMode';
import type { OperationError } from '@owlat/shared/operationError';
import { draftTextParts } from '~/utils/postboxDraftText';

/** The start of the seeded tail: the signature block or the quoted original. */
const TAIL_START =
	/(?:<br\s*\/?>\s*){0,2}<div[^>]*(?:\bdata-postbox-signature\b|class=["'][^"']*gmail_quote)/i;

/** Split a body into what was written and the seeded tail (signature, quote). */
export function splitAnswerBody(bodyHtml: string): { fresh: string; tail: string } {
	const index = bodyHtml.search(TAIL_START);
	if (index < 0) return { fresh: bodyHtml, tail: '' };
	return { fresh: bodyHtml.slice(0, index), tail: bodyHtml.slice(index) };
}

/**
 * Plain AI text as the composer's HTML: blank lines make paragraphs, single
 * line breaks stay breaks, and everything is escaped (model output is never
 * markup).
 */
export function aiTextToHtml(text: string): string {
	const paragraphs = text
		.replace(/\r\n?/g, '\n')
		.trim()
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	return paragraphs.map((p) => `<p>${escapeHtmlWithBreaks(p)}</p>`).join('');
}

/** `bodyHtml` with its fresh part replaced by `text` (the tail untouched). */
export function replaceAnswerText(bodyHtml: string, text: string): string {
	const { tail } = splitAnswerBody(bodyHtml);
	const html = aiTextToHtml(text);
	return html ? `${html}${tail}` : tail;
}

/**
 * The gap placeholders left in what was written (never in the quoted original:
 * a `[[...]]` in the mail being answered belongs to its author).
 */
export function freshDraftGaps(bodyHtml: string): DraftGap[] {
	return findDraftGaps(draftTextParts(bodyHtml).fresh);
}

/** The plain text of what was written, for the ask coverage check. */
export function freshDraftText(bodyHtml: string): string {
	const { fresh } = splitAnswerBody(bodyHtml);
	return draftTextParts(fresh).fresh;
}

/** The typed code `drafts.send` refuses with while a placeholder is left. */
export const DRAFT_HAS_GAPS = 'DRAFT_HAS_GAPS';

/** Whether a failed send is the backend's "gaps left" refusal. */
export function isDraftGapsRefusal(op: OperationError): boolean {
	return op.data?.['code'] === DRAFT_HAS_GAPS;
}

/**
 * Whether a failed `composeDraft.answer` is the double submit: the session had
 * already left `asking` because the first submit is drafting ("These questions
 * were already answered"). It is the answer path's only `invalid_state`
 * without a typed code, and it is harmless: the draft the first call started
 * arrives through the session subscription.
 */
export function isAlreadyAnsweredRefusal(op: OperationError): boolean {
	return op.category === 'invalid_state' && op.data?.['code'] === undefined;
}

/** The owner's IANA time zone, for dates the AI promises ("tomorrow" at 09:00 local). */
export function ownerTimeZone(): string | undefined {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
	} catch {
		return undefined;
	}
}
