/**
 * The one commit of each Answer mode action (mail/ai/composeDraft.ts): what
 * `start` decided from its gap check, and what `answer` made of the owner's
 * answers, each written in a single transaction that re-checks the session
 * first. Split from the action because a `'use node'` module may hold only
 * actions, and from the store to keep both files small.
 */

import { v, type Infer } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { requireOrgMember, type MutationSessionContext } from '../../lib/sessionOrganization';
import { answerAskStatusValidator, answerAskTargetValidator } from '../../lib/validators/answerAsk';
import {
	clarificationFileRefValidator,
	needsReplyClarificationQuestionValidator,
} from '../../lib/validators/clarification';
import { throwInvalidInput } from '../../_utils/errors';
import { attachUploadToDraft } from '../draftAttachUpload';
import { replaceOwnSession, requireOwnSession, sessionFields } from './composeDraftStore';
import { armDraftFollowUp, captureOwnAnswers } from './composeDraftAnswerWrites';

/** A fresh upload a file answer puts on the draft, in the answer's commit. */
export const pendingUploadValidator = v.object({
	storageId: v.id('_storage'),
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
});

/**
 * Put each pending upload on the session's draft. A team thread attaches
 * nothing here (the web attaches through the team inbox's reply), so it
 * passes none. A refused upload throws and the whole commit goes with it.
 */
async function attachUploads(
	ctx: MutationCtx,
	session: MutationSessionContext,
	row: Doc<'answerAskSessions'>,
	uploads: ReadonlyArray<Infer<typeof pendingUploadValidator>>
): Promise<void> {
	if (row.target.kind !== 'mailDraft' || uploads.length === 0) return;
	for (const upload of uploads) {
		await attachUploadToDraft(ctx, session, { draftId: row.target.draftId, ...upload });
	}
}

/**
 * The session's file references, checked against the draft once this commit's
 * uploads are on it. An upload the session already held (sent again after a
 * draft that failed) may have been removed from the draft since, its blob
 * with it: one this answer names is refused, so the owner uploads it again,
 * and one it no longer names is dropped, so the drafter is never told a
 * removed file is attached.
 */
async function liveAttachedFiles(
	ctx: MutationCtx,
	row: Doc<'answerAskSessions'>,
	args: Pick<Doc<'answerAskSessions'>, 'questions' | 'attachedFiles'> & {
		answeredIds: readonly string[];
	}
): Promise<Doc<'answerAskSessions'>['attachedFiles']> {
	if (row.target.kind !== 'mailDraft') return args.attachedFiles;
	const draft = await ctx.db.get(row.target.draftId);
	const onDraft = new Set<string>(draft?.attachments.map((a) => a.storageId) ?? []);
	const named = new Set(
		args.questions.flatMap((q) =>
			args.answeredIds.includes(q.id) && q.answer?.file ? [q.answer.file.id] : []
		)
	);
	return args.attachedFiles.filter((f) => {
		if (f.source !== 'upload' || onDraft.has(f.id)) return true;
		if (named.has(f.id)) {
			throwInvalidInput(`${f.filename} is no longer on the draft. Upload it again.`);
		}
		return false;
	});
}

/** Write the follow-up the reply promises: on the session, and armed on the draft. */
async function setFollowUp(
	ctx: MutationCtx,
	row: Doc<'answerAskSessions'>,
	followUpAt: number
): Promise<void> {
	await ctx.db.patch(row._id, { followUpAt, updatedAt: Date.now() });
	await armDraftFollowUp(ctx, row, followUpAt);
}

/**
 * `start`'s commit: the caller's fresh session (replacing their previous one
 * on the target), and, for a session that drafts at once, the follow-up its
 * questions already promise.
 */
export const commitStart = internalMutation({
	args: {
		target: answerAskTargetValidator,
		...sessionFields,
		followUpAt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<Doc<'answerAskSessions'>> => {
		const { followUpAt, ...fields } = args;
		const row = await replaceOwnSession(ctx, await requireOrgMember(ctx), fields);
		if (followUpAt !== undefined && row.status === 'drafting') {
			await setFollowUp(ctx, row, followUpAt);
		}
		return (await ctx.db.get(row._id))!;
	},
});

/**
 * `answer`'s commit, under the claim it took (`drafting`): the uploads its
 * file answers put on the draft (checking it still has the ones the session
 * already held), the answered questions (and round 2, back to
 * `asking`), the standing answers remembered for the contact, and the
 * follow-up the reply promises. A session no longer `drafting` was taken from
 * under this run: nothing is written and `claimed` comes back.
 */
export const commitAnswers = internalMutation({
	args: {
		sessionId: v.id('answerAskSessions'),
		status: answerAskStatusValidator,
		round: v.number(),
		questions: v.array(needsReplyClarificationQuestionValidator),
		attachedFiles: v.array(clarificationFileRefValidator),
		timeZone: v.optional(v.string()),
		uploads: v.array(pendingUploadValidator),
		answeredIds: v.array(v.string()),
		followUpAt: v.optional(v.number()),
	},
	handler: async (
		ctx,
		args
	): Promise<
		{ outcome: 'committed'; session: Doc<'answerAskSessions'> } | { outcome: 'claimed' }
	> => {
		const row = await requireOwnSession(ctx, args.sessionId);
		if (row.status !== 'drafting') return { outcome: 'claimed' };
		await attachUploads(ctx, await requireOrgMember(ctx), row, args.uploads);
		const attachedFiles = await liveAttachedFiles(ctx, row, args);
		await ctx.db.patch(row._id, {
			status: args.status,
			round: args.round,
			questions: args.questions,
			attachedFiles,
			...(args.timeZone ? { timeZone: args.timeZone } : {}),
			errorMessage: undefined,
			updatedAt: Date.now(),
		});
		const updated = (await ctx.db.get(row._id))!;
		if (args.answeredIds.length > 0) await captureOwnAnswers(ctx, updated, args.answeredIds);
		if (args.followUpAt !== undefined && args.status === 'drafting') {
			await setFollowUp(ctx, updated, args.followUpAt);
		}
		return { outcome: 'committed', session: (await ctx.db.get(row._id))! };
	},
});
