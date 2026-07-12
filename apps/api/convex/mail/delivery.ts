/**
 * Personal-mail delivery pipeline.
 *
 * Called by `apps/api/convex/mailWebhook.ts` after the MTA HMAC-verifies an
 * `inbound.mailbox.received` event. Stores raw .eml in ctx.storage, performs
 * RFC 5322 threading, allocates per-folder UID + modseq atomically, inserts
 * a mailMessages row, and updates folder/thread aggregates.
 *
 * Threading order:
 *   1. In-Reply-To header → existing message by rfc822MessageId
 *   2. References header → any referenced message
 *   3. Fallback: mailbox + normalized subject (24h window)
 */

import { v } from 'convex/values';
import {
	mailMessageAttachmentValidator,
	mailUnsubscribeValidator,
	spamVerdictValidator,
} from '../lib/convexValidators';
import {
	internalMutation,
	internalAction,
	type MutationCtx,
	type ActionCtx,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { evaluateFilters } from './filters';
import { extractEmail, normalizeSubject } from '../lib/emailAddress';
import { extractAntiLoopHeaders } from '../lib/inboundClassification';
import { extractAttachments } from '@owlat/shared/mailMime';
import { extractListUnsubscribe } from '@owlat/shared/listUnsubscribe';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { logError } from '../lib/runtimeLog';
import { getMtaConfig, scanAttachmentBytes } from './mtaClient';
import { scanContent } from '@owlat/email-scanner';
import { computeSenderHeuristics, type SenderHeuristics } from './senderHeuristics';
import { enqueueNeedsReplyCheck } from './needsReply';
import { enqueueCategoryCheck } from './category';
import { clearThreadFollowUp } from './followUps';
import { resolveDeliverableMailbox } from './mailbox';
import { clearSnoozeUntilReplyForThread } from './snooze';

const INLINE_BODY_THRESHOLD_BYTES = 64 * 1024;

/**
 * Inline a parsed body when it fits the threshold; otherwise stash it as a
 * storage blob so the reader can lazy-fetch it. Bodies over the threshold are
 * NOT stored inline on the row (they'd bloat every list read and can exceed
 * Convex value limits) — previously they were simply dropped, so newsletters /
 * long threads rendered blank. Action-only (needs `ctx.storage.store`).
 */
export async function splitBodyForStorage(
	ctx: { storage: { store: (blob: Blob) => Promise<Id<'_storage'>> } },
	body: string | undefined,
	contentType: string
): Promise<{ inline?: string; storageId?: Id<'_storage'> }> {
	if (!body) return {};
	if (Buffer.byteLength(body, 'utf-8') <= INLINE_BODY_THRESHOLD_BYTES) {
		return { inline: body };
	}
	const storageId = await ctx.storage.store(new Blob([body], { type: contentType }));
	return { storageId };
}

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

function stripBrackets(s: string | undefined): string | undefined {
	return s?.replace(/[<>]/g, '').trim() || undefined;
}

function parseReferences(refs: string | undefined): string[] {
	if (!refs) return [];
	return refs
		.split(/\s+/)
		.map((r) => r.replace(/[<>]/g, '').trim())
		.filter(Boolean);
}

/**
 * Scan an inbound message's attachments for malware before mailbox delivery.
 *
 * ClamAV runs only in the MTA container, so the Convex inbound path POSTs each
 * non-inline attachment leaf to the MTA `/scan/attachment` endpoint (the same
 * endpoint the outbound send path uses — see `mail/outbound.ts` and
 * `delivery/worker.ts`). Defense-in-depth on the RECEIVING side: without this,
 * inbound mail lands in the mailbox with `virusVerdict` undefined, so the
 * `infected → Spam` routing in `deliverToMailbox` can never fire.
 *
 * Returns the aggregate verdict across all attachments:
 *   - `'infected'` — at least one attachment was confirmed malware. The caller
 *     routes the message to Spam/quarantine.
 *   - `'skipped'` — the scanner was unreachable / errored / failed open for at
 *     least one attachment (and none were confirmed infected). Fail-open: the
 *     message is still delivered, but the skip is surfaced via
 *     `lib/scannerHealth.warnScanSkipped` so the operator sees it in the logs.
 *   - `'clean'` — every attachment was scanned and came back clean.
 *   - `undefined` — there was nothing to scan (no attachments) or the MTA is
 *     not configured, so no verdict is asserted (leaves the row's prior verdict
 *     untouched).
 *
 * Pure (no Convex ctx): takes the raw MIME + resolved MTA config so it can be
 * unit-tested with a `fetch` spy, mirroring `deliveryHooks.forwardToTarget`.
 */
export async function scanInboundAttachments(
	mta: { baseUrl: string; apiKey: string } | null,
	rawBytes: Buffer
): Promise<'clean' | 'infected' | 'skipped' | undefined> {
	if (!mta) return undefined; // scanner not configured → no verdict asserted

	// The extractor wants a binary string (one char per byte) so binary parts survive.
	const parts = extractAttachments(rawBytes.toString('latin1'));
	// Only real (non-inline) attachment leaves carry a malware risk worth gating
	// delivery on; inline images (logos/signatures) are skipped, matching the
	// `captureAttachments` policy.
	const candidates = parts.filter((p) => p.disposition !== 'inline' && p.bytes.byteLength > 0);
	if (candidates.length === 0) return undefined; // nothing to scan

	let scannedAny = false;
	let anySkipped = false;
	let scanned = 0;
	for (const part of candidates) {
		// Bound the work: the inbound webhook is attacker-reachable, so a crafted
		// .eml with many leaves must not amplify per-message scan cost. Cap on the
		// same count `captureAttachments` uses.
		if (scanned >= ATTACHMENT_COMPOSE_LIMITS.maxCount) break;
		scanned++;
		const filename = part.filename || 'attachment';
		const data = Buffer.from(part.bytes);
		// Shared client owns the POST + fail-open (scanner-down / network error
		// resolve to 'skipped' and are surfaced via warnScanSkipped). This
		// path's POLICY: AGGREGATE the per-part verdicts — a single confirmed
		// infection short-circuits to quarantine; any skip downgrades the
		// aggregate to 'skipped'.
		const verdict = await scanAttachmentBytes(mta, filename, data);
		if (verdict.kind === 'infected') {
			// Confirmed malware — short-circuit; the message goes to quarantine.
			return 'infected';
		}
		if (verdict.kind === 'skipped') {
			anySkipped = true;
			continue;
		}
		scannedAny = true;
	}

	if (anySkipped) return 'skipped';
	if (scannedAny) return 'clean';
	return undefined;
}

/**
 * Action: download raw MIME from MTA Redis stage and store in ctx.storage.
 *
 * The MTA caches the raw .eml in Redis under `mta:inbound-raw:<deliveryId>`
 * with 1h TTL. We pull it and store as a Convex storage blob, then call
 * the internal delivery mutation.
 */
export const ingestFromWebhook = internalAction({
	args: {
		deliveryId: v.string(),
		rawBytesBase64: v.string(),
		recipientAddress: v.string(),
		from: v.string(),
		to: v.array(v.string()),
		cc: v.array(v.string()),
		bcc: v.array(v.string()),
		replyTo: v.optional(v.string()),
		// SMTP envelope sender (RFC 5321 MAIL FROM); `''` for a bounce/DSN null
		// sender. Threaded to the post-delivery hook to suppress vacation
		// auto-replies to bounces (RFC 3834 §2). Optional for older MTA builds.
		returnPath: v.optional(v.string()),
		subject: v.string(),
		textBody: v.optional(v.string()),
		htmlBody: v.optional(v.string()),
		messageId: v.string(),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		date: v.optional(v.number()),
		attachments: v.array(mailMessageAttachmentValidator),
		spamScore: v.optional(v.number()),
		spamVerdict: v.optional(spamVerdictValidator),
		virusVerdict: v.optional(
			v.union(v.literal('clean'), v.literal('infected'), v.literal('skipped'))
		),
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		dmarcPolicy: v.optional(v.string()),
		// DMARC alignment inputs (envelope MAIL FROM domain + DKIM d= domain),
		// stored beside the verdicts on `mailMessages`. Both optional.
		envelopeFromDomain: v.optional(v.string()),
		dkimSigningDomain: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> => {
		// Decode raw MIME and stash in Convex storage.
		const rawBytes = Buffer.from(args.rawBytesBase64, 'base64');
		const rawSize = rawBytes.length;
		// Raw header block decoded once (64KB covers any header section) for both
		// extractions below.
		const rawHeaderBlock = rawBytes.subarray(0, 65536).toString('utf8');
		// RFC 3834 anti-loop headers so forwarding + vacation hooks skip
		// list/auto-submitted mail.
		const antiLoopHeaders = extractAntiLoopHeaders(rawHeaderBlock);
		// List-Unsubscribe / List-Unsubscribe-Post (RFC 2369 / 8058), parsed once
		// here so the reader's Unsubscribe chip never re-opens the raw .eml.
		const unsubscribe = extractListUnsubscribe(rawHeaderBlock) ?? undefined;
		const blob = new Blob([rawBytes], { type: 'message/rfc822' });
		const rawStorageId = await ctx.storage.store(blob);

		// Inline small bodies for a fast list/reader render; stash larger bodies
		// as separate blobs (served lazily by mailbox.getMessageBody).
		const textBody = await splitBodyForStorage(ctx, args.textBody, 'text/plain; charset=utf-8');
		const htmlBody = await splitBodyForStorage(ctx, args.htmlBody, 'text/html; charset=utf-8');
		// Snippet from the FULL body, before the inline/blob split, so >64KB
		// bodies still get a non-empty preview + search snippet.
		const snippet = buildSnippet(args.textBody, args.htmlBody);

		// Scan inbound attachments for malware (defense-in-depth on the receiving
		// side). ClamAV lives in the MTA container, so we POST each attachment leaf
		// to its `/scan/attachment` endpoint. A confirmed-infected verdict routes
		// the message to Spam/quarantine in `deliverToMailbox`; a scanner outage
		// fails open with a `'skipped'` verdict (the message still delivers, and
		// the skip is surfaced via `scannerHealth.warnScanSkipped`). Any verdict
		// the MTA pipeline already set on `args` is preserved (infected wins).
		const inboundVerdict = await scanInboundAttachments(getMtaConfig(), rawBytes);
		const virusVerdict =
			args.virusVerdict === 'infected' || inboundVerdict === 'infected'
				? 'infected'
				: (inboundVerdict ?? args.virusVerdict);

		const result: { messageId: Id<'mailMessages'> } | { skipped: true } = await ctx.runMutation(
			internal.mail.delivery.deliverToMailbox,
			{
				rawStorageId,
				rawSize,
				antiLoopHeaders,
				unsubscribe,
				recipientAddress: args.recipientAddress,
				from: args.from,
				to: args.to,
				cc: args.cc,
				bcc: args.bcc,
				replyTo: args.replyTo,
				returnPath: args.returnPath,
				subject: args.subject,
				textBodyInline: textBody.inline,
				textBodyStorageId: textBody.storageId,
				htmlBodyInline: htmlBody.inline,
				htmlBodyStorageId: htmlBody.storageId,
				snippet,
				messageId: args.messageId,
				inReplyTo: args.inReplyTo,
				references: args.references,
				receivedAt: args.date ?? Date.now(),
				attachments: args.attachments,
				spamScore: args.spamScore,
				spamVerdict: args.spamVerdict,
				virusVerdict,
				spfResult: args.spfResult,
				dkimResult: args.dkimResult,
				dmarcResult: args.dmarcResult,
				dmarcPolicy: args.dmarcPolicy,
				envelopeFromDomain: args.envelopeFromDomain,
				dkimSigningDomain: args.dkimSigningDomain,
			}
		);

		// If delivery was skipped (no mailbox / quota / dup), drop the staged blobs.
		if ('skipped' in result) {
			await ctx.storage.delete(rawStorageId);
			if (textBody.storageId) await ctx.storage.delete(textBody.storageId);
			if (htmlBody.storageId) await ctx.storage.delete(htmlBody.storageId);
			return result;
		}

		// Capture real attachments into the semantic file library so they show
		// up under the "Email attachments" source filter on /dashboard/files and
		// flow into the file→knowledge pipeline. The raw bytes are only in the
		// .eml blob (the mailMessages row carries metadata, not content), so we
		// pull them here while the raw MIME is still in hand. Best-effort: a
		// failed capture never fails delivery (the message is already stored).
		try {
			await captureAttachments(ctx, rawBytes, args.messageId, args.from);
		} catch (err) {
			logError('[Mail Webhook] attachment capture failed', err);
		}

		return result;
	},
});

/**
 * Pull attachment leaves out of a delivered message's raw MIME and ingest each
 * into `semanticFiles` (source `email_attachment`). Inline parts (logos,
 * signatures) and oversized parts are skipped; the file-type allowlist is
 * enforced inside `semanticFiles.ingest`, which also drops the staged blob when
 * a part is rejected. Each file carries the source Message-ID as provenance.
 *
 * Captured files are scoped to the sender contact: `fromRaw` (the inbound From
 * header) is resolved to an EXISTING contact by email. When a contact matches,
 * the file is linked to it (`contactIds`), so it surfaces under that contact's
 * Files tab and is scoped to that contact in retrieval. Resolution is
 * find-only — an unknown sender leaves the file org-general (no contact link),
 * we never create a contact for every inbound sender. Thread-linking and
 * agent-output capture are intentionally out of scope here.
 *
 * The number of captured parts is capped at `ATTACHMENT_COMPOSE_LIMITS.maxCount`
 * per message. The inbound webhook is attacker-reachable (anyone can email a
 * provisioned mailbox) and each ingested file schedules a summarization +
 * embedding + knowledge-extraction LLM call, so without a cap a single crafted
 * .eml carrying many small attachment leaves would amplify per-message LLM cost.
 */
async function captureAttachments(
	ctx: {
		storage: { store: (blob: Blob) => Promise<Id<'_storage'>> };
		runMutation: ActionCtx['runMutation'];
		runQuery: ActionCtx['runQuery'];
	},
	rawBytes: Buffer,
	messageId: string,
	fromRaw: string
): Promise<void> {
	// The extractor wants a binary string (one char per byte) so binary parts survive.
	const binary = rawBytes.toString('latin1');
	const parts = extractAttachments(binary);

	// Scope captured files to the sender's EXISTING contact (find-only). A
	// missing/unresolvable sender leaves the file org-general — we do not create
	// a contact for every inbound message. Resolved once per message, not per part.
	const senderEmail = extractEmail(fromRaw);
	let senderContactIds: Id<'contacts'>[] | undefined;
	if (senderEmail) {
		const contact = await ctx.runQuery(internal.contacts.contacts.getByEmailForTeam, {
			email: senderEmail,
		});
		if (contact) senderContactIds = [contact._id];
	}

	let captured = 0;
	for (const part of parts) {
		// Bound the work per delivered message: each ingested part schedules
		// LLM calls (summarization + embedding + knowledge extraction), and the
		// inbound webhook is attacker-reachable, so a crafted .eml with many
		// small leaves must not amplify cost. Cap on captured (LLM-triggering)
		// parts so inline/oversized skips don't consume the budget.
		if (captured >= ATTACHMENT_COMPOSE_LIMITS.maxCount) break;
		// Skip inline parts (embedded logos / signature images) — they aren't
		// documents the user thinks of as "attachments".
		if (part.disposition === 'inline') continue;
		const size = part.bytes.byteLength;
		if (size === 0 || size > MAX_ATTACHMENT_BYTES) continue;

		const storageId = await ctx.storage.store(
			new Blob([Buffer.from(part.bytes)], { type: part.contentType })
		);
		// `ingest` runs the file-type policy and deletes the blob if rejected.
		await ctx.runMutation(internal.semanticFiles.ingest, {
			storageId,
			filename: part.filename,
			mimeType: part.contentType,
			fileSize: size,
			sourceType: 'email_attachment',
			sourceMessageId: messageId,
			contactIds: senderContactIds,
		});
		captured++;
	}
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
 * `externalDelivery.ingestExternalMessage` (external IMAP sync). Post-delivery
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
		envelopeFromDomain?: string;
		dkimSigningDomain?: string;
		/** Ingest-computed sender-impersonation heuristics (Sealed Mail A4). */
		senderHeuristics?: SenderHeuristics;
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
		textBodyInline: params.textBodyInline,
		textBodyStorageId: params.textBodyStorageId,
		htmlBodyInline: params.htmlBodyInline,
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
		envelopeFromDomain: params.envelopeFromDomain,
		dkimSigningDomain: params.dkimSigningDomain,
		senderHeuristics: params.senderHeuristics,
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

export const deliverToMailbox = internalMutation({
	args: {
		rawStorageId: v.id('_storage'),
		rawSize: v.number(),
		antiLoopHeaders: v.optional(v.record(v.string(), v.string())),
		// Parsed List-Unsubscribe target (extracted at ingest by the caller).
		unsubscribe: v.optional(mailUnsubscribeValidator),
		recipientAddress: v.string(),
		from: v.string(),
		to: v.array(v.string()),
		cc: v.array(v.string()),
		bcc: v.array(v.string()),
		replyTo: v.optional(v.string()),
		// SMTP envelope sender (RFC 5321 MAIL FROM); `''` for a bounce/DSN null
		// sender. Passed to the post-delivery hook so vacation auto-replies skip
		// bounces (RFC 3834 §2) keyed off the envelope, not the `From:` header.
		returnPath: v.optional(v.string()),
		subject: v.string(),
		textBodyInline: v.optional(v.string()),
		textBodyStorageId: v.optional(v.id('_storage')),
		htmlBodyInline: v.optional(v.string()),
		htmlBodyStorageId: v.optional(v.id('_storage')),
		snippet: v.optional(v.string()),
		messageId: v.string(),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		receivedAt: v.number(),
		attachments: v.array(mailMessageAttachmentValidator),
		spamScore: v.optional(v.number()),
		spamVerdict: v.optional(spamVerdictValidator),
		virusVerdict: v.optional(
			v.union(v.literal('clean'), v.literal('infected'), v.literal('skipped'))
		),
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		dmarcPolicy: v.optional(v.string()),
		// DMARC alignment inputs (envelope MAIL FROM domain + DKIM d= domain),
		// stored beside the verdicts on `mailMessages`. Both optional.
		envelopeFromDomain: v.optional(v.string()),
		dkimSigningDomain: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> => {
		const recipient = extractEmail(args.recipientAddress);
		const fromAddress = extractEmail(args.from);
		const rfc822MessageId = stripBrackets(args.messageId) ?? args.messageId;

		// 1. Resolve mailbox by address. Prefer the live hosted mailbox over an
		// external read-only archive when a move has left both on this address —
		// otherwise post-cutover inbound mail lands in the archive forever.
		const mailbox = await resolveDeliverableMailbox(ctx, recipient);
		if (!mailbox) {
			return { skipped: true };
		}

		// 2. Quota check
		if (mailbox.quotaBytes != null && mailbox.usedBytes + args.rawSize > mailbox.quotaBytes) {
			return { skipped: true };
		}

		// 3. Deduplication on Message-ID within this mailbox
		const dup = await ctx.db
			.query('mailMessages')
			.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', rfc822MessageId))
			.filter((q) => q.eq(q.field('mailboxId'), mailbox._id))
			.first();
		if (dup) {
			return { skipped: true };
		}

		// 3b. Content/spam scan for personal mailboxes.
		//
		// The MTA only runs @owlat/email-scanner on the OUTBOUND path, so mail
		// delivered into a hosted (Postbox) mailbox arrives with no spam/phishing
		// scoring at all. Run scanContent here when the inbound pipeline did not
		// already supply a verdict, so personal inboxes get the same keyword /
		// phishing-URL / caps-abuse scoring outbound mail does. An MTA-supplied
		// verdict (when present) always wins — we only fill the gap.
		let spamScore = args.spamScore;
		let spamVerdict = args.spamVerdict;
		if (spamScore == null && spamVerdict == null) {
			const scan = scanContent(args.subject, args.htmlBodyInline ?? args.textBodyInline ?? '', {
				from: args.from,
				replyTo: args.replyTo,
			});
			spamScore = scan.score;
			// `blocked` (score >= 40) is high enough confidence to route to Spam;
			// `suspicious`/`clean` stay in the inbox but keep their numeric score.
			spamVerdict = scan.level === 'blocked' ? 'spam' : 'ham';
		}

		// 4. Choose target folder (default INBOX; spam verdict → Spam).
		//    User filters can override the folder, set flags, attach labels,
		//    or short-circuit delivery entirely (`discard`).
		const filters = await ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', mailbox._id))
			.collect(); // bounded: one mailbox's filters
		const evalResult = evaluateFilters(filters, {
			from: fromAddress,
			to: args.to.map(extractEmail),
			cc: args.cc.map(extractEmail),
			subject: args.subject,
			bodyText: args.textBodyInline,
			bodyHtml: args.htmlBodyInline,
			size: args.rawSize,
			hasAttachment: args.attachments.length > 0,
		});

		// `discard` short-circuits — drop the message entirely (and its
		// staged storage blob) without writing it anywhere.
		if (evalResult.actions.some((a) => a.type === 'discard')) {
			return { skipped: true };
		}

		const moveAction = evalResult.actions.find((a) => a.type === 'moveToFolder');
		const labelActions = evalResult.actions.filter((a) => a.type === 'addLabel');
		const flagsFromFilters = {
			markRead: evalResult.actions.some((a) => a.type === 'markRead'),
			markFlagged: evalResult.actions.some((a) => a.type === 'markFlagged'),
		};
		const trashAction = evalResult.actions.some((a) => a.type === 'delete');
		const filterForwardTo = evalResult.actions
			.filter((a) => a.type === 'forward' && a.forwardTo)
			.map((a) => a.forwardTo as string);

		// A DMARC fail (RFC 7489) routes to Spam only when the From-domain owner
		// published an enforcing policy (`quarantine`/`reject`). A `p=none` fail
		// is monitor-only — record the verdict but do not move the message.
		const dmarcQuarantine =
			args.dmarcResult === 'fail' &&
			(args.dmarcPolicy === 'quarantine' || args.dmarcPolicy === 'reject');
		const initialRole =
			spamVerdict === 'spam' || args.virusVerdict === 'infected' || dmarcQuarantine
				? 'spam'
				: trashAction
					? 'trash'
					: 'inbox';
		const folder = moveAction?.folderId
			? await ctx.db.get(moveAction.folderId)
			: await ctx.db
					.query('mailFolders')
					.withIndex('by_mailbox_and_role', (q) =>
						q.eq('mailboxId', mailbox._id).eq('role', initialRole)
					)
					.first();
		if (!folder || folder.mailboxId !== mailbox._id) {
			return { skipped: true };
		}

		// 4b. Sender-impersonation heuristics (Sealed Mail A4). Computed on this
		// hosted-mailbox ingest path only — the same place the content scan runs —
		// so the reader's sender badge can surface first-time-sender and
		// lookalike-of-contact detail without re-parsing the raw .eml. Returns
		// undefined when nothing notable fired, so an unremarkable sender stores no
		// object at all.
		const senderHeuristics = await computeSenderHeuristics(ctx, {
			mailbox,
			fromAddress,
			from: args.from,
			replyTo: args.replyTo,
		});

		// 5-11. Threading, UID/modseq, insert, and folder/thread/usedBytes
		//       aggregates + audit — shared with external IMAP sync.
		const messageId = await insertDeliveredMessage(ctx, {
			mailbox,
			folder,
			rawStorageId: args.rawStorageId,
			rawSize: args.rawSize,
			from: args.from,
			to: args.to,
			cc: args.cc,
			bcc: args.bcc,
			replyTo: args.replyTo,
			subject: args.subject,
			textBodyInline: args.textBodyInline,
			textBodyStorageId: args.textBodyStorageId,
			htmlBodyInline: args.htmlBodyInline,
			htmlBodyStorageId: args.htmlBodyStorageId,
			snippet: args.snippet,
			messageId: args.messageId,
			inReplyTo: args.inReplyTo,
			references: args.references,
			receivedAt: args.receivedAt,
			attachments: args.attachments,
			flagSeen: flagsFromFilters.markRead,
			flagFlagged: flagsFromFilters.markFlagged,
			labelIds: labelActions.map((a) => a.labelId).filter((id): id is Id<'mailLabels'> => !!id),
			spamScore,
			spamVerdict,
			virusVerdict: args.virusVerdict,
			spfResult: args.spfResult,
			dkimResult: args.dkimResult,
			dmarcResult: args.dmarcResult,
			dmarcPolicy: args.dmarcPolicy,
			envelopeFromDomain: args.envelopeFromDomain,
			dkimSigningDomain: args.dkimSigningDomain,
			senderHeuristics,
			unsubscribe: args.unsubscribe,
			countUsedBytes: true,
		});

		// 11b. Reply Queue: enqueue needs-reply classification for the affected
		// thread — inbox deliveries only (spam/trash/filter-moved mail never
		// needs a reply prompt), and only on this webhook ingest path so bulk
		// IMAP backfill can't fan out background LLM work. The Precedence
		// header rides along because it is not persisted on the message row.
		const delivered = await ctx.db.get(messageId);
		if (delivered && folder.role === 'inbox') {
			await enqueueNeedsReplyCheck(ctx, delivered.threadId, {
				precedence: args.antiLoopHeaders?.['precedence'],
			});
			// Smart-inbox categories: classify the thread for the split-inbox
			// view (advisory, off by default in the UI). Same inbox-only bound as
			// the Reply Queue so bulk IMAP backfill never fans out LLM work.
			await enqueueCategoryCheck(ctx, delivered.threadId, {
				precedence: args.antiLoopHeaders?.['precedence'],
			});
		}

		// 11c. Follow-up reminders: any inbound delivery into a watched thread
		// means the awaited reply arrived — clear the watch silently. Mail routed
		// to Spam/Trash doesn't count as a reply.
		if (delivered && folder.role !== 'spam' && folder.role !== 'trash') {
			await clearThreadFollowUp(ctx, delivered.threadId);
			// Same signal for "snooze until they reply": the awaited reply landed,
			// so resurface the deferred message(s) now instead of at the cap.
			await clearSnoozeUntilReplyForThread(ctx, delivered.threadId, Date.now());
		}

		// 12. Post-delivery hooks — forwarding + vacation auto-reply.
		// Scheduled as an action so HTTP calls to the MTA happen in the
		// Node runtime; the mutation completes immediately.
		await ctx.scheduler.runAfter(0, internal.mail.deliveryHooks.runPostDelivery, {
			mailboxId: mailbox._id,
			mailboxAddress: mailbox.address,
			messageId,
			fromAddress,
			// SMTP envelope sender (RFC 5321 MAIL FROM). `''` for a bounce/DSN
			// null sender; the hook uses this to suppress vacation auto-replies
			// to bounces (RFC 3834 §2) off the envelope, not the `From:` header,
			// AND as the recipient of the auto-reply itself (RFC 3834 §4).
			returnPath: args.returnPath,
			// RFC Message-Id + References of the triggering inbound message, so the
			// vacation auto-reply threads onto it (RFC 3834 §3.1.5/§3.1.6) instead
			// of orphaning a new thread.
			triggeringMessageId: args.messageId,
			triggeringReferences: args.references,
			subject: args.subject,
			bodyText: args.textBodyInline,
			bodyHtml: args.htmlBodyInline,
			// Pass through the raw header map — the hook re-parses for
			// Auto-Submitted / List-Id / Precedence checks (RFC 3834), parsed at
			// ingest from the raw MIME header block.
			headers: args.antiLoopHeaders ?? {},
			// Filter-level "Forward to…" targets — forwarded alongside any
			// account-level forwarding rules by the post-delivery hook.
			filterForwardTo,
		});

		return { messageId };
	},
});
