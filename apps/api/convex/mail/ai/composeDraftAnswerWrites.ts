/**
 * The writes an Answer mode session makes outside its own row, as
 * `MutationCtx` helpers: the standing answers it remembers for the contact,
 * and the draft's follow-up it arms. Used by the session's one commit
 * (composeDraftCommit.ts) and by the store's previous-release wrappers.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { captureStandingAnswers } from '../../inbox/clarificationMemory';
import { FILE_QUESTION_ID, FOLLOW_UP_QUESTION_ID } from './composeDraftPolicy';

/**
 * Remember the owner's own answers per contact (inbox/clarificationMemory.ts),
 * so the next request pre-picks them as "last time". Only typed answers to the
 * slot questions: a file, the file question's "not ready" and the one-off
 * follow-up date are not standing facts. Fail-soft like every other capture.
 */
export async function captureOwnAnswers(
	ctx: MutationCtx,
	row: Doc<'answerAskSessions'>,
	questionIds: readonly string[]
): Promise<{ stored: number }> {
	const wanted = new Set(questionIds);
	const answers = [];
	for (const q of row.questions) {
		if (!wanted.has(q.id) || !q.answer || q.answer.source !== 'user') continue;
		if (q.id === FILE_QUESTION_ID || q.id === FOLLOW_UP_QUESTION_ID || q.answer.file) continue;
		answers.push({ slotType: q.slotType, questionText: q.text, value: q.answer.value });
	}
	if (answers.length === 0) return { stored: 0 };
	try {
		return await captureStandingAnswers(ctx, {
			contactId: row.contactId,
			fromAddress: row.counterpartAddress,
			source: row.target.kind === 'teamThread' ? 'agent' : 'reply_queue',
			answers,
		});
	} catch {
		return { stored: 0 };
	}
}

/** Arm the draft's "remind me" follow-up at the date the reply promises. */
export async function armDraftFollowUp(
	ctx: MutationCtx,
	row: Doc<'answerAskSessions'>,
	remindAt: number
): Promise<void> {
	if (row.target.kind !== 'mailDraft') return;
	const draft = await ctx.db.get(row.target.draftId);
	if (!draft || draft.state !== 'draft') return;
	await ctx.db.patch(draft._id, { followUpRemindAt: remindAt, lastEditedAt: Date.now() });
}
