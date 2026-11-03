/**
 * The row half of a cross-mailbox move or copy: put a copy of one message into
 * a folder of ANOTHER mailbox, as that mailbox would hold it had it arrived
 * there.
 *
 * Unlike an IMAP COPY (`mail/imap/move.ts`), which stays in one mailbox and
 * keeps the source's thread, the copy is threaded afresh in the target mailbox
 * (`resolveDeliveryThread`) and its labels are looked up there by path, because
 * threads and labels belong to one mailbox. The raw `.eml` and body blobs are
 * shared with the source row, exactly as a COPY shares them: the purge frees a
 * blob only with the last row that references it (`mail/messagePurge.ts`).
 *
 * The caller has already authorized both mailboxes and decided the message may
 * travel (`mail/mailboxTransfer.ts`).
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { copyMessageBody } from '../lib/messageBodyStore';
import { indexMessageAttachments } from './attachmentIndex';
import { recordFolderMembership } from './folderMembership';
import { recordMessageCounters } from './messageCounters';
import { applyMailboxUsageDelta } from './mailboxUsage';
import { mergeThreadParticipants } from './threadAggregates';
import { conversationRootId, resolveDeliveryThread } from './deliveryPipeline/threading';
import { LABEL_MAX_DEPTH, LABEL_PATH_SEPARATOR, resolveLabelPath } from './labelsTree';

/** Source labels already resolved in the target mailbox, by source label id. */
export type LabelMap = Map<Id<'mailLabels'>, Id<'mailLabels'> | null>;

/** A label's full path (`Work/Clients/Acme`), or null for a label that is gone. */
async function labelPath(ctx: MutationCtx, labelId: Id<'mailLabels'>): Promise<string | null> {
	const segments: string[] = [];
	let current: Id<'mailLabels'> | undefined = labelId;
	// The tree is at most LABEL_MAX_DEPTH deep; the bound also stops a corrupt cycle.
	for (let depth = 0; current && depth <= LABEL_MAX_DEPTH; depth++) {
		const label: Doc<'mailLabels'> | null = await ctx.db.get(current);
		if (!label) return null;
		segments.unshift(label.name);
		current = label.parentId;
	}
	return segments.join(LABEL_PATH_SEPARATOR);
}

/**
 * The target mailbox's labels for `labelIds`, matched by path and created where
 * the target has no label of that path, so the message keeps its labels.
 */
async function targetLabels(
	ctx: MutationCtx,
	labelIds: Id<'mailLabels'>[],
	targetMailboxId: Id<'mailboxes'>,
	labelMap: LabelMap
): Promise<Id<'mailLabels'>[]> {
	const out: Id<'mailLabels'>[] = [];
	for (const labelId of labelIds) {
		if (!labelMap.has(labelId)) {
			const path = await labelPath(ctx, labelId);
			const resolved = path ? await resolveLabelPath(ctx, targetMailboxId, path) : null;
			labelMap.set(labelId, resolved?.labelId ?? null);
		}
		const mapped = labelMap.get(labelId);
		if (mapped && !out.includes(mapped)) out.push(mapped);
	}
	return out;
}

/** The thread the copy joins in the target mailbox, started when there is none. */
async function targetThread(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	target: Doc<'mailboxes'>,
	now: number
): Promise<Id<'mailThreads'>> {
	const refs = message.references ?? [];
	const parties = [message.fromAddress, ...message.toAddresses, ...message.ccAddresses];
	const existing = await resolveDeliveryThread(ctx, {
		mailbox: target,
		messageId: message.rfc822MessageId,
		rootId:
			message.threadRootId ?? conversationRootId(message.rfc822MessageId, message.inReplyTo, refs),
		references: message.inReplyTo ? [message.inReplyTo, ...refs] : refs,
		subject: message.subject,
		normalizedSubject: message.normalizedSubject,
		receivedAt: message.receivedAt,
		parties,
	});
	if (existing) return existing;
	// A skeleton: the caller rebuilds every touched thread's aggregates once the
	// whole batch has landed.
	return await ctx.db.insert('mailThreads', {
		mailboxId: target._id,
		normalizedSubject: message.normalizedSubject,
		participants: mergeThreadParticipants(parties, target.address),
		messageCount: 0,
		unreadCount: 0,
		hasFlagged: false,
		hasAttachments: false,
		lastMessageAt: message.receivedAt,
		firstMessageAt: message.receivedAt,
		latestSnippet: message.snippet,
		latestFromAddress: message.fromAddress,
		latestSubject: message.subject,
		folderRoles: [],
		labelIds: [],
		createdAt: now,
		updatedAt: now,
	});
}

/**
 * Insert the copy of `message` into `folder` of `target`. Read, star, answered
 * and label state travel with it. What only makes sense in the source mailbox
 * stays behind: its snooze (it names a source folder), its inbox section, the
 * reply it answered, the provider's sighting and a live sign-in code.
 *
 * Writes the row, its body, counters, folder membership, attachment index and
 * the target's byte usage. The FOLDER's own counters and the thread aggregates
 * are the caller's, once per batch.
 */
export async function insertMessageCopy(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	target: { mailbox: Doc<'mailboxes'>; folder: Doc<'mailFolders'>; uid: number; modseq: number },
	labelMap: LabelMap,
	now: number
): Promise<{ messageId: Id<'mailMessages'>; threadId: Id<'mailThreads'> }> {
	const {
		_id,
		_creationTime,
		mailboxId: _mailboxId,
		folderId: _folderId,
		threadId: _threadId,
		uid: _uid,
		modseq: _modseq,
		labelIds,
		snoozedUntil: _snoozedUntil,
		snoozedFromFolderId: _snoozedFrom,
		isSnoozeUntilReply: _untilReply,
		pinnedSection: _section,
		answeredMessageId: _answered,
		remoteSighting: _sighting,
		signInCode: _code,
		trashedAt: _trashedAt,
		createdAt: _createdAt,
		updatedAt: _updatedAt,
		...carried
	} = message;
	const { mailbox, folder, uid, modseq } = target;
	const threadId = await targetThread(ctx, message, mailbox, now);
	const copy = {
		...carried,
		mailboxId: mailbox._id,
		folderId: folder._id,
		threadId,
		uid,
		modseq,
		labelIds: await targetLabels(ctx, labelIds, mailbox._id, labelMap),
		...(folder.role === 'trash' ? { trashedAt: now } : {}),
		createdAt: now,
		updatedAt: now,
	};
	const messageId = await ctx.db.insert('mailMessages', copy);
	await copyMessageBody(ctx.db, _id, messageId);
	await recordMessageCounters(ctx, null, copy);
	await recordFolderMembership(ctx, null, copy);
	await indexMessageAttachments(ctx, { ...copy, _id: messageId });
	await applyMailboxUsageDelta(ctx, mailbox, message.rawSize, now);
	return { messageId, threadId };
}
