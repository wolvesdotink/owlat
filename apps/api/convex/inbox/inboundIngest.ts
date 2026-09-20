/**
 * Team-inbox ingest — the raw-bytes half of `POST /webhooks/mta-inbound`.
 *
 * Seals the received `.eml`, scans its attachment leaves for malware, persists
 * the message, and then — only for a message whose attachments came back
 * CLEAN — captures them into the semantic file library so they reach the
 * agent's `[RELEVANT FILES]` retrieval.
 *
 * NOT `'use node'`. Like `mail/delivery.ts`, this runs in the Convex V8 isolate
 * (which has no `Buffer`; `lib/bytes.ts` owns the conversions) and delegates to
 * Node actions through `ctx.runAction` where one is needed. Adding `'use node'`
 * would move the whole module's runtime.
 *
 * ORDERING IS THE INVARIANT: the row is inserted BEFORE capture, and capture is
 * wrapped so it cannot throw outward. Mail that arrived is never lost to a
 * failure in the optional enrichment that follows it.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { base64ToBytes, bytesToBinaryString } from '../lib/bytes';
import { storeSealedBlob } from '../lib/sealedBlob';
import { getMtaConfig } from '../mail/mtaClient';
import { scanInboundAttachments } from '../mail/deliveryPipeline/scan';
import { captureAttachments } from '../mail/deliveryPipeline/ingest';
import type { AttachmentIndexing, VirusVerdict } from '../lib/literalValidators';
import { logError, logWarn } from '../lib/runtimeLog';
import { receiveInboundMail } from './receiveInbound';

/**
 * The normalized inbound message, as `webhooks/adapters/inboundRegistry.ts`
 * produces it. Mirrors `InboundEmailMessage` field for field; the two are kept
 * in step by the handler's assignment, which is a compile error when they drift.
 */
const inboundMailValidator = v.object({
	from: v.string(),
	to: v.string(),
	subject: v.string(),
	textBody: v.optional(v.string()),
	htmlBody: v.optional(v.string()),
	headers: v.record(v.string(), v.string()),
	messageId: v.string(),
	inReplyTo: v.optional(v.string()),
	references: v.optional(v.string()),
	attachments: v.array(
		v.object({
			filename: v.optional(v.string()),
			contentType: v.string(),
			size: v.number(),
			partIndex: v.optional(v.string()),
		})
	),
	timestamp: v.number(),
	spfResult: v.optional(v.string()),
	dkimResult: v.optional(v.string()),
	dmarcResult: v.optional(v.string()),
	dmarcPolicy: v.optional(v.string()),
});

export const ingestFromWebhook = internalAction({
	args: {
		mail: inboundMailValidator,
		/**
		 * The whole message as base64 RFC822. Optional: an MTA older than the
		 * route split, or a DLQ event queued before it, delivers the same mail
		 * with no bytes. That message is stored normally — it just has no raw
		 * blob, no attachments and no antivirus verdict.
		 */
		rawBytesBase64: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ inboundMessageId: Id<'inboundMessages'>; isDuplicate: boolean }> => {
		// IDEMPOTENCY, first pass. The MTA gives its webhook fetch 10 s and then
		// retries — but aborting the client does not stop this action, so a slow
		// scan means the same message arrives again while the first attempt is
		// still running. The transactional check is inside `receiveMessage`; this
		// one is here to avoid re-sealing a 10 MiB blob and re-running up to ten
		// ClamAV round-trips for a message we have already stored.
		const alreadyStored: Id<'inboundMessages'> | null = await ctx.runQuery(
			internal.inbox.messages.findIdByMessageId,
			{ messageId: args.mail.messageId }
		);
		if (alreadyStored) {
			return { inboundMessageId: alreadyStored, isDuplicate: true };
		}

		let rawStorageId: Id<'_storage'> | undefined;
		let rawSize: number | undefined;
		let rawBinary: string | undefined;
		let virusVerdict: VirusVerdict | undefined;

		if (args.rawBytesBase64) {
			const rawBytes = base64ToBytes(args.rawBytesBase64);
			// `base64ToBytes` answers undecodable input with ZERO BYTES rather than
			// throwing (`lib/bytes.ts` says so, and says the ingest paths must
			// refuse it themselves). A real RFC822 message is never empty, so a
			// zero-byte decode is a corrupt payload, not a message: sealing it
			// would write a `rawStorageId` the reader believes in and offer a
			// download that extracts nothing and can never be retried into working.
			// Fall through to the no-raw path instead, which renders honestly.
			if (rawBytes.byteLength === 0) {
				logWarn('[Inbound Webhook] rawBytesBase64 decoded to zero bytes — stored without raw', {
					messageId: args.mail.messageId,
				});
			} else {
				rawSize = rawBytes.byteLength;
				// E8b: sealed at rest under INSTANCE_SECRET (plaintext passthrough
				// when unset). The reader's download re-serves it through
				// /sealed-blob.
				rawStorageId = await storeSealedBlob(ctx.storage, rawBytes, 'message/rfc822');
				rawBinary = bytesToBinaryString(rawBytes);

				// Defense-in-depth on the receiving side: ClamAV lives in the MTA
				// container, so each non-inline leaf is POSTed to its
				// /scan/attachment. `undefined` here means NOTHING WAS SCANNED —
				// either the scanner is not configured or there are no attachment
				// leaves — and the two are indistinguishable, so no verdict is
				// asserted. Storing `undefined` as `'clean'` would be a claim we
				// cannot make.
				virusVerdict = await scanInboundAttachments(getMtaConfig(), rawBinary);
			}
		}

		const { inboundMessageId, isDuplicate } = await receiveInboundMail(ctx, args.mail, {
			rawStorageId,
			rawSize,
			virusVerdict,
		});

		// Lost the race with a concurrent retry: the transactional check inside
		// `receiveMessage` found the row this attempt was about to duplicate. Drop
		// the blob we staged — nothing references it — and stop before capture, so
		// the attachment budget is charged once per message rather than once per
		// MTA retry.
		if (isDuplicate) {
			if (rawStorageId) await ctx.storage.delete(rawStorageId);
			return { inboundMessageId, isDuplicate: true };
		}

		// CONFIRMED MALWARE: nothing is extracted, nothing is indexed, nothing
		// reaches a model. `receiveMessage` has already quarantined the row and
		// skipped the agent pipeline. The sealed blob deliberately STAYS, so an
		// operator can still investigate what was sent — the message is never
		// dropped, it is only stopped from being acted on.
		if (virusVerdict === 'infected' || !rawBinary) {
			return { inboundMessageId, isDuplicate: false };
		}

		// NOTHING UNSCANNED REACHES A MODEL. Capture runs on a `'clean'` verdict
		// and on nothing else. `'skipped'` means the scanner was configured and
		// unreachable; `undefined` means it is not configured at all (or there was
		// no attachment leaf to scan, in which case there is nothing to capture
		// anyway). Feeding either to summarise + embed + knowledge extraction
		// would hand attacker-supplied bytes to the model on a route any sender
		// can reach. The message, its metadata and its downloadable `.eml` all
		// still exist — and the row says why nothing was indexed, so the reader
		// can say it too instead of rendering an unindexed file like an indexed
		// one.
		if (virusVerdict !== 'clean') {
			// Only worth recording when there was something to index: a plain
			// message with no attachment leaves is not "unscanned", it is empty.
			if (args.mail.attachments.length > 0) {
				await markIndexing(ctx, inboundMessageId, 'skipped_unscanned');
			}
			return { inboundMessageId, isDuplicate: false };
		}

		// Attachment capture is best-effort by construction and runs AFTER the
		// insert, so it cannot fail delivery. The file-type allowlist, the
		// per-part size ceilings, the 10-part cap, the sender→contact scoping and
		// the AI-ingest budget all live inside `captureAttachments`, shared with
		// the personal-mailbox route so the two cannot enforce different policy.
		try {
			const outcome = await captureAttachments(
				ctx,
				rawBinary,
				args.mail.messageId,
				args.mail.from,
				{
					// Only team-inbox captures are in range of the inbound retention
					// sweep — the personal mailbox keeps its files permanently.
					captureSource: 'team_inbox',
					// A `From:` that DMARC failed is not evidence of who sent this, so
					// the files are not filed under the contact it claimed to be.
					dmarcResult: args.mail.dmarcResult,
				}
			);
			if (outcome.skippedReason === 'budget') {
				await markIndexing(ctx, inboundMessageId, 'skipped_budget');
			} else if (outcome.indexed > 0) {
				await markIndexing(ctx, inboundMessageId, 'indexed');
			}
		} catch (err) {
			logError('[Inbound Webhook] attachment capture failed', err);
		}

		return { inboundMessageId, isDuplicate: false };
	},
});

/** Record the capture outcome on the row; never fails the ingest. */
async function markIndexing(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	attachmentIndexing: AttachmentIndexing
): Promise<void> {
	await ctx.runMutation(internal.inbox.messages.setAttachmentIndexing, {
		inboundMessageId,
		attachmentIndexing,
	});
}
