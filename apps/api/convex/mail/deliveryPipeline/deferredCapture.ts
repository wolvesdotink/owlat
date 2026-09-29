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

/** Arguments of `internal.mail.delivery.captureStagedAttachments`. */
export const stagedCaptureArgs = {
	/** The source Message-ID, recorded on every captured file as provenance. */
	messageId: v.string(),
	/** The raw `From:` header, resolved to a contact for scoping. */
	from: v.string(),
	captureSource: captureSourceValidator,
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
	ctx: Pick<ActionCtx, 'storage' | 'scheduler'>,
	input: CaptureAttachmentsInput
): Promise<{ scheduled: number }> {
	const plan = planCapture(input);
	if ('outcome' in plan) return { scheduled: 0 };

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
	const present: StagedCaptureArgs['parts'] = [];
	for (const part of args.parts) {
		if (await ctx.db.system.get(part.storageId)) present.push(part);
	}
	if (present.length === 0) return { indexed: 0 };

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

	const results: IndexedPart[] = [];
	for (const part of present) {
		results.push(
			await ingestStoredPart(ctx, part, {
				messageId: args.messageId,
				captureSource: args.captureSource,
				contactIds: scope.contactIds,
			})
		);
	}
	return summarizeCapture(results, undefined);
}
