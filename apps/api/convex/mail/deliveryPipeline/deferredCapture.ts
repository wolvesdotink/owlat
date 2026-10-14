/**
 * Personal-mailbox attachment capture, taken OFF the MTA webhook.
 *
 * The capture used to be awaited inside `mail.delivery.ingestFromWebhook`
 * after the row insert: a contact lookup, a budget charge, then one blob store
 * and one `semanticFiles.ingest` per part, in series. The MTA gives the
 * notifier 10 s; a message with a handful of attachments could spend that on
 * indexing work the sender does not wait for, and a timeout makes the MTA
 * re-POST the whole message.
 *
 * So the webhook now does only the pure half ({@link planCapture}: select,
 * verify) and stages the eligible parts' bytes as blobs, in parallel. It
 * schedules {@link indexStagedAttachments} with the STORAGE IDS — never the
 * bytes, which would ride through the scheduler's argument size limit — and
 * returns. The scheduled step scopes, charges and ingests.
 *
 * IDEMPOTENT BY CONSTRUCTION:
 *   · capture is only scheduled for a FRESH insert. A re-POST of the same
 *     message is a duplicate to `deliverToMailbox`, answers `skipped`, and
 *     stages and schedules nothing;
 *   · the scheduled step is a MUTATION, which Convex runs exactly once, and it
 *     charges the budget and inserts every file in one transaction — it cannot
 *     half-run and be retried into a second charge;
 *   · a staged blob that is already gone is skipped rather than ingested as a
 *     row that points at nothing.
 */

import { v, type ObjectType } from 'convex/values';
import type { ActionCtx, MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { captureSourceValidator } from '../../lib/literalValidators';
import {
	planCapture,
	summarizeCapture,
	type AttachmentCaptureOutcome,
	type CaptureAttachmentsInput,
} from './capture';
import { ingestStoredPart, scopeAndChargeBudget, type IndexedPart } from './captureIndex';
import { dropStagedBlobs } from './insert';
import { captureSkipReasonValidator, indexingMarkerOf } from './captureMarker';
import { logError } from '../../lib/runtimeLog';
import type { Id } from '../../_generated/dataModel';

/** Arguments of `internal.mail.delivery.captureStagedAttachments`. */
export const stagedCaptureArgs = {
	/** The source Message-ID, recorded on every captured file as provenance. */
	messageId: v.string(),
	/** The raw `From:` header, resolved to a contact for scoping. */
	from: v.string(),
	captureSource: captureSourceValidator,
	/**
	 * The delivered message, whose `attachmentIndexing` marker records what the
	 * scheduled step did. Optional for jobs a previous release scheduled
	 * (remove after release N+1): those record nothing, as before.
	 */
	mailMessageId: v.optional(v.id('mailMessages')),
	/**
	 * Why the webhook's plan left some of the message's parts out (capped,
	 * refused, too large) while staging the rest: the scheduled step's outcome
	 * keeps it, so one accepted file never marks the message fully read.
	 * Optional for jobs a previous release scheduled (remove after N+1).
	 */
	skippedReason: v.optional(captureSkipReasonValidator),
	/** The eligible parts, already in storage, in capture order. */
	parts: v.array(
		v.object({
			storageId: v.id('_storage'),
			filename: v.string(),
			contentType: v.string(),
			size: v.number(),
		})
	),
};

export type StagedCaptureArgs = ObjectType<typeof stagedCaptureArgs>;

/**
 * The webhook half: decide, stage the bytes, schedule the rest.
 *
 * Nothing is staged for a message with nothing to index or an unverifiable
 * sender — {@link planCapture} settles those without I/O. A staging or
 * scheduling failure drops whatever was already stored and rethrows, so the
 * caller's best-effort catch never leaves orphaned blobs behind.
 */
export async function scheduleStagedCapture(
	ctx: Pick<ActionCtx, 'storage' | 'scheduler' | 'runMutation'>,
	input: CaptureAttachmentsInput & { mailMessageId?: Id<'mailMessages'> }
): Promise<{ scheduled: number }> {
	const plan = planCapture(input);
	if ('outcome' in plan) {
		// Settled here (a gate, an unverifiable sender, nothing indexable):
		// the message says so, as the Team Inbox row does.
		const marker = indexingMarkerOf(plan.outcome);
		if (marker && input.mailMessageId) {
			await ctx.runMutation(
				internal.mail.deliveryPipeline.captureMarker.setMailAttachmentIndexing,
				{
					mailMessageId: input.mailMessageId,
					attachmentIndexing: marker,
				}
			);
		}
		return { scheduled: 0 };
	}

	const settled = await Promise.allSettled(
		plan.eligible.map((part) =>
			ctx.storage.store(new Blob([part.bytes], { type: part.contentType }))
		)
	);
	const storageIds = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
	try {
		const failed = settled.find((r) => r.status === 'rejected');
		if (failed) throw failed.reason;
		await ctx.scheduler.runAfter(0, internal.mail.delivery.captureStagedAttachments, {
			messageId: input.messageId,
			from: input.from,
			captureSource: input.captureSource,
			...(input.mailMessageId ? { mailMessageId: input.mailMessageId } : {}),
			...(plan.skippedReason ? { skippedReason: plan.skippedReason } : {}),
			parts: plan.eligible.map((part, i) => ({
				storageId: storageIds[i]!,
				filename: part.filename,
				contentType: part.contentType,
				size: part.bytes.byteLength,
			})),
		});
	} catch (err) {
		await dropStagedBlobs(ctx, storageIds);
		throw err;
	}
	return { scheduled: storageIds.length };
}

/**
 * The scheduled half: scope to the sender's contact, charge the AI-ingest
 * budget, ingest each staged part. A refused budget deletes the staged blobs —
 * the message's own `.eml` still carries the bytes, so the download is intact.
 */
export async function indexStagedAttachments(
	ctx: MutationCtx,
	args: StagedCaptureArgs
): Promise<AttachmentCaptureOutcome> {
	const outcome = await indexStaged(ctx, args);
	const marker = indexingMarkerOf(outcome);
	if (marker && args.mailMessageId && (await ctx.db.get(args.mailMessageId))) {
		await ctx.db.patch(args.mailMessageId, { attachmentIndexing: marker });
	}
	return outcome;
}

async function indexStaged(
	ctx: MutationCtx,
	args: StagedCaptureArgs
): Promise<AttachmentCaptureOutcome> {
	const present: StagedCaptureArgs['parts'] = [];
	for (const part of args.parts) {
		if (await ctx.db.system.get(part.storageId)) present.push(part);
	}
	if (present.length === 0) {
		return { indexed: 0, ...(args.skippedReason ? { skippedReason: args.skippedReason } : {}) };
	}

	const scope = await scopeAndChargeBudget(ctx, {
		from: args.from,
		messageId: args.messageId,
		count: present.length,
	});
	if (!scope) {
		await dropStagedBlobs(
			ctx,
			present.map((part) => part.storageId)
		);
		return { indexed: 0, skippedReason: 'budget' };
	}

	// The mailbox comes from the delivered message, not the job's arguments:
	// it decides who may read the captured files (lib/semanticFileAccess.ts).
	// A job from a previous release has no message id, and its files stay
	// with owners and admins.
	const message = args.mailMessageId ? await ctx.db.get(args.mailMessageId) : null;
	const results: IndexedPart[] = [];
	for (const part of present) {
		results.push(
			await ingestStoredPart(ctx, part, {
				messageId: args.messageId,
				captureSource: args.captureSource,
				...(message ? { sourceMailboxId: message.mailboxId } : {}),
				contactIds: scope.contactIds,
			})
		);
	}
	return summarizeCapture(results, args.skippedReason);
}

/**
 * The webhook's capture threw after the message was stored: say so on the
 * message rather than leave it looking fully indexed. Never throws (the
 * delivery already succeeded).
 */
export async function markCaptureFailed(
	ctx: Pick<ActionCtx, 'runMutation'>,
	mailMessageId: Id<'mailMessages'>
): Promise<void> {
	try {
		await ctx.runMutation(internal.mail.deliveryPipeline.captureMarker.setMailAttachmentIndexing, {
			mailMessageId,
			attachmentIndexing: 'skipped_failed',
		});
	} catch (err) {
		logError('[Mail Webhook] could not record attachment indexing', err);
	}
}
