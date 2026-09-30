/**
 * Persistence for Answer mode ask sessions (`answerAskSessions`, see
 * schema/answerAsk.ts): the owner-scoped read the web subscribes to, and the
 * internal writers the Node action (mail/ai/composeDraft.ts) drives.
 *
 * Split from the action because a `'use node'` module may hold only actions.
 *
 * Privacy: a session belongs to the person who started it. `getSession` only
 * ever returns the caller's own row, and only while the caller can still reach
 * the target (the draft's mailbox, or the shared inbox for a team thread).
 * Every internal writer takes a session id and re-checks that the calling
 * identity owns it, so a forged id from one action cannot touch another
 * person's session.
 */

import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { postboxQuery } from '../_helpers';
import { requireMailboxAccess } from '../permissions';
import { isSharedInboxReader } from '../../inbox/access';
import { captureStandingAnswers } from '../../inbox/clarificationMemory';
import { requireOrgMember, type MutationSessionContext } from '../../lib/sessionOrganization';
import {
	answerAskStatusValidator,
	answerAskTargetKey,
	answerAskTargetValidator,
	type AnswerAskStatus,
	type AnswerAskTarget,
} from '../../lib/validators/answerAsk';
import {
	clarificationFileRefValidator,
	needsReplyClarificationQuestionValidator,
} from '../../lib/validators/clarification';
import { throwForbidden, throwNotFound } from '../../_utils/errors';
import {
	FILE_QUESTION_ID,
	FOLLOW_UP_QUESTION_ID,
	type AskFileRef,
	type AskQuestion,
} from './composeDraftPolicy';

/** What the web reads: the session without its internal bookkeeping. */
export interface AskSessionView {
	sessionId: Id<'answerAskSessions'>;
	target: AnswerAskTarget;
	status: AnswerAskStatus;
	round: number;
	questions: AskQuestion[];
	streamId?: Id<'aiDraftStreams'>;
	attachedFiles: AskFileRef[];
	followUpAt?: number;
	instruction?: string;
	locale: string;
	errorMessage?: string;
	updatedAt: number;
}

export function toAskSessionView(row: Doc<'answerAskSessions'>): AskSessionView {
	return {
		sessionId: row._id,
		target: row.target,
		status: row.status,
		round: row.round,
		questions: row.questions,
		...(row.streamId ? { streamId: row.streamId } : {}),
		attachedFiles: row.attachedFiles,
		...(row.followUpAt !== undefined ? { followUpAt: row.followUpAt } : {}),
		...(row.instruction !== undefined ? { instruction: row.instruction } : {}),
		locale: row.locale,
		...(row.errorMessage !== undefined ? { errorMessage: row.errorMessage } : {}),
		updatedAt: row.updatedAt,
	};
}

/**
 * Whether the caller can still reach a target: write the draft's mailbox, or
 * read the shared inbox for a team thread.
 */
async function canReachTarget(
	ctx: QueryCtx,
	target: AnswerAskTarget,
	session: MutationSessionContext
): Promise<boolean> {
	if (target.kind === 'teamThread') {
		return isSharedInboxReader(session) && (await ctx.db.get(target.threadId)) !== null;
	}
	const draft = await ctx.db.get(target.draftId);
	if (!draft) return false;
	return (await requireMailboxAccess(ctx, draft.mailboxId, 'member', session)).ok;
}

async function findOwnSession(
	ctx: QueryCtx,
	target: AnswerAskTarget,
	ownerId: string
): Promise<Doc<'answerAskSessions'> | null> {
	return await ctx.db
		.query('answerAskSessions')
		.withIndex('by_target_owner', (q) =>
			q.eq('targetKey', answerAskTargetKey(target)).eq('ownerId', ownerId)
		)
		.first();
}

/**
 * The caller's live ask session for a draft or team thread, or null. The web
 * subscribes to this while "Draft with AI" runs: the questions, the stream to
 * render and the files attached along the way.
 */
// all-members: owner-scoped read; the caller must also still reach the target (canReachTarget).
export const getSession = postboxQuery({
	args: { target: answerAskTargetValidator },
	handler: async (ctx, args, session): Promise<AskSessionView | null> => {
		const row = await findOwnSession(ctx, args.target, session.userId);
		if (!row) return null;
		if (!(await canReachTarget(ctx, args.target, session))) return null;
		return toAskSessionView(row);
	},
});

/** Delete a session and the draft stream it owns. */
async function deleteSessionRow(ctx: MutationCtx, row: Doc<'answerAskSessions'>): Promise<void> {
	if (row.streamId) {
		const stream = await ctx.db.get(row.streamId);
		if (stream && stream.ownerId === row.ownerId) await ctx.db.delete(row.streamId);
	}
	await ctx.db.delete(row._id);
}

/** Drop every ask session of a draft (discard, send). */
export async function deleteAskSessionsForDraft(
	ctx: MutationCtx,
	draftId: Id<'mailDrafts'>
): Promise<void> {
	const rows = await ctx.db
		.query('answerAskSessions')
		.withIndex('by_target_owner', (q) =>
			q.eq('targetKey', answerAskTargetKey({ kind: 'mailDraft', draftId }))
		)
		.take(20); // bounded: one session per person who drafted with AI on this draft
	for (const row of rows) await deleteSessionRow(ctx, row);
}

/**
 * Drop up to `limit` of a person's ask sessions (member erasure). Returns true
 * when more may remain, so the caller runs another batch.
 */
export async function deleteAskSessionsOfOwner(
	ctx: MutationCtx,
	ownerId: string,
	limit: number
): Promise<boolean> {
	const rows = await ctx.db
		.query('answerAskSessions')
		.withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
		.take(limit);
	for (const row of rows) await deleteSessionRow(ctx, row);
	return rows.length === limit;
}

/** Whether anyone started "Draft with AI" on this draft (the send guard's trigger). */
export async function draftHasAskSession(
	ctx: QueryCtx,
	draftId: Id<'mailDrafts'>
): Promise<boolean> {
	const row = await ctx.db
		.query('answerAskSessions')
		.withIndex('by_target_owner', (q) =>
			q.eq('targetKey', answerAskTargetKey({ kind: 'mailDraft', draftId }))
		)
		.first();
	return row !== null;
}

/** The session when the calling identity owns it; throws otherwise. */
async function requireOwnSession(
	ctx: QueryCtx,
	sessionId: Id<'answerAskSessions'>
): Promise<Doc<'answerAskSessions'>> {
	const session = await requireOrgMember(ctx);
	const row = await ctx.db.get(sessionId);
	if (!row) throwNotFound('Ask session');
	if (row.ownerId !== session.userId) throwForbidden('Not your ask session');
	if (!(await canReachTarget(ctx, row.target, session))) throwForbidden('Target not accessible');
	return row;
}

/** Load a session for the `answer` action (owner and target re-checked). */
export const getOwnSession = internalQuery({
	args: { sessionId: v.id('answerAskSessions') },
	handler: async (ctx, args) => await requireOwnSession(ctx, args.sessionId),
});

const sessionFields = {
	instruction: v.optional(v.string()),
	locale: v.string(),
	status: answerAskStatusValidator,
	questions: v.array(needsReplyClarificationQuestionValidator),
	attachedFiles: v.array(clarificationFileRefValidator),
	contactId: v.optional(v.id('contacts')),
	counterpartAddress: v.optional(v.string()),
	fileRequest: v.optional(v.object({ questionId: v.string(), label: v.string() })),
};

/**
 * Store a fresh session for the caller, replacing the caller's previous one on
 * the same target (one live session per target and person).
 */
export const replaceSession = internalMutation({
	args: { target: answerAskTargetValidator, ...sessionFields },
	handler: async (ctx, args): Promise<Doc<'answerAskSessions'>> => {
		const session = await requireOrgMember(ctx);
		if (!(await canReachTarget(ctx, args.target, session))) throwForbidden('Target not accessible');
		const previous = await findOwnSession(ctx, args.target, session.userId);
		if (previous) await deleteSessionRow(ctx, previous);
		const now = Date.now();
		const { target, ...fields } = args;
		const id = await ctx.db.insert('answerAskSessions', {
			ownerId: session.userId,
			organizationId: session.activeOrganizationId,
			target,
			targetKey: answerAskTargetKey(target),
			round: 1,
			...fields,
			createdAt: now,
			updatedAt: now,
		});
		return (await ctx.db.get(id))!;
	},
});

/** Update an owned session after answers or a finished draft. */
export const updateSession = internalMutation({
	args: {
		sessionId: v.id('answerAskSessions'),
		status: answerAskStatusValidator,
		round: v.optional(v.number()),
		questions: v.optional(v.array(needsReplyClarificationQuestionValidator)),
		attachedFiles: v.optional(v.array(clarificationFileRefValidator)),
		followUpAt: v.optional(v.number()),
		errorMessage: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Doc<'answerAskSessions'>> => {
		await requireOwnSession(ctx, args.sessionId);
		const { sessionId, ...patch } = args;
		await ctx.db.patch(sessionId, {
			...patch,
			...(args.status !== 'error' ? { errorMessage: undefined } : {}),
			updatedAt: Date.now(),
		});
		return (await ctx.db.get(sessionId))!;
	},
});

/**
 * Open a fresh `aiDraftStreams` buffer for the session (dropping the previous
 * one) and mark the session `drafting`, so the web switches to the stream the
 * moment the draft starts.
 */
export const openSessionStream = internalMutation({
	args: { sessionId: v.id('answerAskSessions') },
	handler: async (ctx, args): Promise<Id<'aiDraftStreams'>> => {
		const row = await requireOwnSession(ctx, args.sessionId);
		if (row.streamId) {
			const old = await ctx.db.get(row.streamId);
			if (old && old.ownerId === row.ownerId) await ctx.db.delete(row.streamId);
		}
		const now = Date.now();
		const streamId = await ctx.db.insert('aiDraftStreams', {
			ownerId: row.ownerId,
			surface: 'answer',
			status: 'streaming',
			text: '',
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(args.sessionId, {
			status: 'drafting',
			streamId,
			errorMessage: undefined,
			updatedAt: now,
		});
		return streamId;
	},
});

/**
 * Remember the owner's own answers per contact (inbox/clarificationMemory.ts),
 * so the next request pre-picks them as "last time". Only typed answers to the
 * slot questions: a file, the file question's "not ready" and the one-off
 * follow-up date are not standing facts. Fail-soft like every other capture.
 */
export const captureSessionAnswers = internalMutation({
	args: { sessionId: v.id('answerAskSessions'), questionIds: v.array(v.string()) },
	handler: async (ctx, args): Promise<{ stored: number }> => {
		const row = await requireOwnSession(ctx, args.sessionId);
		const wanted = new Set(args.questionIds);
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
	},
});

/** Arm the draft's "remind me" follow-up at the date the reply promises. */
export const setDraftFollowUp = internalMutation({
	args: { sessionId: v.id('answerAskSessions'), remindAt: v.number() },
	handler: async (ctx, args): Promise<void> => {
		const row = await requireOwnSession(ctx, args.sessionId);
		if (row.target.kind !== 'mailDraft') return;
		const draft = await ctx.db.get(row.target.draftId);
		if (!draft || draft.state !== 'draft') return;
		await ctx.db.patch(draft._id, { followUpRemindAt: args.remindAt, lastEditedAt: Date.now() });
	},
});
