/**
 * Personal-mail delivery pipeline — the shared row-insert step.
 *
 * RFC 5322 threading (resolved in `./threading`), per-folder UID + modseq
 * allocation, the `mailMessages` insert, and the folder/thread/usedBytes
 * aggregates + audit, plus the header parsing helpers that shape the row. This
 * is the one place a delivered message becomes a row, shared by the hosted MX
 * inbound path (`mail/delivery.ts::deliverToMailbox`), external IMAP sync
 * (`mail/external/delivery.ts::ingestExternalMessage`) and archive import
 * (`mail/archiveImport.ts::ingestArchiveMessage`).
 *
 * The pre-insert checks those callers share live here too: the Message-ID
 * dedup (`findDuplicateInMailbox`), the quota test (`isOverQuota`) and the
 * cleanup of staged blobs when a message is not inserted (`dropStagedBlobs`).
 */

import { htmlToPlainText } from '@owlat/shared/html';
import { truncateCodePoints } from '@owlat/shared/unicode';
import type { ListUnsubscribeTarget } from '@owlat/shared/listUnsubscribe';

import type { StorageWriter } from 'convex/server';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { extractEmail, normalizeSubject } from '../../lib/emailAddress';
import { canonicalMessageId, canonicalOptionalMessageId } from '../../lib/messageId';
import { insertMessageBody } from '../../lib/messageBodyStore';
import { redirectMutedDelivery } from '../mute';
import { indexMessageAttachments } from '../attachmentIndex';
import { recordMessageCounters } from '../messageCounters';
import { recordFolderMembership } from '../folderMembership';
import { conversationRootId, resolveDeliveryThread } from './threading';
import { mergeThreadParticipants } from '../threadAggregates';
import { applyMailboxUsageDelta } from '../mailboxUsage';
import { buildSearchBody, isBodySearchIndexingEnabled } from '../searchBody';
import type { SenderHeuristics } from '../senderHeuristics';
import type { InboundEncryptionInfo } from '../../e2ee/inboundSeal';
import type { InboundSignatureInfo } from '../../e2ee/inboundSignature';
import type { VirusVerdict } from '../../lib/literalValidators';

function extractName(field: string): string | undefined {
	const match = field.match(/^([^<]+?)\s*<[^>]+>$/);
	return match?.[1]?.trim().replace(/^"|"$/g, '') || undefined;
}

/**
 * The stored 200-code-point preview of a message: the text part when there is
 * one (even a blank one — the preview line relies on that), else the HTML read
 * through the shared {@link htmlToPlainText}. Used for delivered mail and for
 * the Sent copy, so both sides of a conversation preview the same words.
 */
export function buildSnippet(text: string | undefined, html: string | undefined): string {
	const source = text?.trim() ?? (html === undefined ? '' : htmlToPlainText(html));
	return truncateCodePoints(source, 200);
}

function parseReferences(refs: string | undefined): string[] {
	if (!refs) return [];
	return refs
		.split(/\s+/)
		.map((r) => r.replace(/[<>]/g, '').trim())
		.filter(Boolean);
}

/**
 * The message already in `mailboxId` under this Message-ID, or null. Takes the
 * RAW header and canonicalises it the same way the insert below writes the
 * column, so the dedup read and the write cannot drift apart.
 */
export async function findDuplicateInMailbox(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	rawMessageId: string
): Promise<Doc<'mailMessages'> | null> {
	const rfc822MessageId = canonicalMessageId(rawMessageId);
	return await ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_rfc822_message_id', (q) =>
			q.eq('mailboxId', mailboxId).eq('rfc822MessageId', rfc822MessageId)
		)
		.first();
}

/**
 * Delete the blobs staged for a message that was not inserted (duplicate, no
 * target, over quota). Best-effort: a blob that is already gone must not turn
 * the skip into a failure.
 */
export async function dropStagedBlobs(
	ctx: { storage: StorageWriter },
	ids: Array<Id<'_storage'> | undefined>
): Promise<void> {
	for (const id of ids) {
		if (id) await ctx.storage.delete(id).catch(() => undefined);
	}
}

/** Whether storing `rawSize` more bytes would take the mailbox past its quota. */
export function isOverQuota(
	mailbox: Pick<Doc<'mailboxes'>, 'quotaBytes' | 'usedBytes'>,
	rawSize: number
): boolean {
	return mailbox.quotaBytes != null && mailbox.usedBytes + rawSize > mailbox.quotaBytes;
}

/**
 * Where an inbound message came from. `'mx'` is hosted delivery, `'sync'` is
 * forward IMAP sync, `'backfill'` is a historical IMAP import (and what an
 * older sync worker that sends no origin is read as).
 */
export type InboundOrigin = 'mx' | 'sync' | 'backfill';

/**
 * Whether an inbound insert queues a Reply Queue check: live mail (never a
 * backfill) the caller filed into the inbox that stayed there. A muted
 * thread's delivery is re-routed to Archive inside the insert, so `landedIn`
 * is the row's actual folder. The insert stamps the pending marker off this
 * and `runPostInsertInboundEffects` schedules the classify off it, so the two
 * cannot disagree.
 */
export function queuesNeedsReplyCheck(
	origin: InboundOrigin | undefined,
	filedTo: Pick<Doc<'mailFolders'>, '_id' | 'role'>,
	landedIn: Id<'mailFolders'>
): boolean {
	return (
		origin !== undefined &&
		origin !== 'backfill' &&
		filedTo.role === 'inbox' &&
		landedIn === filedTo._id
	);
}

interface DeliveredAttachment {
	filename: string;
	contentType: string;
	size: number;
	contentId?: string;
	partIndex: string;
}

/**
 * Shared insert path for a delivered message: RFC 5322 threading, per-folder
 * UID + modseq allocation, the `mailMessages` insert, and the folder/thread/
 * usedBytes aggregates + audit. The caller has already resolved the target
 * `mailbox` + `folder`, run any dedup, and decided flags/labels. Returns the
 * new message id.
 *
 * Post-delivery work is NOT run here: the inbound callers follow up with
 * `runPostInsertInboundEffects` (`./afterInsert`), and forwarding/vacation stay
 * with the hosted MX path.
 */
export async function insertDeliveredMessage(
	ctx: MutationCtx,
	params: {
		mailbox: Doc<'mailboxes'>;
		folder: Doc<'mailFolders'>;
		rawStorageId: Id<'_storage'>;
		rawSize: number;
		from: string;
		to: string[];
		cc: string[];
		bcc: string[];
		replyTo?: string;
		subject: string;
		textBodyInline?: string;
		textBodyStorageId?: Id<'_storage'>;
		htmlBodyInline?: string;
		htmlBodyStorageId?: Id<'_storage'>;
		/** Preview snippet derived from the FULL body before any inline/blob split
		 * (so >64KB bodies still get a non-empty list/search snippet). */
		snippet?: string;
		/** Deep-search excerpt (idea 32), derived from the FULL body before the
		 * inline/blob split for the same reason as `snippet` — the interesting
		 * depth of a long message is exactly what gets split into a blob. Only
		 * PERSISTED when the instance opted in; the caller always computes it. */
		searchBody?: string;
		messageId: string;
		inReplyTo?: string;
		references?: string;
		receivedAt: number;
		attachments: DeliveredAttachment[];
		flagSeen?: boolean;
		flagFlagged?: boolean;
		labelIds?: Id<'mailLabels'>[];
		spamScore?: number;
		spamVerdict?: 'ham' | 'spam' | 'quarantine';
		virusVerdict?: VirusVerdict;
		spfResult?: string;
		dkimResult?: string;
		dmarcResult?: string;
		dmarcPolicy?: string;
		/** Inbound-auth override (Sealed Mail A5): `'arc'` when a trusted forwarder
		 * rescued a DMARC fail; `arcSealer` names the honoured sealer's `d=`. */
		dmarcOverride?: string;
		arcSealer?: string;
		envelopeFromDomain?: string;
		dkimSigningDomain?: string;
		/** Ingest-computed sender-impersonation heuristics (Sealed Mail A4). */
		senderHeuristics?: SenderHeuristics;
		/** Inbound unsealing outcome (Sealed Mail E4, D3): present only for a message
		 * that arrived sealed. The body columns above hold the RESTORED plaintext when
		 * `decrypted:true`; the raw `.eml` stays the sealed original either way. */
		inboundEncryptionInfo?: InboundEncryptionInfo;
		/** Inbound signature verdict (F1, D9): present only for a message that arrived
		 * PGP-SIGNED but not encrypted. Honest — every failure state is recorded, and
		 * its presence never changes routing or delivery. */
		inboundSignatureInfo?: InboundSignatureInfo;
		/** Parsed List-Unsubscribe target (extracted at ingest from the raw header block). */
		unsubscribe?: ListUnsubscribeTarget;
		/** Split inbox (idea 24): the named inbox section a `pinToSection` filter
		 * claimed this message for. Absent ⇒ the message renders in the trailing
		 * "Everything else" section, which is exactly today's flat inbox. */
		pinnedSection?: string;
		/** Add rawSize to the mailbox's used bytes (local cache accounting). */
		countUsedBytes?: boolean;
		/** Set by the inbound callers that run `runPostInsertInboundEffects`
		 * next (hosted MX, IMAP sync). When that tail will queue a Reply Queue
		 * check ({@link queuesNeedsReplyCheck}), the thread patch below stamps
		 * `needsReplyPendingAt` itself, so the enqueue does not patch the thread
		 * a second time (plan C10). Absent for archive import and the brief. */
		inboundOrigin?: InboundOrigin;
	}
): Promise<Id<'mailMessages'>> {
	const { mailbox } = params;
	// Reassigned below when the resolved thread turns out to be MUTED: the row is
	// then filed straight into Archive instead of the Inbox (mail/mute.ts).
	let folder = params.folder;
	const recipient = mailbox.address;
	const fromAddress = extractEmail(params.from);
	const fromName = extractName(params.from);
	const rfc822MessageId = canonicalMessageId(params.messageId);
	const refs = parseReferences(params.references);
	const inReplyTo = canonicalOptionalMessageId(params.inReplyTo);
	const normalizedSubject = normalizeSubject(params.subject);
	const now = Date.now();
	const snippet = params.snippet ?? buildSnippet(params.textBodyInline, params.htmlBodyInline);
	// Deep body search (idea 32): the ONE gate for the widened plaintext
	// carve-out. Off (the default) leaves the column absent, which is exactly the
	// snippet-only row this pipeline wrote before the field existed. An empty
	// excerpt is stored as absent too — an empty search field indexes nothing.
	const excerpt = (await isBodySearchIndexingEnabled(ctx))
		? (params.searchBody ?? buildSearchBody(params.textBodyInline, params.htmlBodyInline))
		: '';
	const searchBody = excerpt || undefined;
	const hasAttachments = params.attachments.length > 0;
	const flagSeen = params.flagSeen ?? false;
	// Unread delta is shared by the folder + thread counters so they stay in
	// agreement (a pre-marked-read message bumps neither).
	const unreadDelta = flagSeen ? 0 : 1;

	// Every address on the message: the thread's participant list, and the
	// correspondent check the subject fallback uses (mail/deliveryPipeline/threading.ts).
	const toAddresses = params.to.map(extractEmail);
	const ccAddresses = params.cc.map(extractEmail);
	const messageParties = [fromAddress, ...toAddresses, ...ccAddresses];

	const threadRootId = conversationRootId(rfc822MessageId, inReplyTo, refs);
	let threadId = await resolveDeliveryThread(ctx, {
		mailbox,
		messageId: rfc822MessageId,
		rootId: threadRootId,
		references: inReplyTo ? [inReplyTo, ...refs] : refs,
		subject: params.subject,
		normalizedSubject,
		receivedAt: params.receivedAt,
		parties: messageParties,
	});
	if (!threadId) {
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId: mailbox._id,
			normalizedSubject,
			participants: mergeThreadParticipants(messageParties, recipient),
			messageCount: 0,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: params.receivedAt,
			firstMessageAt: params.receivedAt,
			latestSnippet: snippet,
			latestFromAddress: fromAddress,
			latestSubject: params.subject,
			folderRoles: [],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
	}

	// Mute (mail/mute.ts) is applied AFTER threading and BEFORE the UID/modseq
	// allocation, so a muted thread's new mail is allocated in — and counted
	// against — the folder it actually lands in.
	folder = await redirectMutedDelivery(ctx, threadId, folder);

	const uid = folder.uidNext;
	const modseq = folder.highestModseq + 1;

	const messageId = await ctx.db.insert('mailMessages', {
		mailboxId: mailbox._id,
		folderId: folder._id,
		uid,
		modseq,
		rfc822MessageId,
		inReplyTo,
		references: refs.length > 0 ? refs : undefined,
		threadRootId,
		threadId,
		fromAddress,
		fromName,
		toAddresses,
		ccAddresses,
		bccAddresses: params.bcc.map(extractEmail),
		replyToAddress: params.replyTo ? extractEmail(params.replyTo) : undefined,
		subject: params.subject,
		normalizedSubject,
		snippet,
		searchBody,
		rawStorageId: params.rawStorageId,
		rawSize: params.rawSize,
		textBodyStorageId: params.textBodyStorageId,
		htmlBodyStorageId: params.htmlBodyStorageId,
		attachments: params.attachments,
		hasAttachments,
		flagSeen,
		flagFlagged: params.flagFlagged ?? false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		labelIds: params.labelIds ?? [],
		receivedAt: params.receivedAt,
		internalDate: params.receivedAt,
		spamScore: params.spamScore,
		spamVerdict: params.spamVerdict,
		virusVerdict: params.virusVerdict,
		spfResult: params.spfResult,
		dkimResult: params.dkimResult,
		dmarcResult: params.dmarcResult,
		dmarcPolicy: params.dmarcPolicy,
		dmarcOverride: params.dmarcOverride,
		arcSealer: params.arcSealer,
		envelopeFromDomain: params.envelopeFromDomain,
		dkimSigningDomain: params.dkimSigningDomain,
		senderHeuristics: params.senderHeuristics,
		inboundEncryptionInfo: params.inboundEncryptionInfo,
		inboundSignatureInfo: params.inboundSignatureInfo,
		unsubscribe: params.unsubscribe,
		pinnedSection: params.pinnedSection,
		createdAt: now,
		updatedAt: now,
	});
	// Inline bodies live in their own table (plan 3.2), sealed as before.
	await insertMessageBody(ctx.db, messageId, {
		text: params.textBodyInline,
		html: params.htmlBodyInline,
	});
	await recordMessageCounters(ctx, null, {
		mailboxId: mailbox._id,
		folderId: folder._id,
		flagSeen,
		labelIds: params.labelIds ?? [],
		receivedAt: params.receivedAt,
		pinnedSection: params.pinnedSection,
	});
	await recordFolderMembership(ctx, null, { folderId: folder._id, uid });

	// Attachment index (idea 37): the indexable mirror of the array we just
	// wrote, so `filename:` narrows on an index and the Files view can browse
	// this message's files without loading the message.
	await indexMessageAttachments(ctx, {
		_id: messageId,
		mailboxId: mailbox._id,
		folderId: folder._id,
		fromAddress,
		receivedAt: params.receivedAt,
		attachments: params.attachments,
	});

	await ctx.db.patch(folder._id, {
		uidNext: uid + 1,
		highestModseq: modseq,
		totalCount: folder.totalCount + 1,
		unseenCount: folder.unseenCount + unreadDelta,
		updatedAt: now,
	});

	const thread = await ctx.db.get(threadId);
	if (thread) {
		const participants = mergeThreadParticipants(
			[...thread.participants, ...messageParties],
			recipient
		);
		const folderRoles = new Set(thread.folderRoles);
		if (folder.role) folderRoles.add(folder.role);
		// Only advance the "latest" pointers when this message is actually the
		// newest — external IMAP sync can ingest older messages out of order, and
		// latestMessageId now drives the conversation-list routing.
		const isNewest = params.receivedAt >= thread.lastMessageAt;
		await ctx.db.patch(threadId, {
			participants,
			messageCount: thread.messageCount + 1,
			unreadCount: thread.unreadCount + unreadDelta,
			hasAttachments: thread.hasAttachments || hasAttachments,
			folderRoles: Array.from(folderRoles),
			// An out-of-order ingest can also land an OLDER message than any the
			// thread holds — the parent a history import reaches last.
			firstMessageAt: Math.min(thread.firstMessageAt, params.receivedAt),
			updatedAt: now,
			...(queuesNeedsReplyCheck(params.inboundOrigin, params.folder, folder._id)
				? { needsReplyPendingAt: now }
				: {}),
			...(isNewest
				? {
						lastMessageAt: params.receivedAt,
						latestSnippet: snippet,
						latestFromAddress: fromAddress,
						latestSubject: params.subject,
						latestMessageId: messageId,
						// A just-delivered message is never snoozed (plan C8).
						latestSnoozedUntil: null,
					}
				: {}),
		});
	}

	// Usage lives on the 1:1 `mailboxUsage` row, so a delivery leaves the
	// mailbox document (read by every access check) untouched (plan 2.4).
	await applyMailboxUsageDelta(ctx, mailbox, params.countUsedBytes ? params.rawSize : 0, now);

	await ctx.db.insert('mailAuditLog', {
		mailboxId: mailbox._id,
		event: 'delivery',
		details: JSON.stringify({
			from: fromAddress,
			subject: params.subject,
			size: params.rawSize,
			folder: folder.role,
			threadId,
		}),
		occurredAt: now,
	});

	return messageId;
}
