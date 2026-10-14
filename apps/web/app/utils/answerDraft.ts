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
 * The split and the AI text's HTML live in `@owlat/shared/answerMode`, where
 * the server reads them to tell an untouched AI draft from an edited one.
 */
import {
	aiTextToHtml,
	findDraftGaps,
	splitAnswerBody,
	type DraftGap,
} from '@owlat/shared/answerMode';
import type { OperationError } from '@owlat/shared/operationError';
import { splitQuotedText } from '@owlat/shared/quotedText';
import { draftTextParts } from '~/utils/postboxDraftText';

export { aiTextToHtml, splitAnswerBody };

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

/**
 * The gap placeholders in the written part of a plain-text draft (a Team inbox
 * draft is plain text), as the server's `authoredDraftHasGaps` reads it: a
 * `[[...]]` in the quoted original belongs to the mail being answered.
 */
export function authoredTextGaps(text: string): DraftGap[] {
	return findDraftGaps(splitQuotedText(text).fresh);
}

/**
 * A plain-text draft cut at its written gaps, for showing them marked. The
 * written part is a prefix of the text, so the offsets hold for all of it.
 */
export function draftTextGapSegments(text: string): Array<{ text: string; gap: boolean }> {
	const segments: Array<{ text: string; gap: boolean }> = [];
	let at = 0;
	for (const gap of authoredTextGaps(text)) {
		if (gap.start > at) segments.push({ text: text.slice(at, gap.start), gap: false });
		segments.push({ text: text.slice(gap.start, gap.end), gap: true });
		at = gap.end;
	}
	if (at < text.length) segments.push({ text: text.slice(at), gap: false });
	return segments;
}

/** The typed code `drafts.send` refuses with while a placeholder is left. */
export const DRAFT_HAS_GAPS = 'DRAFT_HAS_GAPS';

/** Whether a failed send is the backend's "gaps left" refusal. */
export function isDraftGapsRefusal(op: OperationError): boolean {
	return op.data?.['code'] === DRAFT_HAS_GAPS;
}

/** The typed code `composeDraft.answer` refuses a second submit with. */
const ASK_SESSION_CLAIMED = 'ASK_SESSION_CLAIMED';
/**
 * The same refusal's message, from a backend that predates the code. A
 * fallback only; drop it once every deployment sends the code.
 */
const ALREADY_ANSWERED = 'These questions were already answered';

/**
 * Whether a failed `composeDraft.answer` is the double submit: the session had
 * already left `asking` because the first submit is drafting. Harmless: the
 * draft the first call started arrives through the session subscription.
 * Other `invalid_state` refusals on the same path (a released file, a file
 * answer on a non-email thread) must still be shown.
 */
export function isAlreadyAnsweredRefusal(op: OperationError): boolean {
	const code = op.data?.['code'];
	if (code !== undefined) return code === ASK_SESSION_CLAIMED;
	return op.category === 'invalid_state' && op.message === ALREADY_ANSWERED;
}

/** The typed code Answer mode refuses a Team message the safety check held back with. */
const MESSAGE_HELD_BY_GUARD = 'MESSAGE_HELD_BY_GUARD';

/**
 * Whether a failed `composeDraft.start` (or `answer`) is the guard's refusal
 * (D13, #1339): the message this reply answers was quarantined, carried
 * malware or a malicious link, or the safety check flagged it. There is no
 * AI draft for it; the person can still write the reply.
 */
export function isHeldByGuardRefusal(op: OperationError): boolean {
	return op.data?.['code'] === MESSAGE_HELD_BY_GUARD;
}

/** The owner's IANA time zone, for dates the AI promises ("tomorrow" at 09:00 local). */
export function ownerTimeZone(): string | undefined {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
	} catch {
		return undefined;
	}
}

const collapseSpace = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Whether the person wrote something of their own: text in the editor that is
 * not just the AI draft as it went in. A newer AI draft may replace an
 * untouched one; it must not replace the person's words.
 */
export function hasOwnWriting(written: string, aiDraft: string | null): boolean {
	const text = collapseSpace(written);
	if (!text) return false;
	return aiDraft === null || text !== collapseSpace(aiDraft);
}
