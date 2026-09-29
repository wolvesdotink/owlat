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
 *   ingest.ts   raw staging, decrypt-on-ingest, signature verify, body split,
 *               attachment capture (action-only)
 *   scan.ts     the aggregate inbound malware verdict
 *   routing.ts  pure spam / filter / DMARC-ARC decisions
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
import { mailUnsubscribeValidator } from '../lib/mailContentValidators';
import { internalMutation, internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { extractEmail } from '../lib/emailAddress';
import { logError } from '../lib/runtimeLog';
import { computeSenderHeuristics } from './senderHeuristics';
import { inboundEncryptionInfoValidator } from '../e2ee/inboundSeal';
import { inboundSignatureInfoValidator } from '../e2ee/inboundSignature';
import { resolveDeliverableMailbox } from './mailbox/addressResolution';
import { prepareInboundMessage } from './deliveryPipeline/ingest';
import { captureAttachments } from './deliveryPipeline/capture';
import { mailboxIndexableParts } from './deliveryPipeline/scan';
import {
	dropStagedBlobs,
	findDuplicateInMailbox,
	insertDeliveredMessage,
	isOverQuota,
} from './deliveryPipeline/insert';
import { runPostInsertInboundEffects } from './deliveryPipeline/afterInsert';
import { deliveredEnvelopeFields, storedBodyFields } from './deliveryPipeline/ingestFields';
import {
	resolveDmarcRouting,
	type DmarcOverride,
	resolveFilterOutcome,
	resolveSpamVerdict,
} from './deliveryPipeline/routing';
import { virusVerdictValidator } from '../lib/literalValidators';

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

		const result:
			| { messageId: Id<'mailMessages'>; dmarcOverride?: DmarcOverride }
			| { skipped: true } = await ctx.runMutation(internal.mail.delivery.deliverToMailbox, {
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
		});

		// If delivery was skipped (no mailbox / quota / dup), drop the staged blobs.
		if ('skipped' in result) {
			await dropStagedBlobs(ctx, [
				prepared.rawStorageId,
				prepared.text.storageId,
				prepared.html.storageId,
			]);
			return result;
		}

		// Capture real attachments into the semantic file library so they show
		// up under the "Email attachments" source filter on /dashboard/files and
		// flow into the file→knowledge pipeline. The raw bytes are only in the
		// .eml blob (the mailMessages row carries metadata, not content), so we
		// pull them here while the raw MIME is still in hand. Best-effort: a
		// failed capture never fails delivery (the message is already stored).
		try {
			// WHICH LEAVES MAY BE INDEXED and WHAT WAS WITHHELD, as one pair from
			// one place — `mailboxIndexableParts` owns the whole policy, including
			// the "nobody scanned it" branch this route keeps and the team inbox
			// does not. Two ternaries here testing the same condition could
			// disagree, and the condition they tested (`verdict !== undefined`)
			// was the wrong question: `/scan/attachment` fails open, so on a
			// deployment running without the optional `clamav` sidecar the verdict
			// is a perfectly defined `'skipped'` with nothing cleared, and this
			// route quietly stopped capturing anything at all.
			const { parts, withheld } = mailboxIndexableParts(prepared.scan);
			await captureAttachments(ctx, {
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
		}

		return result;
	},
});

export const deliverToMailbox = internalMutation({
	args: {
		...deliveredEnvelopeFields,
		...storedBodyFields,
		antiLoopHeaders: v.optional(v.record(v.string(), v.string())),
		// Parsed List-Unsubscribe target (extracted at ingest by the caller).
		unsubscribe: v.optional(mailUnsubscribeValidator),
		recipientAddress: v.string(),
		// SMTP envelope sender (RFC 5321 MAIL FROM); `''` for a bounce/DSN null
		// sender. Passed to the post-delivery hook so vacation auto-replies skip
		// bounces (RFC 3834 §2) keyed off the envelope, not the `From:` header.
		returnPath: v.optional(v.string()),
		spamScore: v.optional(v.number()),
		spamVerdict: v.optional(spamVerdictValidator),
		virusVerdict: v.optional(virusVerdictValidator),
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		dmarcPolicy: v.optional(v.string()),
		// Verified inbound ARC verdict (RFC 8617, Sealed Mail A5). Rescues a DMARC
		// fail when a TRUSTED forwarder sealed a valid chain attesting the original
		// passed. All optional (older MTA ⇒ absent ⇒ no rescue).
		arcCv: v.optional(v.string()),
		arcSealerDomain: v.optional(v.string()),
		arcAttestsOriginalPass: v.optional(v.boolean()),
		// DMARC alignment inputs (envelope MAIL FROM domain + DKIM d= domain),
		// stored beside the verdicts on `mailMessages`. Both optional.
		envelopeFromDomain: v.optional(v.string()),
		dkimSigningDomain: v.optional(v.string()),
		// Sealed Mail (E4, D3): the inbound unsealing outcome, computed by the
		// ingest action before this mutation. Present only for a message that
		// arrived sealed; the body args above already hold the RESTORED plaintext
		// when it decrypted. Absent ⇒ a plaintext message (unchanged fast path).
		inboundEncryptionInfo: v.optional(inboundEncryptionInfoValidator),
		// Inbound signature verdict (F1, D9), computed by the ingest action for a
		// SIGNED-but-not-encrypted message. Data only — never affects routing.
		inboundSignatureInfo: v.optional(inboundSignatureInfoValidator),
	},
	handler: async (
		ctx,
		args
	): Promise<
		{ messageId: Id<'mailMessages'>; dmarcOverride?: DmarcOverride } | { skipped: true }
	> => {
		const recipient = extractEmail(args.recipientAddress);
		const fromAddress = extractEmail(args.from);

		// 1. Resolve mailbox by address. Prefer the live hosted mailbox over an
		// external read-only archive when a move has left both on this address —
		// otherwise post-cutover inbound mail lands in the archive forever.
		const mailbox = await resolveDeliverableMailbox(ctx, recipient);
		if (!mailbox) {
			return { skipped: true };
		}

		// 2. Quota check: a full hosted mailbox refuses the message.
		if (isOverQuota(mailbox, args.rawSize)) {
			return { skipped: true };
		}

		// 3. Deduplication on Message-ID within this mailbox
		if (await findDuplicateInMailbox(ctx, mailbox._id, args.messageId)) {
			return { skipped: true };
		}

		// 3b. Content/spam scan for personal mailboxes (fills the gap the MTA's
		// outbound-only scan leaves; an MTA-supplied verdict always wins).
		const { spamScore, spamVerdict } = resolveSpamVerdict({
			subject: args.subject,
			bodyHtmlInline: args.htmlBodyInline,
			bodyTextInline: args.textBodyInline,
			from: args.from,
			replyTo: args.replyTo,
			spamScore: args.spamScore,
			spamVerdict: args.spamVerdict,
		});

		// 4. Choose target folder (default INBOX; spam verdict → Spam).
		//    User filters can override the folder, set flags, attach labels,
		//    or short-circuit delivery entirely (`discard`).
		const filters = await ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', mailbox._id))
			.collect(); // bounded: one mailbox's filters
		const filterOutcome = resolveFilterOutcome(filters, {
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
		if (filterOutcome.isDiscarded) {
			return { skipped: true };
		}

		// ARC rescue + the DMARC quarantine decision (RFC 8617 / RFC 7489),
		// settled against the operator's trusted-forwarder allow-list.
		const settings = await ctx.db.query('instanceSettings').first();
		const { dmarcOverride, arcSealer, isDmarcQuarantine } = resolveDmarcRouting(
			args,
			settings?.trustedArcForwarders
		);

		const initialRole =
			spamVerdict === 'spam' || args.virusVerdict === 'infected' || isDmarcQuarantine
				? 'spam'
				: filterOutcome.isTrashed
					? 'trash'
					: 'inbox';
		const folder = filterOutcome.folderId
			? await ctx.db.get(filterOutcome.folderId)
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
			searchBody: args.searchBody,
			messageId: args.messageId,
			inReplyTo: args.inReplyTo,
			references: args.references,
			receivedAt: args.receivedAt,
			attachments: args.attachments,
			flagSeen: filterOutcome.flagSeen,
			flagFlagged: filterOutcome.flagFlagged,
			labelIds: filterOutcome.labelIds,
			spamScore,
			spamVerdict,
			virusVerdict: args.virusVerdict,
			spfResult: args.spfResult,
			dkimResult: args.dkimResult,
			dmarcResult: args.dmarcResult,
			dmarcPolicy: args.dmarcPolicy,
			dmarcOverride,
			arcSealer,
			envelopeFromDomain: args.envelopeFromDomain,
			dkimSigningDomain: args.dkimSigningDomain,
			senderHeuristics,
			inboundEncryptionInfo: args.inboundEncryptionInfo,
			inboundSignatureInfo: args.inboundSignatureInfo,
			unsubscribe: args.unsubscribe,
			pinnedSection: filterOutcome.pinnedSection,
			countUsedBytes: true,
		});

		// 11b. Classifier enqueues, follow-up / snooze-until-reply clears and the
		// owner-reply Reply Queue settle — the tail shared with IMAP sync.
		await runPostInsertInboundEffects(ctx, {
			messageId,
			folder,
			origin: 'mx',
			antiLoopHeaders: args.antiLoopHeaders,
		});

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
			filterForwardTo: filterOutcome.filterForwardTo,
		});

		// `dmarcOverride` travels back so the capture step in the ingest action
		// gates on the SAME settled verdict this mutation routed on, rather than
		// re-deciding the ARC rescue against a second read of the allow-list.
		return { messageId, dmarcOverride };
	},
});
