/**
 * Personal-mail delivery pipeline — the shared row-insert step.
 *
 * RFC 5322 threading, per-folder UID + modseq allocation, the `mailMessages`
 * insert, and the folder/thread/usedBytes aggregates + audit, plus the header
 * parsing helpers that shape the row. This is the one place a delivered
 * message becomes a row, shared by the hosted MX inbound path
 * (`mail/delivery.ts::deliverToMailbox`) and external IMAP sync
 * (`mail/external/delivery.ts::ingestExternalMessage`).
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { extractEmail, normalizeSubject } from '../../lib/emailAddress';
import { sealBodyAtWriteMaybe } from '../../lib/messageBody';
import type { SenderHeuristics } from '../senderHeuristics';
import type { InboundEncryptionInfo } from '../../e2ee/inboundSeal';
import type { InboundSignatureInfo } from '../../e2ee/inboundSignature';

function extractName(field: string): string | undefined {
	const match = field.match(/^([^<]+?)\s*<[^>]+>$/);
	return match?.[1]?.trim().replace(/^"|"$/g, '') || undefined;
}

export function buildSnippet(text: string | undefined, html: string | undefined): string {
	const source =
		text?.trim() ??
		html
			?.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim() ??
		'';
	return source.slice(0, 200);
}

export function stripBrackets(s: string | undefined): string | undefined {
	return s?.replace(/[<>]/g, '').trim() || undefined;
}

function parseReferences(refs: string | undefined): string[] {
	if (!refs) return [];
	return refs
		.split(/\s+/)
		.map((r) => r.replace(/[<>]/g, '').trim())
		.filter(Boolean);
}

export interface DeliveredAttachment {
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
 * Used by `deliverToMailbox` (hosted MX inbound) and
 * `external/delivery.ingestExternalMessage` (external IMAP sync). Post-delivery
 * hooks (forwarding/vacation) are NOT run here — each caller decides.
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
		virusVerdict?: 'clean' | 'infected' | 'skipped';
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
		unsubscribe?: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
		/** Add rawSize to mailbox.usedBytes (local cache accounting). */
		countUsedBytes?: boolean;
	}
): Promise<Id<'mailMessages'>> {
	const { mailbox, folder } = params;
	const recipient = mailbox.address;
	const fromAddress = extractEmail(params.from);
	const fromName = extractName(params.from);
	const rfc822MessageId = stripBrackets(params.messageId) ?? params.messageId;
	const refs = parseReferences(params.references);
	const inReplyTo = stripBrackets(params.inReplyTo);
	const normalizedSubject = normalizeSubject(params.subject);
	const now = Date.now();
	const snippet = params.snippet ?? buildSnippet(params.textBodyInline, params.htmlBodyInline);
	const hasAttachments = params.attachments.length > 0;
	const flagSeen = params.flagSeen ?? false;
	// Unread delta is shared by the folder + thread counters so they stay in
	// agreement (a pre-marked-read message bumps neither).
	const unreadDelta = flagSeen ? 0 : 1;

	// Threading: In-Reply-To / References → existing message; else subject window.
	let threadId: Id<'mailThreads'> | null = null;
	const candidates = inReplyTo ? [inReplyTo, ...refs] : refs;
	for (const candidate of candidates) {
		const referenced = await ctx.db
			.query('mailMessages')
			.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', candidate))
			.filter((q) => q.eq(q.field('mailboxId'), mailbox._id))
			.first();
		if (referenced) {
			threadId = referenced.threadId;
			break;
		}
	}
	if (!threadId && normalizedSubject) {
		const window = 24 * 60 * 60 * 1000;
		const recent = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_subject', (q) =>
				q.eq('mailboxId', mailbox._id).eq('normalizedSubject', normalizedSubject)
			)
			.first();
		if (recent && Math.abs(params.receivedAt - recent.lastMessageAt) <= window) {
			threadId = recent._id;
		}
	}
	if (!threadId) {
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId: mailbox._id,
			normalizedSubject,
			participants: [fromAddress, recipient],
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
		threadId,
		fromAddress,
		fromName,
		toAddresses: params.to.map(extractEmail),
		ccAddresses: params.cc.map(extractEmail),
		bccAddresses: params.bcc.map(extractEmail),
		replyToAddress: params.replyTo ? extractEmail(params.replyTo) : undefined,
		subject: params.subject,
		normalizedSubject,
		snippet,
		rawStorageId: params.rawStorageId,
		rawSize: params.rawSize,
		textBodyInline: await sealBodyAtWriteMaybe(params.textBodyInline),
		textBodyStorageId: params.textBodyStorageId,
		htmlBodyInline: await sealBodyAtWriteMaybe(params.htmlBodyInline),
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
		createdAt: now,
		updatedAt: now,
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
		const participants = new Set([...thread.participants, fromAddress, recipient]);
		const folderRoles = new Set(thread.folderRoles);
		if (folder.role) folderRoles.add(folder.role);
		// Only advance the "latest" pointers when this message is actually the
		// newest — external IMAP sync can ingest older messages out of order, and
		// latestMessageId now drives the conversation-list routing.
		const isNewest = params.receivedAt >= thread.lastMessageAt;
		await ctx.db.patch(threadId, {
			participants: Array.from(participants),
			messageCount: thread.messageCount + 1,
			unreadCount: thread.unreadCount + unreadDelta,
			hasAttachments: thread.hasAttachments || hasAttachments,
			folderRoles: Array.from(folderRoles),
			updatedAt: now,
			...(isNewest
				? {
						lastMessageAt: params.receivedAt,
						latestSnippet: snippet,
						latestFromAddress: fromAddress,
						latestSubject: params.subject,
						latestMessageId: messageId,
					}
				: {}),
		});
	}

	if (params.countUsedBytes) {
		await ctx.db.patch(mailbox._id, {
			usedBytes: mailbox.usedBytes + params.rawSize,
			updatedAt: now,
		});
	}

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
