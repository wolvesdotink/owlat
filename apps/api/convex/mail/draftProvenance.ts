/**
 * Who wrote a saved draft (#1346): the AI, a person, or both.
 *
 * Answered-conversation cleanup (mail/answeredReply.ts) may only take a draft
 * the AI wrote and no person ever touched, so every write records which it
 * was:
 *
 *   - `aiAuthored` (text + time) is set by a write whose written part is
 *     exactly an AI text: Answer mode streaming or applying a draft tags its
 *     autosave with `aiText`, and the server checks the body really holds it.
 *     Every AI write refreshes it, so a second generation counts as AI too.
 *   - `humanTouchedAt` is set by any write a person makes that changes the row.
 *     `drafts.update` field by field: recipients, subject, follow-up, mode,
 *     the HTML body's written part, the plain-text body and the block body
 *     each count when they differ from what is stored; `isGapGuarded` counts
 *     when it newly guards (a saved reply with gaps went in); `aiBaseline` and
 *     `aiText` are the AI's. Elsewhere: identity, attachments (add, remove,
 *     share link, owed files), each only when the row really changes. It is
 *     never cleared, and it brings an obsoleted draft back.
 *
 * An autosave that changes nothing (the same snapshot again, the seeded
 * signature and quote only) touches nothing. The editor emits only on input,
 * so a body that differs from the stored one is a person's edit unless the
 * write is a tagged AI write that matches.
 */

import type { Doc } from '../_generated/dataModel';
import { aiTextToHtml, splitAnswerBody } from '@owlat/shared/answerMode';
import { htmlToPlainText } from '@owlat/shared/html';
import { openMailDraftBody } from '../lib/messageBody';

/** The patch fields of a change a person made. */
export function humanEdit(now: number) {
	return { lastEditedAt: now, humanTouchedAt: now, obsoleted: undefined };
}

/** The patch fields of a write: a person's edit if it changed the row, else nothing. */
export function editPatch(isChange: boolean, now: number = Date.now()) {
	return isChange ? humanEdit(now) : {};
}

/** The written part of a body, with an empty one (no text, link or image) as ''. */
function writtenPart(bodyHtml: string): string {
	const fresh = splitAnswerBody(bodyHtml).fresh.trim();
	const hasMedia = /<(?:a|img)\b/i.test(fresh);
	return !hasMedia && htmlToPlainText(fresh) === '' ? '' : fresh;
}

function sameWords(a: string, b: string): boolean {
	const words = (text: string) => text.replace(/\s+/g, ' ').trim();
	return words(a) === words(b);
}

function sameList(next: readonly string[] | undefined, stored: readonly string[]): boolean {
	return (
		next === undefined || (next.length === stored.length && next.every((a, i) => a === stored[i]))
	);
}

/** The fields of a `drafts.update` call this module reads. */
export interface DraftWrite {
	toAddresses?: string[];
	ccAddresses?: string[];
	bccAddresses?: string[];
	subject?: string;
	bodyHtml?: string;
	bodyText?: string;
	bodyBlocks?: string;
	isGapGuarded?: true;
	composerMode?: 'simple' | 'full';
	followUpRemindAt?: number | null;
	aiText?: string;
}

/** The provenance fields one `drafts.update` write sets (see the module header). */
export async function provenancePatch(
	draft: Doc<'mailDrafts'>,
	write: DraftWrite,
	now: number
): Promise<Record<string, unknown>> {
	const envelopeChanged =
		!sameList(write.toAddresses, draft.toAddresses) ||
		!sameList(write.ccAddresses, draft.ccAddresses) ||
		!sameList(write.bccAddresses, draft.bccAddresses) ||
		(write.subject !== undefined && write.subject !== draft.subject) ||
		(write.composerMode !== undefined && write.composerMode !== (draft.composerMode ?? 'simple')) ||
		(write.followUpRemindAt !== undefined &&
			(write.followUpRemindAt ?? undefined) !== draft.followUpRemindAt) ||
		(write.isGapGuarded === true && draft.isGapGuarded !== true);

	let isAiWrite = false;
	let aiBodyChanged = false;
	let bodyChanged = false;
	const isBodyWrite =
		write.bodyHtml !== undefined || write.bodyText !== undefined || write.bodyBlocks !== undefined;
	if (isBodyWrite) {
		const stored = await openMailDraftBody(draft);
		if (write.bodyBlocks !== undefined && write.bodyBlocks !== (stored.bodyBlocks ?? '')) {
			bodyChanged = true;
		}
		if (write.bodyHtml !== undefined) {
			const written = writtenPart(write.bodyHtml);
			isAiWrite =
				write.aiText !== undefined && written !== '' && written === aiTextToHtml(write.aiText);
			if (written !== writtenPart(stored.bodyHtml)) {
				if (isAiWrite) aiBodyChanged = true;
				else bodyChanged = true;
			}
		}
		// The plain-text body (a quick reply, the offline outbox) is a person's
		// text unless it is provably the AI's: the same words as the AI text this
		// verified AI write carries. Anything else counts as theirs.
		if (write.bodyText !== undefined && write.bodyText !== (stored.bodyText ?? '')) {
			const isAiText = isAiWrite && sameWords(write.bodyText, write.aiText ?? '');
			if (isAiText) aiBodyChanged = true;
			else bodyChanged = true;
		}
	}

	// A write that changes nothing leaves the row as it was, `lastEditedAt`
	// included: the answered-draft cutoff compares it with a reply's send time.
	const isNewAiText = isAiWrite && draft.aiAuthored?.text !== write.aiText;
	const changed = envelopeChanged || bodyChanged ? humanEdit(now) : {};
	return {
		...(isNewAiText ? { aiAuthored: { text: write.aiText, at: now } } : {}),
		...(aiBodyChanged ? { lastEditedAt: now } : {}),
		...changed,
	};
}
