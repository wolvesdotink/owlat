/**
 * Personal-mail delivery pipeline.
 *
 * Called by `apps/api/convex/mailWebhook.ts` after the MTA HMAC-verifies an
 * `inbound.mailbox.received` event. Stores raw .eml in ctx.storage, performs
 * RFC 5322 threading, allocates per-folder UID + modseq atomically, inserts
 * a mailMessages row, and updates folder/thread aggregates.
 *
 * This file is the Convex-function surface — the ingest action and the
 * delivery mutation, at their existing `internal.mail.delivery.*` paths. The
 * steps live beside it in `./deliveryPipeline/`:
 *
 *   ingest.ts   raw staging, decrypt-on-ingest, signature verify, body split
 *               (action-only)
 *   deferredCapture.ts  attachment capture, scheduled off the webhook
 *   scan.ts     the aggregate inbound malware verdict
 *   routing.ts  pure spam / filter / DMARC-ARC decisions
 *   mailboxDecision.ts  the delivery mutation's decisions as data: folder,
 *               row, post-delivery hook and answer
 *   insert.ts   dedup + quota checks, threading, UID+modseq, the row insert
 *               and its aggregates
 *   afterInsert.ts  classifier enqueues, follow-up / snooze-until-reply and
 *               Reply Queue clears (shared with external IMAP sync)
 *   ingestFields.ts  the argument validators every ingest entry point shares
 *
 * (`deliveryPipeline/` rather than `delivery/` so it never reads as a sibling
 * of the top-level `convex/delivery/` campaign send domain.)
 *
 * Threading order:
 *   1. In-Reply-To header → existing message by rfc822MessageId
 *   2. References header → any referenced message
 *   3. Fallback: mailbox + normalized subject (24h window)
 */

import { v } from 'convex/values';
import { spamVerdictValidator } from '../lib/convexValidators';
import { internalAction } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { extractEmail } from '../lib/emailAddress';
import { logError } from '../lib/runtimeLog';
import { computeSenderHeuristics } from './senderHeuristics';
import { resolveDeliverableMailbox } from './mailbox/addressResolution';
import { prepareInboundMessage } from './deliveryPipeline/ingest';
import {
	indexStagedAttachments,
	markCaptureFailed,
	scheduleStagedCapture,
	stagedCaptureArgs,
} from './deliveryPipeline/deferredCapture';
import { mailboxIndexableParts } from './deliveryPipeline/scan';
import {
	dropStagedBlobs,
	findDuplicateInMailbox,
	insertDeliveredMessage,
	isOverQuota,
} from './deliveryPipeline/insert';
import { runPostInsertInboundEffects } from './deliveryPipeline/afterInsert';
import { applySenderStatusAtDelivery, evaluateArrivalRules } from './arrival/hooks';
import { getOrThrow } from '../_utils/errors';
import { settleSenderDelivery } from './senders/delivery';
import { withMailboxUsage } from './mailboxUsage';
import { partBlobIds, recordStoredParts, stageMessageParts } from './messageParts';
import { deliveredEnvelopeFields, mailboxDeliveryFields } from './deliveryPipeline/ingestFields';
import type { DmarcOverride } from './deliveryPipeline/routing';
import {
	deliveredMessageInput,
	deliveryAnswer,
	filterDelivery,
	postDeliveryHookArgs,
	routeDelivery,
	targetFolderRole,
} from './deliveryPipeline/mailboxDecision';
import { virusVerdictValidator } from '../lib/literalValidators';
import {
	mailboxGateSignals,
	resolveAttachmentGate,
	type SettledRouting,
} from './deliveryPipeline/captureGate';

/** `deliverToMailbox`'s answer, with the routing it settled for the capture step. */
type DeliveryResult =
	| ({ messageId: Id<'mailMessages'>; dmarcOverride?: DmarcOverride } & SettledRouting)
	| { skipped: true };

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
		...deliveredEnvelopeFields,
		// SMTP envelope sender (RFC 5321 MAIL FROM); `''` for a bounce/DSN null
		// sender. Threaded to the post-delivery hook to suppress vacation
		// auto-replies to bounces (RFC 3834 §2). Optional for older MTA builds.
		returnPath: v.optional(v.string()),
		textBody: v.optional(v.string()),
		htmlBody: v.optional(v.string()),
		date: v.optional(v.number()),
		spamScore: v.optional(v.number()),
		spamVerdict: v.optional(spamVerdictValidator),
		virusVerdict: v.optional(virusVerdictValidator),
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		dmarcPolicy: v.optional(v.string()),
		// Verified inbound ARC verdict (RFC 8617, Sealed Mail A5) — used to rescue a
		// DMARC fail when a TRUSTED forwarder sealed a valid chain attesting the
		// original passed. All optional (an older MTA omits them ⇒ no rescue).
		arcCv: v.optional(v.string()),
		arcSealerDomain: v.optional(v.string()),
		arcAttestsOriginalPass: v.optional(v.boolean()),
		// DMARC alignment inputs (envelope MAIL FROM domain + DKIM d= domain),
		// stored beside the verdicts on `mailMessages`. Both optional.
		envelopeFromDomain: v.optional(v.string()),
		dkimSigningDomain: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> => {
		const prepared = await prepareInboundMessage(ctx, args);
		// Each attachment leaf as its own sealed blob, cut out while the bytes are
		// in hand and the scan's walk is fresh (plan 3.5). Only mail that lists
		// attachments: the reader's downloads and the invite card hang off that
		// list, so a message without one has nothing to serve.
		const storedParts =
			args.attachments.length > 0
				? await stageMessageParts(ctx, prepared.rawBinary, prepared.scan.leaves ?? [])
				: undefined;

		const result: DeliveryResult = await ctx.runMutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId: prepared.rawStorageId,
			rawSize: prepared.rawSize,
			antiLoopHeaders: prepared.antiLoopHeaders,
			unsubscribe: prepared.unsubscribe,
			recipientAddress: args.recipientAddress,
			from: args.from,
			to: args.to,
			cc: args.cc,
			bcc: args.bcc,
			replyTo: args.replyTo,
			returnPath: args.returnPath,
			subject: prepared.subject,
			textBodyInline: prepared.text.inline,
			textBodyStorageId: prepared.text.storageId,
			htmlBodyInline: prepared.html.inline,
			htmlBodyStorageId: prepared.html.storageId,
			snippet: prepared.snippet,
			searchBody: prepared.searchBody,
			messageId: args.messageId,
			inReplyTo: args.inReplyTo,
			references: args.references,
			receivedAt: args.date ?? Date.now(),
			attachments: args.attachments,
			spamScore: args.spamScore,
			spamVerdict: args.spamVerdict,
			virusVerdict: prepared.virusVerdict,
			spfResult: args.spfResult,
			dkimResult: args.dkimResult,
			dmarcResult: args.dmarcResult,
			dmarcPolicy: args.dmarcPolicy,
			arcCv: args.arcCv,
			arcSealerDomain: args.arcSealerDomain,
			arcAttestsOriginalPass: args.arcAttestsOriginalPass,
			envelopeFromDomain: args.envelopeFromDomain,
			dkimSigningDomain: args.dkimSigningDomain,
			inboundEncryptionInfo: prepared.inboundEncryptionInfo,
			inboundSignatureInfo: prepared.inboundSignatureInfo,
			storedParts,
		});

		// If delivery was skipped (no mailbox / quota / dup), drop the staged blobs.
		if ('skipped' in result) {
			await dropStagedBlobs(ctx, [
				prepared.rawStorageId,
				prepared.text.storageId,
				prepared.html.storageId,
				...(storedParts ? partBlobIds(storedParts) : []),
			]);
			return result;
		}

		// Capture real attachments into the semantic file library so they show
		// up under the "Email attachments" source filter on /dashboard/files and
		// flow into the file→knowledge pipeline. The raw bytes are only in the
		// .eml blob (the mailMessages row carries metadata, not content), so the
		// eligible parts are staged here while the raw MIME is still in hand —
		// and the indexing itself is SCHEDULED, not awaited: the MTA waits on
		// this action with a 10 s deadline and re-POSTs the whole message on a
		// timeout (see `deliveryPipeline/deferredCapture.ts`). Best-effort: a
		// failed capture never fails delivery (the message is already stored).
		try {
			// WHICH LEAVES MAY BE INDEXED and WHAT WAS WITHHELD, as one pair from one
			// place: `mailboxIndexableParts` owns the whole policy, including the
			// "nobody scanned it" branch (`/scan/attachment` fails open, so without
			// the optional `clamav` sidecar the verdict is a defined `'skipped'`).
			const { parts, withheld } = mailboxIndexableParts(prepared.scan);
			// L6, behind `attachmentGates` (off by default).
			const gateSkip = await resolveAttachmentGate(ctx, mailboxGateSignals(result, prepared));
			await scheduleStagedCapture(ctx, {
				mailMessageId: result.messageId,
				gateSkip,
				parts,
				withheld,
				messageId: args.messageId,
				from: args.from,
				// Postbox captures are OUT OF RANGE of the inbound retention sweep:
				// the personal mailbox keeps its raw `.eml` permanently and has no
				// horizon, so a shared-inbox window must never strip its file-library
				// blobs. `captureSource` is what keeps the two apart.
				captureSource: 'mailbox',
				auth: {
					dmarcResult: args.dmarcResult,
					spfResult: args.spfResult,
					dkimResult: args.dkimResult,
					envelopeFromDomain: args.envelopeFromDomain,
					dkimSigningDomain: args.dkimSigningDomain,
					// The SETTLED DMARC verdict, not the raw one. A trusted ARC
					// forwarder's valid seal rescues a `fail` for routing
					// (`resolveDmarcRouting`, applied inside the mutation above),
					// and a rescue the reader's inbox honours but the capture gate
					// refuses is two different answers to one question: forwarded
					// mail from an old Google Workspace account would land in the
					// inbox with its attachments silently unindexed.
					dmarcOverride: 'dmarcOverride' in result ? result.dmarcOverride : undefined,
				},
			});
		} catch (err) {
			logError('[Mail Webhook] attachment capture failed', err);
			await markCaptureFailed(ctx, result.messageId);
		}

		return result;
	},
});

/**
 * Scheduled by {@link ingestFromWebhook}: index the attachment parts it staged.
 * A mutation, so it runs exactly once — see `deliveryPipeline/deferredCapture.ts`.
 */
export const captureStagedAttachments = internalMutation({
	args: stagedCaptureArgs,
	handler: async (ctx, args) => {
		await indexStagedAttachments(ctx, args);
	},
});

/**
 * Deliver one staged message into the hosted mailbox it is addressed to. The
 * decisions live in `./deliveryPipeline/mailboxDecision.ts`; this mutation
 * loads, asks them, and writes, in this order.
 */
export const deliverToMailbox = internalMutation({
	args: mailboxDeliveryFields,
	handler: async (ctx, args): Promise<DeliveryResult> => {
		// 1. Resolve mailbox by address. Prefer the live hosted mailbox over an
		// external read-only archive when a move has left both on this address —
		// otherwise post-cutover inbound mail lands in the archive forever.
		const mailbox = await resolveDeliverableMailbox(ctx, extractEmail(args.recipientAddress));
		if (!mailbox) {
			return { skipped: true };
		}

		// 2. Quota check: a full hosted mailbox refuses the message.
		if (isOverQuota(await withMailboxUsage(ctx.db, mailbox), args.rawSize)) {
			return { skipped: true };
		}

		// 3. Deduplication on Message-ID within this mailbox
		if (await findDuplicateInMailbox(ctx, mailbox._id, args.messageId)) {
			return { skipped: true };
		}

		// 3b-4. Content/spam scan for personal mailboxes (fills the gap the MTA's
		// outbound-only scan leaves; an MTA-supplied verdict always wins), then
		// the user filters: they can override the folder, set flags, attach
		// labels, or short-circuit delivery entirely (`discard`: the message and
		// its staged blob are dropped without writing anything).
		const filters = await ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', mailbox._id))
			.collect(); // bounded: one mailbox's filters
		const filtered = filterDelivery(args, filters);
		if (filtered.filter.isDiscarded) {
			return { skipped: true };
		}

		// ARC rescue + the DMARC quarantine decision, settled against the
		// operator's trusted-forwarder allow-list.
		const settings = await ctx.db.query('instanceSettings').first();
		const routing = routeDelivery(args, filtered, settings?.trustedArcForwarders);

		// 4a. Sender status (§5) after user filters, only for mail headed for the Inbox.
		const senderStatus = await applySenderStatusAtDelivery(ctx, {
			mailboxId: mailbox._id,
			fromAddress: args.from,
			origin: 'mx',
			isMovedByFilter: routing.isMovedByFilter,
		});
		const folder = routing.filter.folderId
			? await ctx.db.get(routing.filter.folderId)
			: await ctx.db
					.query('mailFolders')
					.withIndex('by_mailbox_and_role', (q) =>
						q.eq('mailboxId', mailbox._id).eq('role', targetFolderRole(routing, senderStatus))
					)
					.first();
		if (!folder || folder.mailboxId !== mailbox._id) {
			return { skipped: true };
		}

		// 4b. Sender-impersonation heuristics (Sealed Mail A4), on this hosted path
		// only, for the reader's sender badge; undefined when nothing notable fired.
		const senderHeuristics = await computeSenderHeuristics(ctx, {
			mailbox,
			fromAddress: routing.fromAddress,
			from: args.from,
			replyTo: args.replyTo,
		});

		// 5-11. Threading, UID/modseq, insert, and folder/thread/usedBytes
		//       aggregates + audit — shared with external IMAP sync.
		const messageId = await insertDeliveredMessage(
			ctx,
			deliveredMessageInput(args, routing, { mailbox, folder, senderStatus, senderHeuristics })
		);

		// 11a. Plain-language and AI rules (§6.2), ranked against the manual pass.
		const arrival = await evaluateArrivalRules(ctx, {
			message: await getOrThrow(ctx, messageId, 'Message'),
			mailboxId: mailbox._id,
			origin: 'mx',
			manualPass: routing.filter.manualPass,
		});
		// 11b. Classifier enqueues, follow-up / snooze-until-reply clears and the
		// owner-reply Reply Queue settle — the tail shared with IMAP sync.
		await runPostInsertInboundEffects(ctx, {
			messageId,
			folder,
			origin: 'mx',
			antiLoopHeaders: args.antiLoopHeaders,
			arrival,
		});
		// 11b, senders: count the delivery, stamp the status outcome on the record.
		await settleSenderDelivery(ctx, { messageId, origin: 'mx', senderStatus });

		// 11c. The attachment parts the ingest action stored on their own, so the
		// reader downloads one part instead of the whole raw message (plan 3.5).
		if (args.storedParts) await recordStoredParts(ctx, args.rawStorageId, args.storedParts);

		// 12. Post-delivery hooks — forwarding + vacation auto-reply.
		// Scheduled as an action so HTTP calls to the MTA happen in the
		// Node runtime; the mutation completes immediately.
		await ctx.scheduler.runAfter(
			0,
			internal.mail.deliveryHooks.runPostDelivery,
			postDeliveryHookArgs(args, routing, mailbox, messageId)
		);

		return deliveryAnswer(messageId, routing, folder);
	},
});
