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
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import type { Doc, Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { answerModeQuery } from '../_helpers';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { requireMailboxAccess } from '../permissions';
import { isSharedInboxReader } from '../../inbox/access';
import { captureStandingAnswers } from '../../inbox/clarificationMemory';
import { requireOrgMember, type MutationSessionContext } from '../../lib/sessionOrganization';
import {
	answerAskStatusValidator,
	answerAskTargetKey,
	answerAskTargetValidator,
	answerDraftContextValidator,
	type AnswerAskStatus,
	type AnswerAskTarget,
} from '../../lib/validators/answerAsk';
import {
	clarificationFileRefValidator,
	needsReplyClarificationQuestionValidator,
} from '../../lib/validators/clarification';
import { hasDraftGaps } from '@owlat/shared/answerMode';
import { throwForbidden, throwInvalidState, throwNotFound } from '../../_utils/errors';
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
	/**
	 * `drafting` WITHOUT a `streamId` means busy, not broken: `answer` has
	 * claimed the session and is still attaching file answers (or arming the
	 * follow-up) before it opens the stream. Show it as working; `streamId`
	 * appears the moment the draft starts streaming.
	 */
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
 * Whether the caller can still reach a target: write the draft's mailbox (the
 * mailbox gate includes the Postbox flag), or read the shared inbox for a team
 * thread with the team inbox switched on.
 */
async function canReachTarget(
	ctx: QueryCtx,
	target: AnswerAskTarget,
	session: MutationSessionContext
): Promise<boolean> {
	if (target.kind === 'teamThread') {
		return (
			isSharedInboxReader(session) &&
			(await isFeatureEnabled(ctx, 'inbox')) &&
			(await ctx.db.get(target.threadId)) !== null
		);
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
// all-members: owner-scoped read; the caller must also still reach the target (canReachTarget), which checks the target's own feature flag.
export const getSession = answerModeQuery({
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

/**
 * Rows read per transaction by every bulk walk of this table. A row can carry
 * the drafter's context (up to MAX_STORED_CONTEXT_CHARS, mail/ai/composeDraftLoad.ts),
 * so a batch stays far below the per-transaction read limit.
 */
const ASK_SESSION_BATCH = 16;

/** The refusal a second `answer` on an already claimed session gets. */
export function throwAskSessionClaimed(): never {
	throwInvalidState('These questions were already answered', { code: 'ASK_SESSION_CLAIMED' });
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
		.take(ASK_SESSION_BATCH); // bounded: one session per person who drafted with AI on this draft
	for (const row of rows) await deleteSessionRow(ctx, row);
}

/**
 * Drop one batch of a person's ask sessions (member erasure). Returns true
 * when more may remain, so the caller runs another batch.
 */
export async function deleteAskSessionsOfOwner(
	ctx: MutationCtx,
	ownerId: string
): Promise<boolean> {
	const rows = await ctx.db
		.query('answerAskSessions')
		.withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
		.take(ASK_SESSION_BATCH);
	for (const row of rows) await deleteSessionRow(ctx, row);
	return rows.length === ASK_SESSION_BATCH;
}

/** How long a session is kept: long past any draft someone is still writing. */
const ASK_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Retention for ask sessions (daily, maintenance/cronRegistration.ts). A
 * Postbox session goes with its draft on send or discard, but a team-thread
 * session has no such end, and either one holds text quoted from mail and the
 * owner's answers. Sessions started more than {@link ASK_SESSION_RETENTION_MS}
 * ago are deleted with their draft streams, except a Postbox session whose
 * draft still exists: its `[[gap]]` send guard lives on the session.
 *
 * Walks by creation time a bounded batch per run; `after` resumes past the
 * last row read (kept rows included), so a run of kept sessions cannot stall
 * the walk. A full batch schedules the next one.
 */
export const sweepStaleSessions = internalMutation({
	args: { after: v.optional(v.number()) },
	handler: async (ctx, args): Promise<{ deleted: number; kept: number }> => {
		const cutoff = Date.now() - ASK_SESSION_RETENTION_MS;
		const after = args.after;
		const rows = await ctx.db
			.query('answerAskSessions')
			.withIndex('by_creation_time', (q) =>
				after !== undefined
					? q.gt('_creationTime', after).lt('_creationTime', cutoff)
					: q.lt('_creationTime', cutoff)
			)
			.take(ASK_SESSION_BATCH);
		let deleted = 0;
		for (const row of rows) {
			if (row.target.kind === 'mailDraft' && (await ctx.db.get(row.target.draftId))) continue;
			await deleteSessionRow(ctx, row);
			deleted++;
		}
		const last = rows[rows.length - 1];
		if (rows.length === ASK_SESSION_BATCH && last) {
			await ctx.scheduler.runAfter(0, internal.mail.ai.composeDraftStore.sweepStaleSessions, {
				after: last._creationTime,
			});
		}
		return { deleted, kept: rows.length - deleted };
	},
});

/** Whether anyone started "Draft with AI" on this target (the send guards' trigger). */
async function targetHasAskSession(ctx: QueryCtx, target: AnswerAskTarget): Promise<boolean> {
	const row = await ctx.db
		.query('answerAskSessions')
		.withIndex('by_target_owner', (q) => q.eq('targetKey', answerAskTargetKey(target)))
		.first();
	return row !== null;
}

/**
 * The send guard of plan §05: an Answer mode "draft with gaps" marks each
 * missing fact `[[...]]`, and sending one would ship the marker to the
 * recipient, so a send is refused (`DRAFT_HAS_GAPS`) until the person fills or
 * deletes it. Only a target somebody drafted with AI on is checked: double
 * brackets in hand-written mail are not ours to block. Every send path of both
 * composers runs this (`mail/draftSend.ts`, the team inbox's approve and
 * follow-up).
 */
export async function assertNoAnswerGaps(
	ctx: QueryCtx,
	target: AnswerAskTarget,
	text: string | (() => Promise<string>)
): Promise<void> {
	if (!(await targetHasAskSession(ctx, target))) return;
	const body = typeof text === 'string' ? text : await text();
	if (hasDraftGaps(body)) {
		throwInvalidState('Fill in the highlighted gaps before sending', { code: 'DRAFT_HAS_GAPS' });
	}
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
	draftContext: v.optional(answerDraftContextValidator),
	timeZone: v.optional(v.string()),
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

/**
 * Update an owned session after answers or a finished draft. With
 * `expectStatus`, a compare-and-set: refused unless the row is still in that
 * status, so two `answer` calls racing on one session cannot both proceed.
 */
export const updateSession = internalMutation({
	args: {
		sessionId: v.id('answerAskSessions'),
		status: answerAskStatusValidator,
		expectStatus: v.optional(answerAskStatusValidator),
		round: v.optional(v.number()),
		questions: v.optional(v.array(needsReplyClarificationQuestionValidator)),
		attachedFiles: v.optional(v.array(clarificationFileRefValidator)),
		followUpAt: v.optional(v.number()),
		timeZone: v.optional(v.string()),
		errorMessage: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Doc<'answerAskSessions'>> => {
		const row = await requireOwnSession(ctx, args.sessionId);
		const { sessionId, expectStatus, ...patch } = args;
		if (expectStatus !== undefined && row.status !== expectStatus) throwAskSessionClaimed();
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
