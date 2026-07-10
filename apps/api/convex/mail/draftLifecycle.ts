/**
 * Mail draft lifecycle (module) — single writer of `mailDrafts.state`,
 * `scheduledSendAt`, `undoToken`, and the multi-table send-success cascade.
 *
 * Owns the three-state machine `draft → pending_send | scheduled → draft (revert) |
 * sent (terminal, deletes the row)`. Three entry points: `create` (initial
 * insert), `transition` (direct, by draftId), and `transitionByUndoToken`
 * (undo-button path keyed by `undoToken`). Reducers return { patch, effects,
 * applied }; the runner is the only place that touches the DB or the
 * scheduler.
 *
 * Effects per transition kind:
 *   → pending_send / scheduled:
 *     - schedule_dispatch_action       — schedules mail.outbound.dispatchDraft
 *     - audit_log('postbox_draft.send_initiated')
 *   → draft (revert):
 *     - audit_log(<reason-specific literal>)
 *   → sent (terminal):
 *     - insert_mail_message            — new mailMessages row in Sent
 *     - patch_sent_folder              — uidNext / modseq / totalCount
 *     - patch_thread                   — messageCount / lastMessageAt / ...
 *     - patch_in_reply_to_flag         — flagAnswered: true (if applicable)
 *     - patch_mailbox_bytes            — usedBytes += rawSize
 *     - delete_attachment_storage      — frees the draft's attachment blobs
 *     - record_recipients_in_address_book
 *     - delete_draft_row               — terminal row delete
 *     - audit_log('postbox_draft.sent')
 *
 * See docs/adr/0028-mail-draft-lifecycle-module.md.
 */

import { v } from 'convex/values';
import { mailMessageAttachmentValidator } from '../lib/convexValidators';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog } from '../lib/auditLog';
import { isSanctionedSendAsForUser } from './identities';
import { followUpWaitingOn } from './followUps';
import { logError } from '../lib/runtimeLog';
import { normalizeSubject } from '../lib/emailAddress';

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_UNDO_SEND_DELAY_MS = 30_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type DraftState = 'draft' | 'pending_send' | 'scheduled';

export type RevertReason = 'user_cancel' | 'from_revoked' | 'scan_blocked';

export interface SentInputContext {
	rawStorageId: Id<'_storage'>;
	rawSize: number;
	rfc822MessageId: string;
	inReplyToHeaderValue?: string;
	references: string[];
	bodyHtml: string;
	bodyText?: string;
	attachmentsMeta: Array<{
		filename: string;
		contentType: string;
		size: number;
		contentId?: string;
		partIndex: string;
	}>;
}

export type TransitionInput =
	| { to: 'pending_send'; at: number; undoSendDelayMs?: number }
	| { to: 'scheduled'; at: number; scheduledSendAt: number }
	| { to: 'draft'; at: number; reason: RevertReason }
	| { to: 'sent'; at: number; context: SentInputContext };

export type TransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			draftId: Id<'mailDrafts'>;
			from: DraftState;
			to: TransitionInput['to'];
			// Populated for `→ pending_send` / `→ scheduled` so the caller can
			// hand back the undo handle to the user.
			undoToken?: string;
			sendAt?: number;
			// Populated for `→ sent` so callers (the dispatcher) can chain
			// per-recipient MTA POSTs against the new row.
			messageId?: Id<'mailMessages'>;
	  }
	| {
			ok: false;
			reason:
				| 'draft_not_found'
				| 'illegal_edge'
				| 'no_recipients'
				| 'from_revoked'
				| 'undo_token_mismatch'
				| 'already_draft'
				| 'sent_folder_missing';
			draftId?: Id<'mailDrafts'>;
			from?: DraftState;
			to?: TransitionInput['to'];
	  };

// ─── Validators ─────────────────────────────────────────────────────────────

const sentInputContextValidator = v.object({
	rawStorageId: v.id('_storage'),
	rawSize: v.number(),
	rfc822MessageId: v.string(),
	inReplyToHeaderValue: v.optional(v.string()),
	references: v.array(v.string()),
	bodyHtml: v.string(),
	bodyText: v.optional(v.string()),
	attachmentsMeta: v.array(mailMessageAttachmentValidator),
});

const transitionInputValidator = v.union(
	v.object({
		to: v.literal('pending_send'),
		at: v.number(),
		undoSendDelayMs: v.optional(v.number()),
	}),
	v.object({
		to: v.literal('scheduled'),
		at: v.number(),
		scheduledSendAt: v.number(),
	}),
	v.object({
		to: v.literal('draft'),
		at: v.number(),
		reason: v.union(v.literal('user_cancel'), v.literal('from_revoked'), v.literal('scan_blocked')),
	}),
	v.object({
		to: v.literal('sent'),
		at: v.number(),
		context: sentInputContextValidator,
	})
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────

const LEGAL_EDGES: Record<DraftState, ReadonlySet<TransitionInput['to']>> = {
	draft: new Set<TransitionInput['to']>(['pending_send', 'scheduled']),
	pending_send: new Set<TransitionInput['to']>(['draft', 'sent']),
	scheduled: new Set<TransitionInput['to']>(['draft', 'sent']),
};

// ─── State-guard helper ─────────────────────────────────────────────────────

/**
 * Centralized state-precondition assertion. Replaces six open-coded
 * `state !== 'X'` checks scattered across mail/drafts.ts and the old
 * outboundQueries.ts. Throws so the call site keeps its `throw new Error(...)`
 * surface — callers that want a soft outcome should use `transition` instead.
 */
export function assertStateIs(draft: Doc<'mailDrafts'>, state: DraftState): void {
	if (draft.state !== state) {
		throw new Error(`Draft state is ${draft.state}, expected ${state}`);
	}
}

// ─── Recipient helper ───────────────────────────────────────────────────────

/**
 * Lower-cased, de-duplicated union of a draft's to/cc/bcc addresses. The same
 * recipient set feeds the address-book record, the audit-log recipientCount,
 * and the new mailMessages row's outbound.recipients[].
 */
export function dedupedRecipients(draft: Doc<'mailDrafts'>): string[] {
	return [
		...draft.toAddresses.map((s) => s.toLowerCase()),
		...draft.ccAddresses.map((s) => s.toLowerCase()),
		...draft.bccAddresses.map((s) => s.toLowerCase()),
	].filter((addr, i, arr) => arr.indexOf(addr) === i);
}

// ─── Effects ────────────────────────────────────────────────────────────────

type AuditLogEffect = {
	kind: 'audit_log';
	action:
		| 'postbox_draft.send_initiated'
		| 'postbox_draft.sent'
		| 'postbox_draft.cancelled'
		| 'postbox_draft.from_revoked'
		| 'postbox_draft.scan_blocked';
	draftId: Id<'mailDrafts'>;
	mailboxId: Id<'mailboxes'>;
	details: Record<string, string | number | boolean>;
};

type Effect =
	| {
			kind: 'schedule_dispatch_action';
			draftId: Id<'mailDrafts'>;
			undoToken: string;
			sendAt: number;
	  }
	| AuditLogEffect
	| {
			kind: 'delete_attachment_storage';
			storageIds: ReadonlyArray<Id<'_storage'>>;
	  }
	| {
			kind: 'record_recipients_in_address_book';
			mailboxId: Id<'mailboxes'>;
			emails: ReadonlyArray<string>;
	  }
	| {
			// Edit-learning flywheel: the sent draft carried an AI baseline, so
			// diff baseline → sent out of band and fold the delta into the voice
			// profile / per-contact memory (mail/editLearning.ts). Fire-and-forget;
			// never blocks the send.
			kind: 'schedule_edit_learning';
			mailboxId: Id<'mailboxes'>;
			contactAddress?: string;
			baselineText: string;
			sentText: string;
	  };

type ReducerResult = {
	patch: Partial<Doc<'mailDrafts'>>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
	extras?: {
		undoToken?: string;
		sendAt?: number;
		// Only set on the `→ sent` reducer's result; the runner inserts the
		// mailMessages row and threads the id back into the outcome.
		sentContext?: SentInputContext;
	};
};

// ─── Reducers ───────────────────────────────────────────────────────────────
//
// Reducers do not touch the DB or the scheduler. They return the patch +
// effect list; the runner applies the patch first, then dispatches effects.
// Validation that depends on freshly-read DB state (e.g. the from-address
// allow-set re-check inside `→ sent`) happens in the dispatcher BEFORE the
// reducer fires.

function generateUndoToken(at: number): string {
	return `und_${at.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function reducePendingSend(
	draft: Doc<'mailDrafts'>,
	args: Extract<TransitionInput, { to: 'pending_send' }>
): ReducerResult {
	const delay = Math.max(0, args.undoSendDelayMs ?? DEFAULT_UNDO_SEND_DELAY_MS);
	const sendAt = args.at + delay;
	const undoToken = generateUndoToken(args.at);
	return {
		patch: {
			state: 'pending_send',
			scheduledSendAt: sendAt,
			undoToken,
			lastEditedAt: args.at,
		},
		effects: [
			{
				kind: 'schedule_dispatch_action',
				draftId: draft._id,
				undoToken,
				sendAt,
			},
			{
				kind: 'audit_log',
				action: 'postbox_draft.send_initiated',
				draftId: draft._id,
				mailboxId: draft.mailboxId,
				details: {
					sendAt,
					undoSendDelayMs: delay,
					mode: 'pending_send',
				},
			},
		],
		applied: 'transitioned',
		extras: { undoToken, sendAt },
	};
}

function reduceScheduled(
	draft: Doc<'mailDrafts'>,
	args: Extract<TransitionInput, { to: 'scheduled' }>
): ReducerResult {
	const undoToken = generateUndoToken(args.at);
	return {
		patch: {
			state: 'scheduled',
			scheduledSendAt: args.scheduledSendAt,
			undoToken,
			lastEditedAt: args.at,
		},
		effects: [
			{
				kind: 'schedule_dispatch_action',
				draftId: draft._id,
				undoToken,
				sendAt: args.scheduledSendAt,
			},
			{
				kind: 'audit_log',
				action: 'postbox_draft.send_initiated',
				draftId: draft._id,
				mailboxId: draft.mailboxId,
				details: {
					sendAt: args.scheduledSendAt,
					mode: 'scheduled',
				},
			},
		],
		applied: 'transitioned',
		extras: { undoToken, sendAt: args.scheduledSendAt },
	};
}

const REVERT_AUDIT_ACTION: Record<RevertReason, AuditLogEffect['action']> = {
	user_cancel: 'postbox_draft.cancelled',
	from_revoked: 'postbox_draft.from_revoked',
	scan_blocked: 'postbox_draft.scan_blocked',
};

function reduceDraftRevert(
	draft: Doc<'mailDrafts'>,
	args: Extract<TransitionInput, { to: 'draft' }>
): ReducerResult {
	return {
		patch: {
			state: 'draft',
			scheduledSendAt: undefined,
			undoToken: undefined,
			lastEditedAt: args.at,
		},
		effects: [
			{
				kind: 'audit_log',
				action: REVERT_AUDIT_ACTION[args.reason],
				draftId: draft._id,
				mailboxId: draft.mailboxId,
				details: {
					reason: args.reason,
					fromState: draft.state,
				},
			},
		],
		applied: 'transitioned',
	};
}

function reduceSent(
	draft: Doc<'mailDrafts'>,
	args: Extract<TransitionInput, { to: 'sent' }>
): ReducerResult {
	const recipients = dedupedRecipients(draft);

	// Edit-learning flywheel: only when this draft was AI-authored (has a
	// baseline) AND the user actually changed something before sending. The diff
	// itself + recurrence gating happen out of band in mail/editLearning.ts.
	const baselineText = draft.aiDraftBaseline?.text?.trim() ?? '';
	// `||` (not `??`) so a present-but-empty bodyText falls through to bodyHtml.
	const sentText = (args.context.bodyText || args.context.bodyHtml).trim();
	const learningEffects: Effect[] =
		baselineText.length > 0 && sentText.length > 0
			? [
					{
						kind: 'schedule_edit_learning',
						mailboxId: draft.mailboxId,
						...(recipients[0] !== undefined ? { contactAddress: recipients[0] } : {}),
						baselineText,
						sentText,
					},
				]
			: [];

	return {
		// The `→ sent` reducer carries no draft patch — the runner deletes
		// the row instead. The patch is empty so the runner skips
		// ctx.db.patch.
		patch: {},
		effects: [
			// Storage cleanup runs ALONGSIDE the row delete so a crash leaves
			// no orphaned blobs.
			{
				kind: 'delete_attachment_storage',
				storageIds: draft.attachments.map((a) => a.storageId),
			},
			{
				kind: 'record_recipients_in_address_book',
				mailboxId: draft.mailboxId,
				emails: recipients,
			},
			...learningEffects,
			// The audit log fires AFTER the new mailMessages row insert so
			// `messageId` is available — the runner enriches the details
			// after insertion.
			{
				kind: 'audit_log',
				action: 'postbox_draft.sent',
				draftId: draft._id,
				mailboxId: draft.mailboxId,
				details: {
					rawSize: args.context.rawSize,
					recipientCount: recipients.length,
				},
			},
		],
		applied: 'transitioned',
		extras: { sentContext: args.context },
	};
}

// ─── Runner ─────────────────────────────────────────────────────────────────
//
// The runner is the single place that writes the DB and the scheduler. For
// `→ sent` it performs the six-table cascade inline (the cascade reads its
// own results — the new messageId is needed to patch recipients[] in place
// with the deterministic `pb-<id>-<idx>` mtaJobIds, then re-fetches the
// thread for the participant update).
//
// Each effect is its own runner branch — the cascade is no longer hidden in
// the middle of a 180-line mutation.

interface SentRunnerOutput {
	messageId: Id<'mailMessages'> | null;
}

async function runSentEffects(
	ctx: MutationCtx,
	draft: Doc<'mailDrafts'>,
	context: SentInputContext
): Promise<SentRunnerOutput> {
	// Send-as choice: the sent copy lands in the mailbox the reply was sent FROM
	// — the thread mailbox for the classic/team path, or the teammate's personal
	// mailbox when they replied under their own identity. `sendAsMailboxId` is
	// unset for the common case, so `sendingMailboxId` collapses to the thread
	// mailbox and the placement below is byte-for-byte unchanged.
	const sendingMailboxId = draft.sendAsMailboxId ?? draft.mailboxId;
	const sentFromPersonal = sendingMailboxId !== draft.mailboxId;

	const mailbox = await ctx.db.get(sendingMailboxId);
	if (!mailbox) return { messageId: null };

	const sentFolder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', sendingMailboxId).eq('role', 'sent'))
		.first();
	if (!sentFolder) return { messageId: null };

	const now = Date.now();
	const normalizedSubject = normalizeSubject(draft.subject || '(no subject)');
	const snippet = (context.bodyText ?? context.bodyHtml.replace(/<[^>]+>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);

	// insert_mail_message effect — runs first so we have the new messageId
	// for both the recipients[] patch and the audit-log details.
	//
	// The sent copy's thread lives in the SENDING mailbox. For a personal
	// send-as we never reuse `draft.threadId` (that thread belongs to the TEAM
	// mailbox); we open a fresh thread in the personal mailbox instead. The
	// on-the-wire In-Reply-To/References headers (built in mail/outbound.ts) keep
	// the reply correctly threaded at the recipient regardless.
	let threadId = sentFromPersonal ? undefined : draft.threadId;
	if (!threadId) {
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId: sendingMailboxId,
			normalizedSubject,
			participants: [draft.fromAddress, ...draft.toAddresses],
			messageCount: 0,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: context.attachmentsMeta.length > 0,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: snippet,
			latestFromAddress: draft.fromAddress,
			latestSubject: draft.subject || '(no subject)',
			folderRoles: [],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
	}

	const uid = sentFolder.uidNext;
	const modseq = sentFolder.highestModseq + 1;

	const recipients = dedupedRecipients(draft);

	const messageId = await ctx.db.insert('mailMessages', {
		mailboxId: sendingMailboxId,
		folderId: sentFolder._id,
		uid,
		modseq,
		rfc822MessageId: context.rfc822MessageId,
		inReplyTo: context.inReplyToHeaderValue,
		references: context.references.length > 0 ? context.references : undefined,
		threadId,
		fromAddress: draft.fromAddress.toLowerCase(),
		fromName: undefined,
		toAddresses: draft.toAddresses.map((s) => s.toLowerCase()),
		ccAddresses: draft.ccAddresses.map((s) => s.toLowerCase()),
		bccAddresses: draft.bccAddresses.map((s) => s.toLowerCase()),
		replyToAddress: undefined,
		subject: draft.subject || '(no subject)',
		normalizedSubject,
		snippet,
		rawStorageId: context.rawStorageId,
		rawSize: context.rawSize,
		textBodyInline:
			context.bodyText && context.bodyText.length <= 64 * 1024 ? context.bodyText : undefined,
		htmlBodyInline: context.bodyHtml.length <= 64 * 1024 ? context.bodyHtml : undefined,
		attachments: context.attachmentsMeta,
		hasAttachments: context.attachmentsMeta.length > 0,
		// Team-inbox attribution: WHO fired this send (captured by drafts.send).
		sentByUserId: draft.sentByUserId,
		flagSeen: true,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		labelIds: [],
		receivedAt: now,
		internalDate: now,
		outbound: {
			state: 'queued' as const,
			recipients: [],
		},
		createdAt: now,
		updatedAt: now,
	});

	await ctx.db.patch(messageId, {
		outbound: {
			state: 'queued' as const,
			recipients: recipients.map((address, idx) => ({
				idx,
				address,
				mtaJobId: `pb-${messageId}-${idx}`,
				state: 'queued' as const,
			})),
		},
	});

	// patch_sent_folder effect
	await ctx.db.patch(sentFolder._id, {
		uidNext: uid + 1,
		highestModseq: modseq,
		totalCount: sentFolder.totalCount + 1,
		updatedAt: now,
	});

	// patch_thread effect
	const thread = await ctx.db.get(threadId);
	if (thread) {
		const folderRoles = new Set(thread.folderRoles);
		folderRoles.add('sent');
		// "Remind me if no reply by…" carried from the composer: arm the
		// thread's follow-up watch on the freshly sent message. A deadline
		// already in the past (e.g. a scheduled send dispatched after it) is
		// dropped silently rather than firing immediately.
		const followUpRemindAt =
			draft.followUpRemindAt !== undefined && draft.followUpRemindAt > now
				? draft.followUpRemindAt
				: undefined;
		await ctx.db.patch(threadId, {
			messageCount: thread.messageCount + 1,
			hasAttachments: thread.hasAttachments || context.attachmentsMeta.length > 0,
			lastMessageAt: now,
			latestSnippet: snippet,
			latestFromAddress: draft.fromAddress,
			latestSubject: draft.subject || '(no subject)',
			latestMessageId: messageId,
			// Team-inbox collision safety: record this reply as the thread's newest
			// outbound so a second teammate who opened the thread earlier is warned
			// before sending a duplicate (see mail/mailbox.ts::latestReplyState).
			latestReply: { messageId, byUserId: draft.sentByUserId, at: now },
			folderRoles: Array.from(folderRoles),
			// Any outbound in the thread answers the Reply Queue signal — clear
			// the needs-reply flag and any in-flight classification marker.
			needsReply: undefined,
			needsReplyPendingAt: undefined,
			...(followUpRemindAt !== undefined
				? {
						followUp: {
							messageId,
							remindAt: followUpRemindAt,
							armedAt: now,
							waitingOn: followUpWaitingOn(recipients),
						},
						followUpRemindAt,
					}
				: {}),
			updatedAt: now,
		});
	}

	// Team-thread marker (send-as choice). When the reply went out under a
	// teammate's PERSONAL identity from within a shared thread, the sent copy
	// lives in their own mailbox — so stamp the ORIGINAL team thread with a
	// lightweight marker: teammates see a reply happened, that it went out under
	// a personal address, and the thread leaves the Reply Queue. Context never
	// silently forks. Skipped for a fresh personal compose (no team thread).
	if (sentFromPersonal && draft.threadId) {
		const teamThread = await ctx.db.get(draft.threadId);
		if (teamThread) {
			await ctx.db.patch(draft.threadId, {
				lastMessageAt: now,
				latestSnippet: snippet,
				latestFromAddress: draft.fromAddress,
				latestSubject: draft.subject || '(no subject)',
				latestReply: {
					messageId,
					byUserId: draft.sentByUserId,
					at: now,
					isFromPersonalAddress: true,
				},
				needsReply: undefined,
				needsReplyPendingAt: undefined,
				updatedAt: now,
			});
		}
	}

	// patch_in_reply_to_flag effect
	// Defense-in-depth: only stamp flagAnswered when the referenced message is
	// in the SAME (team/thread) mailbox as the draft. drafts.create already
	// refuses to persist a cross-mailbox inReplyToMessageId, but re-check here so
	// a stray linkage can never flip a flag in another user's mailbox
	// (cross-mailbox IDOR). Note: `draft.mailboxId` is the THREAD mailbox even on
	// a personal send-as, so the original team message is marked answered.
	if (draft.inReplyToMessageId) {
		const original = await ctx.db.get(draft.inReplyToMessageId);
		if (original && original.mailboxId === draft.mailboxId) {
			await ctx.db.patch(draft.inReplyToMessageId, {
				flagAnswered: true,
				updatedAt: now,
			});
		}
	}

	// patch_mailbox_bytes effect — the SENDING mailbox holds the sent copy.
	await ctx.db.patch(sendingMailboxId, {
		usedBytes: mailbox.usedBytes + context.rawSize,
		updatedAt: now,
	});

	return { messageId };
}

async function applyNonSentEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'schedule_dispatch_action': {
				await ctx.scheduler.runAt(effect.sendAt, internal.mail.outbound.dispatchDraft, {
					draftId: effect.draftId,
					undoToken: effect.undoToken,
				});
				break;
			}
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: 'system',
					action: effect.action,
					resource: 'mail_message',
					resourceId: effect.draftId,
					details: {
						mailboxId: effect.mailboxId,
						...effect.details,
					},
				});
				break;
			}
			case 'delete_attachment_storage': {
				for (const storageId of effect.storageIds) {
					await ctx.storage.delete(storageId);
				}
				break;
			}
			case 'record_recipients_in_address_book': {
				// Routed through the same internalMutation used by the old
				// inline call site at outbound.dispatchDraft.
				await ctx.runMutation(internal.mail.contacts.internalRecordRecipients, {
					mailboxId: effect.mailboxId,
					emails: Array.from(effect.emails),
				});
				break;
			}
			case 'schedule_edit_learning': {
				// Fire-and-forget: the diff + recurrence gating run out of band so
				// a learning failure can never block or delay the send.
				await ctx.scheduler.runAfter(0, internal.mail.editLearning.recordEdit, {
					mailboxId: effect.mailboxId,
					...(effect.contactAddress !== undefined ? { contactAddress: effect.contactAddress } : {}),
					baselineText: effect.baselineText,
					sentText: effect.sentText,
				});
				break;
			}
		}
	}
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	draft: Doc<'mailDrafts'>,
	input: TransitionInput
): Promise<TransitionOutcome> {
	const from = draft.state;
	const isLegalEdge = LEGAL_EDGES[from].has(input.to);
	if (!isLegalEdge) {
		return {
			ok: false,
			reason: 'illegal_edge',
			draftId: draft._id,
			from,
			to: input.to,
		};
	}

	// Per-kind precondition checks that depend on freshly-read DB state.
	// The reducers are pure; everything that reads the DB happens here.
	if (input.to === 'pending_send' || input.to === 'scheduled') {
		if (draft.toAddresses.length === 0) {
			return {
				ok: false,
				reason: 'no_recipients',
				draftId: draft._id,
				from,
				to: input.to,
			};
		}
	}
	if (input.to === 'sent') {
		// Re-check the from-address binding inside the reducer (not as an
		// effect). If the address has been removed from the allowed set
		// since the draft was queued — or the send-as grant (a teammate's
		// personal identity used in a shared inbox) no longer holds — the kind
		// is rejected. The caller (the dispatch action) must instead call
		// transition({to:'draft', reason:'from_revoked'}). The reducer never
		// silently downgrades, and the send-as allow-set extension is
		// re-validated here independently of the setIdentity-time check.
		const sanctioned = await isSanctionedSendAsForUser(ctx, {
			threadMailboxId: draft.mailboxId,
			sendingMailboxId: draft.sendAsMailboxId ?? draft.mailboxId,
			fromAddress: draft.fromAddress,
			userId: draft.sentByUserId ?? '',
		});
		if (!sanctioned) {
			return {
				ok: false,
				reason: 'from_revoked',
				draftId: draft._id,
				from,
				to: input.to,
			};
		}
	}

	let result: ReducerResult;
	switch (input.to) {
		case 'pending_send':
			result = reducePendingSend(draft, input);
			break;
		case 'scheduled':
			result = reduceScheduled(draft, input);
			break;
		case 'draft':
			result = reduceDraftRevert(draft, input);
			break;
		case 'sent':
			result = reduceSent(draft, input);
			break;
	}

	// Apply the patch (except for `→ sent` where the row is deleted later).
	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(draft._id, result.patch);
	}

	// `→ sent` runs the multi-table cascade FIRST so the new messageId is
	// available for the audit-log details and the row delete happens LAST
	// (a crash mid-cascade leaves the draft intact for retry).
	let messageId: Id<'mailMessages'> | undefined;
	if (input.to === 'sent' && result.extras?.sentContext) {
		const sentOutput = await runSentEffects(ctx, draft, result.extras.sentContext);
		if (sentOutput.messageId === null) {
			// Mailbox or Sent folder vanished between the dispatcher's
			// initial read and now. Refuse with a typed outcome — the
			// caller can decide whether to revert.
			return {
				ok: false,
				reason: 'sent_folder_missing',
				draftId: draft._id,
				from,
				to: input.to,
			};
		}
		messageId = sentOutput.messageId;

		// Re-enrich the audit-log effect's details with the new messageId.
		const enrichedEffects: Effect[] = result.effects.map((e) =>
			e.kind === 'audit_log'
				? {
						...e,
						details: { ...e.details, messageId: messageId as string },
					}
				: e
		);
		await applyNonSentEffects(ctx, enrichedEffects);

		// delete_draft_row effect — runs LAST so a crash mid-sequence
		// leaves the draft for retry rather than a half-applied send with
		// no draft to recover from.
		await ctx.db.delete(draft._id);
	} else {
		await applyNonSentEffects(ctx, result.effects);
	}

	return {
		ok: true,
		applied: result.applied,
		draftId: draft._id,
		from,
		to: input.to,
		...(result.extras?.undoToken !== undefined ? { undoToken: result.extras.undoToken } : {}),
		...(result.extras?.sendAt !== undefined ? { sendAt: result.extras.sendAt } : {}),
		...(messageId !== undefined ? { messageId } : {}),
	};
}

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Initial-insert path. The first writer of `mailDrafts.state` (with the
 * literal `'draft'`). All other writes to `state` go through `transition`.
 *
 * Called by the user-facing `api.mail.drafts.create` mutation, which already
 * does the mailbox-permission check.
 */
export const create = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		fromAddress: v.string(),
		inReplyToMessageId: v.optional(v.id('mailMessages')),
		threadId: v.optional(v.id('mailThreads')),
		toAddresses: v.array(v.string()),
		subject: v.string(),
		at: v.number(),
	},
	handler: async (ctx, args): Promise<Id<'mailDrafts'>> => {
		return await ctx.db.insert('mailDrafts', {
			mailboxId: args.mailboxId,
			linkedMessageId: undefined,
			inReplyToMessageId: args.inReplyToMessageId,
			threadId: args.threadId,
			toAddresses: args.toAddresses,
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: args.fromAddress,
			subject: args.subject,
			bodyHtml: '',
			bodyText: undefined,
			attachments: [],
			state: 'draft',
			lastEditedAt: args.at,
			createdAt: args.at,
		});
	},
});

/**
 * Apply a draft transition by draftId. Sole writer of `mailDrafts.state` and
 * its companion fields (`scheduledSendAt`, `undoToken`).
 *
 * Atomic with: state patch, scheduler.runAt (for `→ pending_send`/`scheduled`),
 * the six-table send-success cascade (for `→ sent`), audit_log effects, and
 * row deletion (for `→ sent`). Duplicate / illegal / terminal transitions are
 * reported via TransitionOutcome — never thrown.
 */
export const transition = internalMutation({
	args: {
		draftId: v.id('mailDrafts'),
		input: transitionInputValidator,
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) {
			return { ok: false, reason: 'draft_not_found', draftId: args.draftId };
		}
		const outcome = await dispatch(ctx, draft, args.input);
		// Log reverts so an operator can see why a draft popped back to
		// Drafts unexpectedly. The audit-log row carries the structured
		// reason; the runtime log is for live debugging.
		if (outcome.ok && args.input.to === 'draft' && args.input.reason !== 'user_cancel') {
			logError(`[DraftLifecycle] Reverted draft ${args.draftId} → 'draft': ${args.input.reason}`);
		}
		return outcome;
	},
});

/**
 * Same as `transition`, but keyed by `undoToken` rather than draftId. Used by
 * the user-facing `api.mail.drafts.cancelPendingSend` mutation which receives
 * the opaque undo handle from the client.
 *
 * Refuses any `input.to !== 'draft'` — the undo-token surface is undo-only.
 * Returns `already_draft` if the token's row is already in `'draft'` (the
 * undo button double-fire case).
 */
export const transitionByUndoToken = internalMutation({
	args: {
		undoToken: v.string(),
		input: transitionInputValidator,
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		if (args.input.to !== 'draft') {
			return { ok: false, reason: 'illegal_edge' };
		}
		const draft = await ctx.db
			.query('mailDrafts')
			.withIndex('by_undo_token', (q) => q.eq('undoToken', args.undoToken))
			.first();
		if (!draft) {
			return { ok: false, reason: 'undo_token_mismatch' };
		}
		if (draft.state === 'draft') {
			return {
				ok: true,
				applied: 'recorded',
				draftId: draft._id,
				from: 'draft',
				to: 'draft',
			};
		}
		return await dispatch(ctx, draft, args.input);
	},
});
