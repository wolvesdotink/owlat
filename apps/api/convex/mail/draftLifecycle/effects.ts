/**
 * Mail draft lifecycle — effect runner + dispatcher.
 *
 * The impure half of the lifecycle. `runSentEffects` performs the `→ sent`
 * multi-table cascade inline (the cascade reads its own results — the new
 * messageId is needed to patch recipients[] in place with the deterministic
 * `pb-<id>-<idx>` mtaJobIds, then re-fetches the thread for the participant
 * update). `applyNonSentEffects` is the only place that touches
 * `ctx.scheduler` and the audit log for every other effect kind. `dispatch` is
 * the legal-edge gate that runs the reducer, writes the draft patch, applies
 * the effects, and deletes the row on a terminal send.
 *
 * The public `internalMutation`s in `../draftLifecycle.ts` are thin wrappers
 * over `dispatch`.
 *
 * See docs/adr/0028-mail-draft-lifecycle-module.md.
 */

import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { recordAuditLog } from '../../lib/auditLog';
import { isSanctionedSendAsForUser } from '../identities';
import { followUpWaitingOn } from '../followUps';
import { normalizeSubject } from '../../lib/emailAddress';
import { sealBodyAtWriteMaybe } from '../../lib/messageBody';
import { indexMessageAttachments } from '../attachmentIndex';
import { buildSearchBody, isBodySearchIndexingEnabled } from '../searchBody';
import { refuse } from '../../lib/lifecycle';
import {
	DRAFT_LIFECYCLE,
	dedupedRecipients,
	reduceDraftRevert,
	reducePendingSend,
	reduceScheduled,
	reduceSent,
} from './reducers';
import type {
	Effect,
	ReducerResult,
	SentInputContext,
	TransitionInput,
	TransitionOutcome,
} from './types';

// ─── Runner ─────────────────────────────────────────────────────────────────
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
		// Deep body search (idea 32) over the Sent copy too, under the same
		// instance opt-in — "what did I write to them about the penalty clause" is
		// the same question as the inbound one, and the full text is right here.
		searchBody: (await isBodySearchIndexingEnabled(ctx))
			? buildSearchBody(context.bodyText, context.bodyHtml) || undefined
			: undefined,
		rawStorageId: context.rawStorageId,
		rawSize: context.rawSize,
		textBodyInline: await sealBodyAtWriteMaybe(
			context.bodyText && context.bodyText.length <= 64 * 1024 ? context.bodyText : undefined
		),
		htmlBodyInline: await sealBodyAtWriteMaybe(
			context.bodyHtml.length <= 64 * 1024 ? context.bodyHtml : undefined
		),
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
		// Sealed Mail (E3): honest record of whether this send was sealed and why.
		...(context.encryptionInfo ? { encryptionInfo: context.encryptionInfo } : {}),
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

	// Attachment index (idea 37): what you sent is a file you will go looking
	// for as often as one you received, so the Sent row is indexed too.
	await indexMessageAttachments(ctx, {
		_id: messageId,
		mailboxId: sendingMailboxId,
		folderId: sentFolder._id,
		fromAddress: draft.fromAddress.toLowerCase(),
		receivedAt: now,
		attachments: context.attachmentsMeta,
	});

	// patch_sent_folder effect
	await ctx.db.patch(sentFolder._id, {
		uidNext: uid + 1,
		highestModseq: modseq,
		totalCount: sentFolder.totalCount + 1,
		updatedAt: now,
	});

	// Shared thread-summary shape applied by BOTH the sending thread's patch and
	// the team-thread send-as marker below, so the two can never drift: a reply
	// bumps the conversation's newest-message summary and answers the Reply Queue.
	const threadSummaryPatch = {
		lastMessageAt: now,
		latestSnippet: snippet,
		latestFromAddress: draft.fromAddress,
		latestSubject: draft.subject || '(no subject)',
		// Any outbound in the thread answers the Reply Queue signal — clear the
		// needs-reply flag and any in-flight classification marker.
		needsReply: undefined,
		needsReplyPendingAt: undefined,
		updatedAt: now,
	} as const;

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
			...threadSummaryPatch,
			messageCount: thread.messageCount + 1,
			hasAttachments: thread.hasAttachments || context.attachmentsMeta.length > 0,
			latestMessageId: messageId,
			// Team-inbox collision safety: record this reply as the thread's newest
			// outbound so a second teammate who opened the thread earlier is warned
			// before sending a duplicate (see mail/mailbox/messages.ts::latestReplyState).
			latestReply: { messageId, byUserId: draft.sentByUserId, at: now },
			folderRoles: Array.from(folderRoles),
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
				...threadSummaryPatch,
				latestReply: {
					messageId,
					byUserId: draft.sentByUserId,
					at: now,
					isFromPersonalAddress: true,
				},
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
				await ctx.scheduler.runAfter(0, internal.mail.ai.editLearning.recordEdit, {
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

export async function dispatch(
	ctx: MutationCtx,
	draft: Doc<'mailDrafts'>,
	input: TransitionInput
): Promise<TransitionOutcome> {
	const from = draft.state;
	// The verdict is stated rather than obtained from `classify`, because this
	// machine grants no implicit self-loop pass (see the graph in ./reducers).
	// `refuse` still owns the outcome shape, as it does for every other machine.
	if (!DRAFT_LIFECYCLE.isLegalEdge(from, input.to)) {
		return refuse(
			{ kind: 'refused', reason: 'illegal_edge', from, to: input.to },
			{ draftId: draft._id }
		);
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
