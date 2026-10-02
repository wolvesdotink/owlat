/**
 * The member's rows outside their personal mailboxes: instance-level rows,
 * everything keyed by their user id in the workspace, memberships on other
 * people's shared mailboxes, the private assistant and Answer mode ask
 * sessions, staged exports, and the organization's records that name them
 * (anonymized, not deleted).
 *
 * Each phase drains an index range that its own writes empty (a delete, or a
 * patch of the indexed field), so it resumes by reading the range again.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import { drainEach, drainParents } from '../../contacts/erasure/phaseKit';
import {
	DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT,
	boundedDeliverabilityAlertRecipientRows,
	deliverabilityAlertNotificationPatch,
} from '../../delivery/checklistAlertRecipients';
import { isPersonalMailbox } from '../../mail/permissions';
import { deleteMemberInstanceRows } from '../memberInstanceRows';
import { deleteRanges } from './mailboxPhases';
import {
	DELETED_ACCOUNT_ID,
	deleteAskSession,
	deleteBlobAndReceipt,
	type MemberPhaseOutcome,
	type MemberPhaseRunner,
} from './phaseKit';

/**
 * Rows keyed by the user id in tables no workspace deletion sweeps: the
 * onboarding checklists, send-ready notices and the platform-admin grant
 * (deployment-level power that must not outlive the person).
 */
export const eraseInstanceRows: MemberPhaseRunner = async ({ ctx, authUserId, budget }) => {
	await deleteMemberInstanceRows(ctx, authUserId);
	const isEmpty = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('onboardingProgress')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.take(n),
		(row) => ctx.db.delete(row._id)
	);
	budget.chargeRows(1);
	return { isDone: isEmpty };
};

/**
 * Everything else keyed by the user id: app passwords, the admin-request
 * queues (they carry the email, name and a free-text note), Today state and
 * the thread-visit log (reading history), mail settings, dashboard layout,
 * inbox presence, read markers and assignment notices, OAuth handshakes in
 * flight, leftover draft-revise buffers, mailbox moves, personal saved
 * replies, and mailbox
 * reservations the member accepted but the domain never activated (the
 * activation sweep would otherwise provision a mailbox for the erased id).
 */
export const eraseMemberRecords: MemberPhaseRunner = async (phase) => {
	const { ctx, authUserId: uid, budget } = phase;
	const isEmpty = await deleteRanges(phase, [
		(n) =>
			ctx.db
				.query('mailAppPasswords')
				.withIndex('by_user', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('mailboxRequests')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('accessRequests')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('mailThreadVisits')
				.withIndex('by_user_and_thread', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('todayStates')
				.withIndex('by_user_and_organization', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('mailUserSettings')
				.withIndex('by_user', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('dashboardLayouts')
				.withIndex('by_user', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('threadPresence')
				.withIndex('by_user', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('threadReads')
				.withIndex('by_user_thread', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('inboxAssignmentNotices')
				.withIndex('by_user_and_created', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('externalMailOAuthStates')
				.withIndex('by_user', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('aiDraftStreams')
				.withIndex('by_owner', (q) => q.eq('ownerId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('mailboxMoves')
				.withIndex('by_user', (q) => q.eq('userId', uid))
				.take(n),
		(n) =>
			ctx.db
				.query('mailSnippets')
				.withIndex('by_owner', (q) => q.eq('ownerUserId', uid))
				.take(n),
	]);
	if (!isEmpty) return { isDone: false };

	const reservations = await ctx.db
		.query('pendingMailboxes')
		.withIndex('by_invitee_email', (q) => q.eq('inviteeEmail', phase.email.toLowerCase()))
		.collect(); // bounded: reservations for one address, rarely more than one
	for (const reservation of reservations) {
		budget.chargeRead(reservation);
		if (reservation.acceptedByUserId !== uid) continue;
		await ctx.db.delete(reservation._id);
		budget.chargeRows(1);
	}
	return { isDone: true };
};

/**
 * The member's grants on OTHER people's shared mailboxes, and the personal
 * greeting cards they had there. Their own personal mailbox's grants went with
 * it. EXCEPTION: the `owner` row on a team inbox or seed they still canonically
 * own stays — that mailbox is org infrastructure kept on purpose, and dropping
 * its owner row would orphan it (no owner in `listShared`, no reassignment
 * anchor).
 */
export const eraseSharedMemberships: MemberPhaseRunner = async (phase) => {
	const { ctx, authUserId, budget } = phase;
	const memberships = await ctx.db
		.query('mailboxMembers')
		.withIndex('by_user', (q) => q.eq('authUserId', authUserId))
		.collect(); // bounded: shared mailboxes one user belongs to
	for (const row of memberships) {
		if (budget.isExhausted) return { isDone: false };
		budget.chargeRead(row);
		const isCardsEmpty = await deleteRanges(phase, [
			(n) =>
				ctx.db
					.query('mailBriefCards')
					.withIndex('by_mailbox_and_user', (q) =>
						q.eq('mailboxId', row.mailboxId).eq('userId', authUserId)
					)
					.take(n),
		]);
		if (!isCardsEmpty) return { isDone: false };
		if (row.role === 'owner') {
			const owned = await ctx.db.get(row.mailboxId);
			if (owned) budget.chargeRead(owned);
			if (owned && !isPersonalMailbox(owned) && owned.userId === authUserId) continue;
		}
		await ctx.db.delete(row._id);
		budget.chargeRows(1);
	}
	return { isDone: true };
};

/**
 * The private assistant: every conversation the member owns, including ones
 * they soft-deleted, each after its turns. A runner still streaming a reply
 * only ever patches its own turn by id and stops when the row is gone, so it
 * cannot write the transcript back.
 */
export const eraseAssistant: MemberPhaseRunner = async (phase) => {
	const { ctx, authUserId, budget } = phase;
	return drainParents(
		budget,
		() =>
			ctx.db
				.query('aiConversations')
				.withIndex('by_owner_and_last_message', (q) => q.eq('ownerId', authUserId))
				.first(),
		async (conversation: Doc<'aiConversations'>) => {
			const isEmpty = await deleteRanges(phase, [
				(n) =>
					ctx.db
						.query('aiMessages')
						.withIndex('by_conversation_and_created', (q) =>
							q.eq('conversationId', conversation._id)
						)
						.take(n),
			]);
			if (!isEmpty) return false;
			await ctx.db.delete(conversation._id);
			return true;
		}
	);
};

/**
 * The member's Answer mode ask sessions on any target: their instruction and
 * answers, and thread text quoted for the drafter. A session is private to its
 * owner whatever it drafts for, so the member's go from team threads and
 * shared mailboxes too (those on a personal draft already went with it);
 * another member's session on the same target stays. Each goes with the draft
 * stream it opened.
 */
export const eraseAnswerAsk: MemberPhaseRunner = async (phase) => ({
	isDone: await drainEach(
		phase.budget,
		(n) =>
			phase.ctx.db
				.query('answerAskSessions')
				.withIndex('by_owner', (q) => q.eq('ownerId', phase.authUserId))
				.take(n),
		(session) => deleteAskSession(phase, session)
	),
});

/** Staged account-export sessions: their download leases, then artifacts and their files. */
export const eraseAccountExports: MemberPhaseRunner = async (phase) => {
	const { ctx, authUserId, budget } = phase;
	return drainParents(
		budget,
		() =>
			ctx.db
				.query('accountExportSessions')
				.withIndex('by_user_and_expires_at', (q) => q.eq('userId', authUserId))
				.first(),
		async (session: Doc<'accountExportSessions'>) => {
			const isLeasesEmpty = await deleteRanges(phase, [
				(n) =>
					ctx.db
						.query('accountExportArtifactLeases')
						.withIndex('by_session', (q) => q.eq('sessionId', session._id))
						.take(n),
			]);
			if (!isLeasesEmpty) return false;
			const isArtifactsEmpty = await drainEach(
				budget,
				(n) =>
					ctx.db
						.query('accountExportArtifacts')
						.withIndex('by_session_and_key', (q) => q.eq('sessionId', session._id))
						.take(n),
				async (artifact) => {
					await deleteBlobAndReceipt(phase, artifact.storageId, { artifactId: artifact._id });
					await ctx.db.delete(artifact._id);
				}
			);
			if (!isArtifactsEmpty) return false;
			await ctx.db.delete(session._id);
			return true;
		}
	);
};

/**
 * Deliverability-alert recipient rows: the organization's notification ledger
 * keeps the row with the id anonymized; a notification still owed to the
 * member is cancelled, and one mid-send is closed as an unknown outcome. The
 * alert's summary is recomputed from its (bounded) ledger right after, so one
 * recipient is handled per step.
 */
export const eraseAlertRecipients: MemberPhaseRunner = async ({ ctx, authUserId, budget }) =>
	drainParents(
		budget,
		() =>
			ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.first(),
		async (recipient: Doc<'deliverabilityAlertRecipients'>) => {
			await ctx.db.patch(recipient._id, {
				userId: DELETED_ACCOUNT_ID,
				...(recipient.status === 'pending'
					? { status: 'cancelled' as const, nextAttemptAt: undefined }
					: recipient.status === 'sending'
						? {
								status: 'unavailable' as const,
								unavailableReason: 'transport_outcome_unknown' as const,
								attemptToken: undefined,
								attemptStartedAt: undefined,
								nextAttemptAt: undefined,
							}
						: {}),
			});
			await refreshAlertSummary(ctx, recipient.alertId, (doc) => budget.chargeRead(doc));
			return true;
		}
	);

async function refreshAlertSummary(
	ctx: Parameters<MemberPhaseRunner>[0]['ctx'],
	alertId: Id<'deliverabilityRegressionAlerts'>,
	onRead: (doc: unknown) => void
): Promise<void> {
	const alert = await ctx.db.get(alertId);
	if (!alert) return;
	onRead(alert);
	const rows = await ctx.db
		.query('deliverabilityAlertRecipients')
		.withIndex('by_alert', (q) => q.eq('alertId', alertId))
		.take(DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT + 1);
	for (const row of rows) onRead(row);
	await ctx.db.patch(
		alert._id,
		deliverabilityAlertNotificationPatch(
			boundedDeliverabilityAlertRecipientRows(rows),
			alert.compactedRecipientOutcomes
		)
	);
}

/** Compacted terminal alert receipts: the id is anonymized, the outcome kept. */
export const eraseAlertReceipts: MemberPhaseRunner = async ({ ctx, authUserId, budget }) => ({
	isDone: await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('deliverabilityAlertRecipientReceipts')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.take(n),
		(receipt) => ctx.db.patch(receipt._id, { userId: DELETED_ACCOUNT_ID })
	),
});

/**
 * Team-chat messages the member wrote: the room conversation keeps its flow,
 * the authorship goes ('[deleted account]'). The patch moves each row out of
 * the author index range, so the range drains like a delete.
 */
export const eraseChatAuthorship: MemberPhaseRunner = async ({ ctx, authUserId, budget }) => ({
	isDone: await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('chatMessages')
				.withIndex('by_author', (q) => q.eq('authorId', authUserId))
				.take(n),
		(message) => ctx.db.patch(message._id, { authorId: DELETED_ACCOUNT_ID })
	),
});

export const eraseChatMemberships: MemberPhaseRunner = async (
	phase
): Promise<MemberPhaseOutcome> => ({
	isDone: await deleteRanges(phase, [
		(n) =>
			phase.ctx.db
				.query('chatRoomMembers')
				.withIndex('by_member', (q) => q.eq('memberId', phase.authUserId))
				.take(n),
	]),
});

/** Mentions of the member (their unread markers). */
export const eraseChatMentions: MemberPhaseRunner = async (phase): Promise<MemberPhaseOutcome> => ({
	isDone: await deleteRanges(phase, [
		(n) =>
			phase.ctx.db
				.query('chatMentions')
				.withIndex('by_mentioned_unread', (q) => q.eq('mentionedMemberId', phase.authUserId))
				.take(n),
	]),
});

/**
 * Shared saved replies the member wrote stay with the organization; who wrote
 * them goes. The patch moves each row out of the author index range, so the
 * range drains like a delete.
 */
export const eraseSavedReplyAuthorship: MemberPhaseRunner = async ({
	ctx,
	authUserId,
	budget,
}) => ({
	isDone: await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('mailSnippets')
				.withIndex('by_author', (q) => q.eq('authorUserId', authUserId))
				.take(n),
		(reply) => ctx.db.patch(reply._id, { authorUserId: undefined })
	),
});
