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
 * What the drafter needs about a target, built once by `start` and kept on the
 * session so `answer` does not rebuild it (for a team thread that is the whole
 * pipeline briefing, with its knowledge and file searches). `context` is the
 * untrusted thread text as the drafter reads it; the rest is the voice and
 * house style the prompt is written in.
 */
export const answerDraftContextValidator = v.object({
	context: v.string(),
	audience: v.string(),
	styleReference: v.string(),
	toneInstruction: v.string(),
	signatureInstruction: v.string(),
	voiceSection: v.string(),
	// The contact's language (ISO code); the reply is written in it.
	language: v.optional(v.string()),
});

export type AnswerDraftContext = Infer<typeof answerDraftContextValidator>;

/**
 * Whose mail an AUTOMATIC mailbox attachment search may look at: the reply's
 * own thread, and mail from or to the people the reply answers. A person's
 * explicit pick (`mail.drafts.attachExisting`) is not limited this way.
 */
export const mailboxAttachmentScopeValidator = v.object({
	mailboxId: v.id('mailboxes'),
	threadId: v.optional(v.id('mailThreads')),
	// Lowercased bare addresses of the counterpart (sender, reply-to).
	counterparts: v.array(v.string()),
});

export type MailboxAttachmentScope = Infer<typeof mailboxAttachmentScopeValidator>;

/**
 * One string per target, indexed, so "the live session of this draft" is a
 * point read whichever kind of target it is.
 */
export function answerAskTargetKey(target: AnswerAskTarget): string {
	return target.kind === 'mailDraft'
		? `mailDraft:${target.draftId}`
		: `teamThread:${target.threadId}`;
}
