/**
 * Member erasure — the ordered, budgeted steps that remove one account's
 * personal data, as declared in `relations.ts`, and the end-state check that
 * decides whether the erasure may be called complete.
 *
 * Every phase is idempotent and resumable: rows it deletes (or anonymizes)
 * leave the range it reads, parents go after their children, and the two
 * phases that page past rows they keep save a cursor on the job.
 */

import type { MutationCtx } from '../../_generated/server';
import type { ErasureBudget } from '../../contacts/erasure/budget';
import { isPersonalMailbox } from '../../mail/permissions';
import {
	MEMBER_ERASURE_PHASES,
	WORKSPACE_PHASES_FROM,
	type MemberErasurePhase,
} from './phaseCatalog';
import {
	eraseCredentials,
	eraseInvitations,
	eraseOAuthGrants,
	eraseSessions,
	eraseVerifications,
	remainingIdentityRows,
} from './identityPhases';
import {
	eraseDrafts,
	eraseExternalAccounts,
	eraseMailboxRecords,
	eraseMailboxRows,
	eraseMessages,
	eraseShares,
	eraseThreads,
	quiesceMailboxes,
} from './mailboxPhases';
import {
	eraseAccountExports,
	eraseAlertReceipts,
	eraseAlertRecipients,
	eraseAnswerAsk,
	eraseAssistant,
	eraseChatAuthorship,
	eraseChatMemberships,
	eraseChatMentions,
	eraseSavedReplyAuthorship,
	eraseInstanceRows,
	eraseMemberRecords,
	eraseNoteAuthorship,
	eraseNoteMentions,
	eraseSharedMemberships,
} from './memberPhases';
import type { MemberPhaseRunner } from './phaseKit';

const PHASE_RUNNERS: Record<MemberErasurePhase, MemberPhaseRunner> = {
	authSessions: eraseSessions,
	authCredentials: eraseCredentials,
	authOAuthGrants: eraseOAuthGrants,
	authVerifications: eraseVerifications,
	authInvitations: eraseInvitations,
	instanceRows: eraseInstanceRows,
	externalAccounts: eraseExternalAccounts,
	mailboxQuiesce: quiesceMailboxes,
	mailboxMessages: eraseMessages,
	mailboxThreads: eraseThreads,
	mailboxDrafts: eraseDrafts,
	mailboxShares: eraseShares,
	mailboxRecords: eraseMailboxRecords,
	mailboxRows: eraseMailboxRows,
	memberRecords: eraseMemberRecords,
	sharedMemberships: eraseSharedMemberships,
	assistant: eraseAssistant,
	answerAsk: eraseAnswerAsk,
	accountExports: eraseAccountExports,
	alertRecipients: eraseAlertRecipients,
	alertReceipts: eraseAlertReceipts,
	chatAuthorship: eraseChatAuthorship,
	chatMemberships: eraseChatMemberships,
	chatMentions: eraseChatMentions,
	savedReplyAuthorship: eraseSavedReplyAuthorship,
	noteAuthorship: eraseNoteAuthorship,
	noteMentions: eraseNoteMentions,
};

export const FIRST_MEMBER_ERASURE_PHASE: MemberErasurePhase = MEMBER_ERASURE_PHASES[0];

const WORKSPACE_PHASE_INDEX = MEMBER_ERASURE_PHASES.indexOf(WORKSPACE_PHASES_FROM);

export function isWorkspacePhase(phase: MemberErasurePhase): boolean {
	return MEMBER_ERASURE_PHASES.indexOf(phase) >= WORKSPACE_PHASE_INDEX;
}

export interface MemberErasureSubject {
	authUserId: string;
	email: string;
}

export type MemberErasureProgress =
	| { state: 'complete' }
	| { state: 'more'; phase: MemberErasurePhase; cursor: string | undefined }
	/** Stopped before a workspace phase while a workspace deletion runs. */
	| { state: 'waiting'; phase: MemberErasurePhase };

/**
 * Run one transaction's worth of the erasure: the phase at `from`, within
 * `budget`. A phase that finishes commits on its own before the next one
 * starts, so a phase that fails is the phase the job reports, and a retry
 * never redoes the phases before it.
 *
 * `isWorkspaceBeingDeleted` holds the walk before the first phase that touches
 * workspace tables: the sweep will erase them, and the write fence refuses the
 * anonymizing patches meanwhile. Waiting (rather than skipping) keeps the walk
 * correct if that deletion is aborted.
 */
export async function advanceMemberErasure(
	ctx: MutationCtx,
	subject: MemberErasureSubject,
	from: { phase: MemberErasurePhase; cursor: string | undefined },
	budget: ErasureBudget,
	isWorkspaceBeingDeleted: boolean
): Promise<MemberErasureProgress> {
	const { phase, cursor } = from;
	if (isWorkspaceBeingDeleted && isWorkspacePhase(phase)) return { state: 'waiting', phase };
	const outcome = await PHASE_RUNNERS[phase]({ ctx, ...subject, budget, cursor });
	if (!outcome.isDone) return { state: 'more', phase, cursor: outcome.cursor };
	const next = MEMBER_ERASURE_PHASES[MEMBER_ERASURE_PHASES.indexOf(phase) + 1];
	return next === undefined
		? { state: 'complete' }
		: { state: 'more', phase: next, cursor: undefined };
}

/**
 * The end-state check behind `completed`: what must be gone once every phase
 * has run. Returns the names of whatever is still there (empty when the
 * erasure is complete). A non-empty answer means a writer raced the walk; the
 * walker restarts the phases rather than report a false completion.
 */
export async function remainingMemberData(
	ctx: MutationCtx,
	subject: MemberErasureSubject
): Promise<string[]> {
	const { authUserId } = subject;
	const remaining = await remainingIdentityRows(ctx, authUserId);
	const probes: Array<[string, () => Promise<unknown>]> = [
		[
			'userProfiles',
			() =>
				ctx.db
					.query('userProfiles')
					.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
					.first(),
		],
		[
			'personal mailbox',
			async () =>
				(
					await ctx.db
						.query('mailboxes')
						.withIndex('by_user', (q) => q.eq('userId', authUserId))
						.collect()
				) // bounded: a user's own mailboxes
					.find(isPersonalMailbox) ?? null,
		],
		[
			'aiConversations',
			() =>
				ctx.db
					.query('aiConversations')
					.withIndex('by_owner_and_last_message', (q) => q.eq('ownerId', authUserId))
					.first(),
		],
		[
			'answerAskSessions',
			() =>
				ctx.db
					.query('answerAskSessions')
					.withIndex('by_owner', (q) => q.eq('ownerId', authUserId))
					.first(),
		],
		[
			'platformAdmins',
			() =>
				ctx.db
					.query('platformAdmins')
					.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
					.first(),
		],
		[
			'chatMessages',
			() =>
				ctx.db
					.query('chatMessages')
					.withIndex('by_author', (q) => q.eq('authorId', authUserId))
					.first(),
		],
		[
			'personal saved replies',
			() =>
				ctx.db
					.query('mailSnippets')
					.withIndex('by_owner', (q) => q.eq('ownerUserId', authUserId))
					.first(),
		],
		[
			'saved reply authorship',
			() =>
				ctx.db
					.query('mailSnippets')
					.withIndex('by_author', (q) => q.eq('authorUserId', authUserId))
					.first(),
		],
		[
			'threadNotes',
			() =>
				ctx.db
					.query('threadNotes')
					.withIndex('by_author', (q) => q.eq('authorId', authUserId))
					.first(),
		],
	];
	for (const [name, probe] of probes) {
		if ((await probe()) !== null) remaining.push(name);
	}
	return remaining;
}
