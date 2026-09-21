'use node';

/**
 * Upload-based archive import (idea 50) — the runner.
 *
 * One pass over an uploaded archive: read a window of bytes, cut messages out
 * of it with `@owlat/shared/mboxArchive`, parse each with
 * `@owlat/mail-message`, insert it through the shared delivered-message path,
 * commit the byte offset, and reschedule itself until the file is consumed.
 *
 * WHY A BUDGET PER RUN. An archive can hold tens of thousands of messages and a
 * Convex action has a lifetime; a single greedy pass would die partway through
 * with nothing recorded. Each pass therefore stops at whichever budget it hits
 * first and commits, so the job's `cursorBytes` always names a point the mailbox
 * actually reached. A pass that throws leaves that offset intact and the retry
 * re-reads only from there — and since inserts dedup on Message-ID, re-reading
 * the tail of a committed batch inserts nothing twice.
 *
 * The archive is decoded as latin1 (one char per byte) exactly as `loadRawEml`
 * decodes a single `.eml`: the parser wants the binary-safe form, and it is what
 * keeps a byte offset a byte offset.
 *
 * `'use node'` because the parse side of `@owlat/mail-message` hands attachment
 * bytes back as a `Buffer`.
 */

import { v } from 'convex/values';
import { parseMessage, type AddressObject } from '@owlat/mail-message';
import { MboxSplitter, type MboxEntry } from '@owlat/shared/mboxArchive';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { storeSealedBlob } from '../lib/sealedBlob';
import { splitBodyForStorage } from './deliveryPipeline/ingest';
import { buildSnippet } from './deliveryPipeline/insert';
import { buildSearchBody } from './searchBody';

/** Bytes decoded at a time. Small enough that a `.mbox` never lands whole in a string. */
const WINDOW_BYTES = 512 * 1024;
/** Bytes one pass consumes before it commits and reschedules. */
const RUN_BYTE_BUDGET = 4 * 1024 * 1024;
/** Messages one pass inserts before it commits and reschedules. */
const RUN_MESSAGE_BUDGET = 200;

/** Fallback for an archive entry whose `Date:` is missing or unparseable. */
function receivedAtOf(date: Date | undefined, fallback: number): number {
	const value = date?.getTime();
	return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/** Every address in a parsed header, flattened through RFC 5322 groups. */
function addressList(field: AddressObject | AddressObject[] | undefined): string[] {
	const objects = field === undefined ? [] : Array.isArray(field) ? field : [field];
	const out: string[] = [];
	for (const object of objects) {
		for (const entry of object.value) {
			if (entry.address) out.push(entry.address);
			for (const member of entry.group ?? []) {
				if (member.address) out.push(member.address);
			}
		}
	}
	return out;
}

/** The first address of a header, for the single-valued `From:` / `Reply-To:`. */
function firstAddress(field: AddressObject | AddressObject[] | undefined): string | undefined {
	return addressList(field)[0];
}

/** A header value that is a plain string, or undefined for the structured ones. */
function headerText(headers: Map<string, unknown>, name: string): string | undefined {
	const value = headers.get(name);
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
	return undefined;
}

/** latin1 bytes of a binary-safe string (the inverse of the decode above). */
function latin1Bytes(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);
	for (let index = 0; index < value.length; index++) {
		bytes[index] = value.charCodeAt(index) & 0xff;
	}
	return bytes;
}

type IngestOutcome = { imported: boolean; skipped: boolean; labelsCreated: number };

/**
 * Parse one archive entry and hand it to the insert mutation.
 *
 * A message the parser cannot make sense of is COUNTED as skipped rather than
 * failing the archive: one corrupt entry in a ten-year Takeout must not cost
 * the user the other 40,000.
 */
async function ingestEntry(
	ctx: ActionCtx,
	job: Doc<'mailArchiveImports'>,
	entry: MboxEntry
): Promise<IngestOutcome> {
	let parsed;
	try {
		parsed = parseMessage(entry.raw);
	} catch {
		return { imported: false, skipped: true, labelsCreated: 0 };
	}

	const rawBytes = latin1Bytes(entry.raw);
	const rawStorageId: Id<'_storage'> = await storeSealedBlob(
		ctx.storage,
		rawBytes,
		'message/rfc822'
	);
	const text = parsed.text;
	const html = parsed.html === false ? undefined : parsed.html;
	const textBody = await splitBodyForStorage(ctx, text, 'text/plain; charset=utf-8');
	const htmlBody = await splitBodyForStorage(ctx, html, 'text/html; charset=utf-8');
	const references = Array.isArray(parsed.references)
		? parsed.references.join(' ')
		: parsed.references;

	return await ctx.runMutation(internal.mail.archiveImport.ingestArchiveMessage, {
		importId: job._id,
		// The default for an archive with no Gmail label header. `.eml` files and
		// third-party `.mbox` exports carry no folder at all, and Archive is the
		// honest place for mail whose folder we do not know: nothing is hidden,
		// and nothing pretends to still need attention in the inbox.
		folderRole: 'archive' as const,
		rawStorageId,
		rawSize: rawBytes.length,
		// The `From_` line's envelope sender is the fallback when the header is
		// missing — it is what the exporting client recorded for this message.
		from: firstAddress(parsed.from) ?? entry.envelopeSender,
		to: addressList(parsed.to),
		cc: addressList(parsed.cc),
		bcc: addressList(parsed.bcc),
		replyTo: firstAddress(parsed.replyTo),
		subject: parsed.subject ?? '',
		textBodyInline: textBody.inline,
		textBodyStorageId: textBody.storageId,
		htmlBodyInline: htmlBody.inline,
		htmlBodyStorageId: htmlBody.storageId,
		snippet: buildSnippet(text, html),
		searchBody: buildSearchBody(text, html),
		// An archive entry without a Message-ID gets a synthetic one so it still
		// threads and still dedups on a re-import of the same file.
		messageId: parsed.messageId ?? `archive-${job._id}-${entry.startOffset}@owlat.invalid`,
		inReplyTo: parsed.inReplyTo,
		references,
		receivedAt: receivedAtOf(parsed.date, job.startedAt),
		// Attachment BYTES stay in the raw `.eml`, which the reader already
		// extracts from client-side; only the index travels.
		attachments: parsed.attachments.map((attachment, index) => ({
			filename: attachment.filename,
			contentType: attachment.contentType,
			size: attachment.size,
			...(attachment.contentId ? { contentId: attachment.contentId } : {}),
			partIndex: String(index),
		})),
		...(headerText(parsed.headers, 'x-gmail-labels')
			? { gmailLabels: headerText(parsed.headers, 'x-gmail-labels') }
			: {}),
	});
}

/**
 * Consume the next slice of an archive.
 *
 * Reschedules itself while bytes remain and the job is still importing; closes
 * the job when the file is consumed or when something unrecoverable happened.
 */
export const runChunk = internalAction({
	args: { importId: v.id('mailArchiveImports') },
	handler: async (ctx, args): Promise<void> => {
		const job: Doc<'mailArchiveImports'> | null = await ctx.runQuery(
			internal.mail.archiveImport.loadJob,
			{ importId: args.importId }
		);
		if (!job || job.status !== 'importing') return;
		if (!job.storageId) {
			await ctx.runMutation(internal.mail.archiveImport.finishJob, {
				importId: args.importId,
				status: 'failed',
				lastError: 'The uploaded archive is no longer available.',
			});
			return;
		}

		const blob = await ctx.storage.get(job.storageId);
		if (!blob) {
			await ctx.runMutation(internal.mail.archiveImport.finishJob, {
				importId: args.importId,
				status: 'failed',
				lastError: 'The uploaded archive is no longer available.',
			});
			return;
		}
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const decoder = new TextDecoder('latin1');

		let imported = 0;
		let skipped = 0;
		let labelsCreated = 0;
		let cursor = Math.min(job.cursorBytes, bytes.length);
		const consume = async (entries: MboxEntry[]) => {
			for (const entry of entries) {
				const outcome = await ingestEntry(ctx, job, entry);
				if (outcome.imported) imported++;
				if (outcome.skipped) skipped++;
				labelsCreated += outcome.labelsCreated;
			}
		};

		try {
			if (job.format === 'eml') {
				// A single `.eml` is the whole file, with no separator line to find.
				if (cursor < bytes.length) {
					await consume([
						{
							raw: decoder.decode(bytes.subarray(cursor)),
							envelopeSender: '',
							startOffset: cursor,
							endOffset: bytes.length,
						},
					]);
				}
				cursor = bytes.length;
			} else {
				const resumeFrom = cursor;
				const splitter = new MboxSplitter(resumeFrom);
				let read = resumeFrom;
				while (read < bytes.length) {
					// Only stop where the NEXT pass would start further along. A message
					// bigger than one budget would otherwise re-read the same window
					// forever, each pass committing the offset it began at.
					const canCommitForward = splitter.pendingOffset > resumeFrom;
					const budgetSpent =
						read - resumeFrom >= RUN_BYTE_BUDGET || imported + skipped >= RUN_MESSAGE_BUDGET;
					if (canCommitForward && budgetSpent) break;
					const end = Math.min(bytes.length, read + WINDOW_BYTES);
					const entries = splitter.push(decoder.decode(bytes.subarray(read, end)));
					read = end;
					await consume(entries);
				}
				// The archive's last message has no separator after it.
				if (read >= bytes.length) {
					await consume(splitter.flush());
					cursor = bytes.length;
				} else {
					cursor = splitter.pendingOffset;
				}
			}
		} catch (error) {
			// Commit what this pass did manage before surfacing the failure, so a
			// retry does not re-walk messages the mailbox already holds.
			await ctx.runMutation(internal.mail.archiveImport.recordProgress, {
				importId: args.importId,
				cursorBytes: cursor,
				importedDelta: imported,
				skippedDelta: skipped,
				labelsCreatedDelta: labelsCreated,
			});
			await ctx.runMutation(internal.mail.archiveImport.finishJob, {
				importId: args.importId,
				status: 'failed',
				lastError: error instanceof Error ? error.message : 'The archive could not be read.',
			});
			return;
		}

		const progress: { stillImporting: boolean } = await ctx.runMutation(
			internal.mail.archiveImport.recordProgress,
			{
				importId: args.importId,
				cursorBytes: cursor,
				importedDelta: imported,
				skippedDelta: skipped,
				labelsCreatedDelta: labelsCreated,
			}
		);
		// Cancelled mid-pass: stop here rather than rescheduling. The messages this
		// pass inserted stay — they are real mail now.
		if (!progress.stillImporting) return;

		if (cursor >= bytes.length) {
			await ctx.runMutation(internal.mail.archiveImport.finishJob, {
				importId: args.importId,
				status: 'completed',
			});
			return;
		}
		await ctx.scheduler.runAfter(0, internal.mail.archiveImportRun.runChunk, {
			importId: args.importId,
		});
	},
});
