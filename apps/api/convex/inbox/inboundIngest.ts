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
 * ORDERING IS THE INVARIANT: the row is inserted BEFORE capture, and every step
 * after it is wrapped so it cannot throw outward. Mail that arrived is never
 * lost to a failure in the optional enrichment that follows it — and the staged
 * blob is dropped on every exit that does not end in a row referencing it, so a
 * failure leaves no orphan bytes behind either.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { base64ToBytes, bytesToBinaryString } from '../lib/bytes';
import { storeSealedBlob } from '../lib/sealedBlob';
import { getMtaConfig } from '../mail/mtaClient';
import { scanInboundAttachments, type InboundScanResult } from '../mail/deliveryPipeline/scan';
import {
	captureAttachments,
	type AttachmentCaptureOutcome,
} from '../mail/deliveryPipeline/capture';
import { NOTHING_UNCLEARED } from '../mail/deliveryPipeline/attachmentParts';
import { resolveDmarcRouting, type DmarcOverride } from '../mail/deliveryPipeline/routing';
import { inboundEmailMessageValidator } from '../webhooks/adapters/inboundRegistry';
import type { AttachmentIndexing } from '../lib/literalValidators';
import { logError, logWarn } from '../lib/runtimeLog';
import { deleteBlobQuietly } from '../lib/storageBlobs';
import { receiveInboundMail } from './receiveInbound';

/** A staged raw message: sealed into storage, decoded, and scanned. */
type StagedRaw = {
	rawStorageId: Id<'_storage'>;
	rawSize: number;
	/**
	 * The scan — its verdict, the leaves it CLEARED, every leaf the message
	 * carries, and what it could not clear, per cause.
	 *
	 * A verdict of `undefined` means NOTHING WAS SCANNED, and "no scanner
	 * configured" and "no attachment leaves" are told apart by `candidates`,
	 * not by the verdict: storing `undefined` as `'clean'` would be a claim we
	 * cannot make, and warning about a message that has no files at all is a
	 * warning about nothing.
	 */
	scan: InboundScanResult;
};

/**
 * Decode, seal and scan the raw message, or answer `null` when there is
 * nothing usable to seal.
 *
 * Its own step so the handler below reads as pre-check → stage → persist →
 * capture.
 */
async function stageRawMessage(
	ctx: ActionCtx,
	rawBytesBase64: string,
	messageId: string
): Promise<StagedRaw | null> {
	const rawBytes = base64ToBytes(rawBytesBase64);
	// `base64ToBytes` answers undecodable input with ZERO BYTES rather than
	// throwing (`lib/bytes.ts` says so, and says the ingest paths must refuse it
	// themselves). A real RFC822 message is never empty, so a zero-byte decode is
	// a corrupt payload, not a message: sealing it would write a `rawStorageId`
	// the reader believes in and offer a download that extracts nothing and can
	// never be retried into working. Fall through to the no-raw path instead,
	// which renders honestly.
	if (rawBytes.byteLength === 0) {
		logWarn('[Inbound Webhook] rawBytesBase64 decoded to zero bytes — stored without raw', {
			messageId,
		});
		return null;
	}

	// E8b: sealed at rest under INSTANCE_SECRET (plaintext passthrough when
	// unset). The reader's download re-serves it through /sealed-blob.
	const rawStorageId = await storeSealedBlob(ctx.storage, rawBytes, 'message/rfc822');
	const rawBinary = bytesToBinaryString(rawBytes);

	// Defense-in-depth on the receiving side: ClamAV lives in the MTA container,
	// so each non-inline leaf is POSTed to its /scan/attachment.
	//
	// NEVER THROWS OUTWARD. The scan walks attacker-supplied MIME, and a walker
	// that threw here — a truncated multipart, a header the parser chokes on —
	// would 500 the route on a message the MTA has already accepted over SMTP,
	// which means six retries and then the DLQ. An unscannable message is
	// treated as unscanned: it is stored, listed and downloadable, and nothing
	// in it is ever fed to a model.
	let scan: InboundScanResult;
	try {
		scan = await scanInboundAttachments(getMtaConfig(), rawBinary);
	} catch (err) {
		logError('[Inbound Webhook] attachment scan failed — message stored unscanned', err);
		// Nothing was cleared, so nothing can be indexed. The candidate list is
		// unknowable once the walk itself threw, so it stays empty and the gap is
		// recorded as one UNSCANNED leaf — the honest floor: this message HAS
		// something we could not look at, which is what the reader is told.
		scan = {
			verdict: 'skipped',
			cleanParts: [],
			candidates: [],
			typeRefusedParts: [],
			uncleared: { ...NOTHING_UNCLEARED, unscanned: 1 },
			scannerAnswered: false,
		};
	}

	return { rawStorageId, rawSize: rawBytes.byteLength, scan };
}

export const ingestFromWebhook = internalAction({
	args: {
		mail: inboundEmailMessageValidator,
		/**
		 * The whole message as base64 RFC822. Optional: an MTA older than the
		 * route split, or a DLQ event queued before it, delivers the same mail
		 * with no bytes — and so does a message whose payload did not fit the
		 * action-argument budget. That message is stored normally — it just has
		 * no raw blob, no attachments and no antivirus verdict.
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
			{ messageId: args.mail.messageId, from: args.mail.from, to: args.mail.to }
		);
		if (alreadyStored) {
			return { inboundMessageId: alreadyStored, isDuplicate: true };
		}

		const staged = args.rawBytesBase64
			? await stageRawMessage(ctx, args.rawBytesBase64, args.mail.messageId)
			: null;

		let received;
		try {
			received = await receiveInboundMail(ctx, args.mail, {
				rawStorageId: staged?.rawStorageId,
				rawSize: staged?.rawSize,
				virusVerdict: staged?.scan.verdict,
			});
		} catch (err) {
			// The blob was sealed before the row was written, so a mutation that
			// throws — a transient db error, a scheduler failure — would otherwise
			// leave bytes nothing references and the retention sweep never sees
			// (it walks rows, not storage). Drop them and let the MTA retry into a
			// clean slate.
			await dropStagedBlob(ctx, staged?.rawStorageId, args.mail.messageId);
			throw err;
		}
		const { inboundMessageId, isDuplicate } = received;

		// Lost the race with a concurrent retry: the transactional check inside
		// `receiveMessage` found the row this attempt was about to duplicate. Drop
		// the blob we staged — nothing references it — and stop before capture, so
		// the attachment budget is charged once per message rather than once per
		// MTA retry.
		if (isDuplicate) {
			await dropStagedBlob(ctx, staged?.rawStorageId, args.mail.messageId);
			return { inboundMessageId, isDuplicate: true };
		}

		// CONFIRMED MALWARE: nothing is extracted, nothing is indexed, nothing
		// reaches a model. `receiveMessage` has already quarantined the row and
		// skipped the agent pipeline. The sealed blob deliberately STAYS, so an
		// operator can still investigate what was sent — the message is never
		// dropped, it is only stopped from being acted on.
		if (!staged || staged.scan.verdict === 'infected') {
			return { inboundMessageId, isDuplicate: false };
		}

		// NOTHING UNSCANNED REACHES A MODEL, and the mechanism is the SET rather
		// than the verdict: `scan.cleanParts` is exactly the leaves the scanner
		// opened and cleared, and it is the only thing capture is given. A
		// scanner that is unreachable, not configured, or out of per-message
		// budget clears nothing, so nothing is indexed — without a second filter
		// anywhere that could disagree with the first about which leaf is which.
		//
		// The message, its metadata and its downloadable `.eml` all still exist
		// either way; the row records what happened so the reader can say it
		// instead of rendering an unindexed file like an indexed one.
		const { cleanParts, uncleared } = staged.scan;

		// THE SETTLED DMARC VERDICT, not the raw one. A trusted forwarder's valid
		// ARC seal rescues a `fail` for mail that only failed because forwarding
		// broke the author's DKIM (RFC 8617) — the personal-mailbox route has
		// honoured that for routing since Sealed Mail A5, and the same rule
		// decides here whether a forwarded invoice may be filed under the contact
		// who really sent it. One spelling of the rescue: `resolveDmarcRouting`,
		// against the operator's own allow-list. Never fatal — a settings read
		// that fails leaves the message on its raw verdict rather than losing it.
		let dmarcOverride: DmarcOverride | undefined;
		try {
			const trustedForwarders: string[] | null = await ctx.runQuery(
				internal.workspaces.settings.getTrustedArcForwarders,
				{}
			);
			// `null` over the wire is the `undefined` the query returned — and
			// `undefined` is NOT `[]` here: unset means the seeded defaults,
			// while an explicit empty list disables the rescue.
			dmarcOverride = resolveDmarcRouting(args.mail, trustedForwarders ?? undefined).dmarcOverride;
		} catch (err) {
			logWarn('[Inbound Webhook] could not read the trusted ARC forwarders', {
				messageId: args.mail.messageId,
				err,
			});
		}

		// Attachment capture is best-effort by construction and runs AFTER the
		// insert, so it cannot fail delivery. It is called even when the scan
		// cleared NOTHING — with an empty parts list it indexes nothing and
		// simply reports why, which is how the one message that has no leaves at
		// all stays silent while the one whose leaves nobody could look at says
		// so. One decision, in one place, rather than a second marker ladder
		// here that told a file-type refusal and a ClamAV outage apart wrong.
		//
		// The file-type allowlist, the per-part size ceilings, the sender→contact
		// scoping, the unverifiable-From refusal and the AI-ingest budget all
		// live inside `captureAttachments`, shared with the personal-mailbox
		// route so the two cannot enforce different policy.
		try {
			const outcome = await captureAttachments(ctx, {
				parts: cleanParts,
				withheld: uncleared,
				messageId: args.mail.messageId,
				from: args.mail.from,
				// Only team-inbox captures are in range of the inbound retention
				// sweep — the personal mailbox keeps its files permanently.
				captureSource: 'team_inbox',
				// A `From:` DMARC could not verify is not evidence of who sent
				// this, so none of its files are indexed at all. The MTA sends no
				// alignment domains on this wire below its raw-route version; an
				// absent one simply cannot align, which fails closed.
				auth: {
					dmarcResult: args.mail.dmarcResult,
					spfResult: args.mail.spfResult,
					dkimResult: args.mail.dkimResult,
					envelopeFromDomain: args.mail.envelopeFromDomain,
					dkimSigningDomain: args.mail.dkimSigningDomain,
					dmarcOverride,
				},
			});
			await recordCaptureOutcome(ctx, inboundMessageId, outcome);
		} catch (err) {
			logError('[Inbound Webhook] attachment capture failed', err);
			// THE LAST SILENT EXIT. Capture can throw after the row exists — the
			// contact lookup, the budget mutation, or `storage.store` failing with
			// three of five parts already ingested — and an unmarked row renders
			// exactly like one the assistant read cover to cover. `markIndexing`
			// never throws, so saying so here cannot cost the delivery.
			await markIndexing(ctx, inboundMessageId, 'skipped_failed');
		}

		return { inboundMessageId, isDuplicate: false };
	},
});

/**
 * Drop a raw blob no row will ever reference.
 *
 * Never throws: every caller is on a path where the mail is already handled,
 * and turning a leaked blob into a 500 would make the MTA retry a delivery that
 * is complete. A failure is logged instead, because otherwise it is invisible —
 * the retention sweep walks rows, and no row points here. The try/log policy
 * itself is `lib/storageBlobs`, shared with the erasure cascade, the retention
 * sweep and the dev reset.
 */
async function dropStagedBlob(
	ctx: ActionCtx,
	rawStorageId: Id<'_storage'> | undefined,
	messageId: string
): Promise<void> {
	if (!rawStorageId) return;
	await deleteBlobQuietly(ctx.storage, rawStorageId, '[Inbound Webhook] staged raw', { messageId });
}

/**
 * The marker each skip reason renders as.
 *
 * A TOTAL table, not a ternary chain: `satisfies` makes a new
 * `AttachmentCaptureOutcome['skippedReason']` member a compile error here
 * instead of a row that silently renders as though the assistant had read the
 * file — the exact defect these markers exist to close.
 */
const SKIP_MARKERS = {
	unverified: 'skipped_unverified',
	budget: 'skipped_budget',
	unscanned: 'skipped_unscanned',
	cap: 'skipped_cap',
	refused_type: 'skipped_refused_type',
	too_large: 'skipped_too_large',
	unsupported_type: 'skipped_unsupported',
} as const satisfies Record<
	NonNullable<AttachmentCaptureOutcome['skippedReason']>,
	AttachmentIndexing
>;

/**
 * Turn what capture did into the marker the thread view reads.
 *
 * EVERY outcome is recorded, not just the budget one: a part refused for its
 * size or its type is exactly as unread by the assistant as one the budget
 * refused, and an unmarked row renders as though the file had been indexed.
 */
async function recordCaptureOutcome(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	outcome: AttachmentCaptureOutcome
): Promise<void> {
	const marker = pickIndexingMarker(outcome);
	if (marker) await markIndexing(ctx, inboundMessageId, marker);
}

/**
 * Which single line this outcome renders as, or none.
 *
 * A skip outranks the placeholder note: "the assistant has not read some of
 * these" is the stronger sentence, and only one line is rendered. An if-ladder
 * rather than a three-level ternary, because the ORDER is the policy and a
 * reader should not have to re-associate `?:` to see it.
 */
function pickIndexingMarker(outcome: AttachmentCaptureOutcome): AttachmentIndexing | undefined {
	if (outcome.skippedReason) return SKIP_MARKERS[outcome.skippedReason];
	if (outcome.indexed === 0) return undefined;
	return outcome.namesOnly ? 'indexed_placeholder' : 'indexed';
}

/** Record the capture outcome on the row; never fails the ingest. */
async function markIndexing(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	attachmentIndexing: AttachmentIndexing
): Promise<void> {
	try {
		await ctx.runMutation(internal.inbox.messages.setAttachmentIndexing, {
			inboundMessageId,
			attachmentIndexing,
		});
	} catch (err) {
		// The mail is already stored. A marker that could not be written is a
		// reader losing one line of context, not a delivery to retry — and the
		// contract this function advertises to its callers is that it never
		// fails the ingest, which only a catch here makes true.
		logError('[Inbound Webhook] could not record attachment indexing', err);
	}
}
