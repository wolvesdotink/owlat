/**
 * Answer mode "Draft with AI that asks first": the composer target a session
 * belongs to and the session's lifecycle.
 *
 * A session hangs off either a Postbox draft (`mailDraft`) or a team-inbox
 * conversation (`teamThread`, the id `pages/dashboard/inbox/[threadId].vue`
 * uses). The same shape is the argument of `mail.ai.composeDraftStore.getSession`
 * and `mail.ai.composeDraft.start`, so the web names a target one way.
 */

import { v, type Infer } from 'convex/values';

export const answerAskTargetValidator = v.union(
	v.object({ kind: v.literal('mailDraft'), draftId: v.id('mailDrafts') }),
	v.object({ kind: v.literal('teamThread'), threadId: v.id('conversationThreads') })
);

export type AnswerAskTarget = Infer<typeof answerAskTargetValidator>;

/**
 * `asking`: questions are waiting for the owner. `drafting`: the draft is
 * streaming into `streamId`. `ready`: the stream finished. `error`: drafting
 * failed; the composer keeps whatever the person already had.
 */
export const answerAskStatusValidator = v.union(
	v.literal('asking'),
	v.literal('drafting'),
	v.literal('ready'),
	v.literal('error')
);

export type AnswerAskStatus = Infer<typeof answerAskStatusValidator>;

/**
 * One string per target, indexed, so "the live session of this draft" is a
 * point read whichever kind of target it is.
 */
export function answerAskTargetKey(target: AnswerAskTarget): string {
	return target.kind === 'mailDraft'
		? `mailDraft:${target.draftId}`
		: `teamThread:${target.threadId}`;
}
