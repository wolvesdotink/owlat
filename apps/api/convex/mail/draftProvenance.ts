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
 *   - `humanTouchedAt` is set by any write a person makes that changes the row:
 *     the written part, recipients, subject, follow-up, mode, identity or
 *     attachments. It is never cleared, and it brings an obsoleted draft back.
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

/** The written part of a body, with an empty one (no text, link or image) as ''. */
function writtenPart(bodyHtml: string): string {
	const fresh = splitAnswerBody(bodyHtml).fresh.trim();
	const hasMedia = /<(?:a|img)\b/i.test(fresh);
	return !hasMedia && htmlToPlainText(fresh) === '' ? '' : fresh;
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
	bodyBlocks?: string;
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
			(write.followUpRemindAt ?? undefined) !== draft.followUpRemindAt);

	let isAiWrite = false;
	let bodyChanged = false;
	if (write.bodyHtml !== undefined || write.bodyBlocks !== undefined) {
		const stored = await openMailDraftBody(draft);
		if (write.bodyBlocks !== undefined && write.bodyBlocks !== (stored.bodyBlocks ?? '')) {
			bodyChanged = true;
		}
		if (write.bodyHtml !== undefined) {
			const written = writtenPart(write.bodyHtml);
			isAiWrite =
				write.aiText !== undefined && written !== '' && written === aiTextToHtml(write.aiText);
			if (!isAiWrite && written !== writtenPart(stored.bodyHtml)) bodyChanged = true;
		}
	}

	return {
		...(isAiWrite ? { aiAuthored: { text: write.aiText, at: now } } : {}),
		...(envelopeChanged || bodyChanged ? humanEdit(now) : {}),
	};
}
