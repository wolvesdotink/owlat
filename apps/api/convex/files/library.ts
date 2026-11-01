/**
 * The Files library: reading one file, uploading, editing and deleting, and
 * the server-side ingestion of attachments and agent artifacts.
 *
 * File storage with embedding-based retrieval and auto-tagging. Files uploaded
 * or received as attachments are indexed with text extraction, AI-generated
 * summaries, and vector embeddings for semantic search
 * (`files/processing.ts`). The pipeline's own reads and writes are in
 * `files/pipeline.ts`.
 */

import { v, type ObjectType } from 'convex/values';
import { consumeUpload, deleteOwnedUpload, storedFileSize } from '../storage/uploads';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { authedQuery, authedMutation, adminMutation } from '../lib/authedFunctions';
import {
	hasPermission,
	requirePermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { isSharedInboxReader } from '../inbox/access';
import { semanticFileReadGate } from '../lib/semanticFileAccess';
import { throwInvalidInput } from '../_utils/errors';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import {
	isExtensionAllowed,
	isMimeTypeAllowed,
	isExecutableExtension,
	isFileTypeAccepted,
	detectDoubleExtension,
	DEFAULT_FILE_POLICY,
} from '@owlat/email-scanner';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';
import { buildFileSearchableText } from '../lib/fileSearchText';
import { patchCorpusRow } from '../lib/aiRouting/embeddingActivation';
import type { Id, Doc } from '../_generated/dataModel';
import {
	captureSourceValidator,
	semanticFileSourceTypeValidator,
	type CaptureSource,
} from '../lib/literalValidators';
import { dropExtractionProgress } from '../knowledge/extractionProgress';
import { hydrateFile } from '../lib/semanticFileCards';

// ============================================================
// Queries
// ============================================================

/**
 * Get a file by ID. A file captured from inbound mail is only returned to
 * someone who may read the mailbox it arrived in (lib/semanticFileAccess.ts).
 *
 * The conversation link follows the shared-inbox reader rule
 * (inbox/access.ts): handing any other member the linked thread's id — let
 * alone its SUBJECT, which is customer text from a mailbox they cannot open —
 * would leak the inbox through the file library. A reader gets the subject
 * inline: one point-read to label the link and prefill the picker, instead of
 * pulling the whole thread through `inbox.queries.getThread`.
 */
// authz: readLibraryFile applies semanticFileReadGate and the shared-inbox reader rule.
export const get = authedQuery({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args, session) => await readLibraryFile(ctx, args.fileId, session),
});

/** The body of `get`. */
export async function readLibraryFile(
	ctx: QueryCtx,
	fileId: Id<'semanticFiles'>,
	session: MutationSessionContext
) {
	const file = await ctx.db.get(fileId);
	const canReadSemanticFile = semanticFileReadGate(ctx, session);
	if (!file || !(await canReadSemanticFile(file))) return null;
	const hydrated = await hydrateFile(ctx, file);
	if (!isSharedInboxReader(session)) {
		return { ...hydrated, threadId: undefined, threadSubject: undefined };
	}
	const thread = file.threadId ? await ctx.db.get(file.threadId) : null;
	return { ...hydrated, threadSubject: thread?.subject };
}

// ============================================================
// Mutations
// ============================================================

/** `create`'s arguments. */
export const createFileArgs = {
	storageId: v.id('_storage'),
	filename: v.string(),
	mimeType: v.string(),
	fileSize: v.number(),
	title: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
	sourceType: semanticFileSourceTypeValidator,
	sourceMessageId: v.optional(v.string()),
	uploadContext: v.optional(v.string()),
	contactIds: v.optional(v.array(v.id('contacts'))),
	threadId: v.optional(v.id('conversationThreads')),
	previousVersionId: v.optional(v.id('semanticFiles')),
};

/**
 * Upload a new file (user-facing)
 */
// authz: createLibraryFile requires organization:manage (requirePermission).
export const create = authedMutation({
	args: createFileArgs,
	handler: async (ctx, args, session) => await createLibraryFile(ctx, args, session),
});

/** The body of `create`. */
export async function createLibraryFile(
	ctx: MutationCtx,
	args: ObjectType<typeof createFileArgs>,
	session: MutationSessionContext
): Promise<Id<'semanticFiles'>> {
	validateStringLength(args.filename, STRING_LIMITS.FILENAME, 'filename');
	validateStringLength(args.mimeType, STRING_LIMITS.MIME_TYPE, 'mimeType');
	if (args.title !== undefined) validateStringLength(args.title, STRING_LIMITS.NAME, 'title');
	for (const tag of args.tags ?? []) validateStringLength(tag, STRING_LIMITS.TAG, 'Tag');
	if (args.uploadContext !== undefined)
		validateStringLength(args.uploadContext, STRING_LIMITS.DESCRIPTION, 'uploadContext');

	requirePermission(
		hasPermission(session.role, 'organization:manage'),
		'Only owners and admins can perform this action'
	);

	// Security: validate file type before storing the record, matching the
	// media library (workspaces/mediaAssets.create). The knowledge base accepts
	// documents, so the scanner default policy applies as-is.
	const doubleExt = detectDoubleExtension(args.filename);
	if (doubleExt.detected && doubleExt.executableExtension) {
		throwInvalidInput(`File rejected: ${doubleExt.description}`);
	}
	if (isExecutableExtension(args.filename)) {
		throwInvalidInput(`Executable files are not allowed: ${args.filename}`);
	}
	if (!isExtensionAllowed(args.filename, DEFAULT_FILE_POLICY)) {
		throwInvalidInput(`File type not allowed: ${args.filename}`);
	}
	if (!isMimeTypeAllowed(args.mimeType, DEFAULT_FILE_POLICY)) {
		throwInvalidInput(`MIME type not allowed: ${args.mimeType}`);
	}
	// Enforce the advertised per-file size ceiling. The client guards on this
	// too, but a forged request must not get past the server.
	const fileSize = await storedFileSize(ctx, args.storageId);
	if (fileSize <= 0) throwInvalidInput('File size must be positive');
	if (fileSize > MAX_LIBRARY_FILE_BYTES) {
		throwInvalidInput(`File exceeds the ${MAX_LIBRARY_FILE_MB} MB upload limit`);
	}

	const fileId = await insertSemanticFile(ctx, { ...args, fileSize, uploadedBy: session.userId });
	await consumeUpload(ctx, args.storageId, session, `semanticFiles:${fileId}`);
	// Kick off async processing: text extraction, summary, auto-tags, embedding.
	await ctx.scheduler.runAfter(0, internal.files.processing.processFile, { fileId });
	return fileId;
}

/** `ingest`'s arguments. */
export const ingestFileArgs = {
	storageId: v.id('_storage'),
	filename: v.string(),
	mimeType: v.string(),
	fileSize: v.number(),
	sourceType: v.union(v.literal('email_attachment'), v.literal('agent_generated')),
	// Which inbound route captured this attachment. Only the team-inbox
	// captures are in range of the inbound retention sweep — see the schema
	// comment on `captureSource`.
	captureSource: v.optional(captureSourceValidator),
	// The mailbox a Postbox capture arrived in, which decides who may read
	// it (lib/semanticFileAccess.ts). Resolved by the capture step from the
	// delivered message, never taken from a client.
	sourceMailboxId: v.optional(v.id('mailboxes')),
	sourceMessageId: v.optional(v.string()),
	uploadContext: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
	contactIds: v.optional(v.array(v.id('contacts'))),
	threadId: v.optional(v.id('conversationThreads')),
};

/**
 * Server-side ingestion entry point for non-upload sources.
 *
 * The user-facing `create` mutation is the only `upload`-source writer; this is
 * its counterpart for the automatic paths — inbound email attachments
 * (`email_attachment`) and agent artifacts (`agent_generated`). It runs the
 * same file-type policy as `create`, inserts the row via the shared
 * `insertSemanticFile`, and schedules `processFile` (text extraction → summary
 * → auto-tags → embedding → knowledge graph), so an ingested file is indexed
 * exactly like an uploaded one. Internal-only: callers are the delivery
 * pipeline + future agent producers, never a client.
 */
export const ingest = internalMutation({
	args: ingestFileArgs,
	handler: async (ctx, args): Promise<Id<'semanticFiles'> | null> => await ingestFile(ctx, args),
});

/** The body of `ingest`. */
export async function ingestFile(
	ctx: MutationCtx,
	args: ObjectType<typeof ingestFileArgs>
): Promise<Id<'semanticFiles'> | null> {
	// Same allowlist the user-upload `create` mutation enforces — never store
	// an executable/disallowed type just because it arrived over the wire.
	// `isFileTypeAccepted` is the one spelling of that conjunction, so a
	// caller can ask the same question BEFORE it spends anything staging the
	// blob (`captureAttachments` does).
	if (!isFileTypeAccepted(args.filename, args.mimeType, DEFAULT_FILE_POLICY)) {
		// Drop the staged blob so a rejected attachment doesn't leak storage.
		await ctx.storage.delete(args.storageId);
		return null;
	}

	const fileId = await insertSemanticFile(ctx, args);
	await ctx.scheduler.runAfter(0, internal.files.processing.processFile, { fileId });
	return fileId;
}

/**
 * Shared insert used by `create` (user upload) and the internal
 * attachment/agent ingestion paths. Inserts the row with provenance and a
 * provisional searchableText; the processing pipeline fills the rest.
 *
 * A supplied `threadId` is checked for existence here rather than in each
 * caller: `update` validates the conversation link too, and validating in the
 * one shared insert covers the user upload and both server-side ingestion
 * sources at once, so no write path can store a dangling link.
 *
 * Exported for Answer mode (mail/ai/composeDraftContext.ts), which keeps an
 * uploaded file answer in Files through this same insert.
 */
export async function insertSemanticFile(
	ctx: MutationCtx,
	args: {
		storageId: Id<'_storage'>;
		filename: string;
		mimeType: string;
		fileSize: number;
		title?: string;
		tags?: string[];
		sourceType: 'upload' | 'email_attachment' | 'agent_generated';
		captureSource?: CaptureSource;
		sourceMailboxId?: Id<'mailboxes'>;
		sourceMessageId?: string;
		uploadContext?: string;
		uploadedBy?: string;
		contactIds?: Id<'contacts'>[];
		threadId?: Id<'conversationThreads'>;
		previousVersionId?: Id<'semanticFiles'>;
	}
): Promise<Id<'semanticFiles'>> {
	if (args.threadId && !(await ctx.db.get(args.threadId))) {
		throwInvalidInput('Conversation not found');
	}

	const now = Date.now();
	const version = args.previousVersionId ? await getNextVersion(ctx, args.previousVersionId) : 1;

	const fileId = await ctx.db.insert('semanticFiles', {
		storageId: args.storageId,
		filename: args.filename,
		mimeType: args.mimeType,
		fileSize: args.fileSize,
		title: args.title,
		tags: args.tags,
		sourceType: args.sourceType,
		captureSource: args.captureSource,
		sourceMailboxId: args.sourceMailboxId,
		sourceMessageId: args.sourceMessageId,
		uploadContext: args.uploadContext,
		uploadedBy: args.uploadedBy,
		contactIds: args.contactIds,
		threadId: args.threadId,
		version,
		previousVersionId: args.previousVersionId,
		embedding: [], // Populated by processFile
		// Provisional index payload: filename + title + the tags typed at upload.
		// `processFile` rebuilds it with the summary/auto-tags/extracted text.
		searchableText: buildFileSearchableText({
			filename: args.filename,
			title: args.title,
			tags: args.tags,
		}),
		createdAt: now,
		updatedAt: now,
	});

	// Mirror contactIds into the index-able semanticFileContacts junction.
	await syncFileContacts(ctx, fileId, args.contactIds);
	return fileId;
}

/** `update`'s arguments. */
export const updateFileArgs = {
	fileId: v.id('semanticFiles'),
	title: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
	contactIds: v.optional(v.array(v.id('contacts'))),
	threadId: v.optional(v.union(v.id('conversationThreads'), v.null())),
};

/**
 * Update user-editable metadata.
 *
 * `threadId` is tri-state: omitted leaves the conversation link alone, an id
 * sets it, and `null` clears it (the detail page's Unlink action).
 */
// authz: updateLibraryFile requires organization:manage (requirePermission).
export const update = authedMutation({
	args: updateFileArgs,
	handler: async (ctx, args, session) => await updateLibraryFile(ctx, args, session),
});

/** The body of `update`. */
export async function updateLibraryFile(
	ctx: MutationCtx,
	args: ObjectType<typeof updateFileArgs>,
	session: MutationSessionContext
): Promise<void> {
	if (args.title !== undefined) validateStringLength(args.title, STRING_LIMITS.NAME, 'title');
	for (const tag of args.tags ?? []) validateStringLength(tag, STRING_LIMITS.TAG, 'Tag');

	requirePermission(
		hasPermission(session.role, 'organization:manage'),
		'Only owners and admins can perform this action'
	);
	const { fileId, ...updates } = args;
	const file = await ctx.db.get(fileId);
	if (!file) throwInvalidInput('File not found');

	const cleanUpdates: Partial<Doc<'semanticFiles'>> = { updatedAt: Date.now() };
	if (updates.title !== undefined) cleanUpdates.title = updates.title;
	if (updates.tags !== undefined) cleanUpdates.tags = updates.tags;
	if (updates.contactIds !== undefined) cleanUpdates.contactIds = updates.contactIds;
	if (updates.threadId !== undefined) {
		if (updates.threadId !== null && !(await ctx.db.get(updates.threadId))) {
			throwInvalidInput('Conversation not found');
		}
		// `undefined` in a patch removes the field, which is what a clear means.
		cleanUpdates.threadId = updates.threadId ?? undefined;
	}

	// A title or tag edit changes what this file should be findable by, so
	// rebuild the index payload instead of leaving the insert-time (or
	// pipeline-time) one behind.
	if (updates.title !== undefined || updates.tags !== undefined) {
		cleanUpdates.searchableText = buildFileSearchableText({
			filename: file.filename,
			title: updates.title ?? file.title,
			summary: file.summary,
			tags: updates.tags ?? file.tags,
			autoTags: file.autoTags,
			extractedText: file.extractedText,
		});
	}

	// Through the one corpus writer: the title is part of the
	// embedding input, so a new one leaves no vector of the old one.
	await patchCorpusRow(ctx, 'semanticFiles', file, cleanUpdates);

	// Keep the junction in sync when the contactIds array is edited in place.
	if (updates.contactIds !== undefined) {
		await syncFileContacts(ctx, fileId, updates.contactIds);
	}
}

/**
 * Delete a file
 */
export const remove = adminMutation({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => await removeLibraryFile(ctx, args.fileId),
});

/** The body of `remove`. */
export async function removeLibraryFile(
	ctx: MutationCtx,
	fileId: Id<'semanticFiles'>
): Promise<void> {
	const file = await ctx.db.get(fileId);
	if (!file) return;

	// Tear down the junction rows before the parent file.
	await syncFileContacts(ctx, fileId, undefined);
	// Delete the stored file, if the retention sweep has not already released it.
	if (file.storageId) {
		if (file.uploadedBy !== undefined) {
			// User-created rows require proven ownership, including legacy rows
			// that may have linked another resource's storage id before receipts.
			await deleteOwnedUpload(ctx, file.storageId, `semanticFiles:${file._id}`);
		} else {
			// Internal ingestion owns its staged blob; it has no browser receipt.
			await ctx.storage.delete(file.storageId);
		}
	}
	await ctx.db.delete(fileId);
	await dropExtractionProgress(ctx, 'file', fileId);
}

// ============================================================
// Helpers
// ============================================================

async function getNextVersion(
	ctx: MutationCtx,
	previousVersionId: Id<'semanticFiles'>
): Promise<number> {
	const prev = await ctx.db.get(previousVersionId);
	return prev ? prev.version + 1 : 1;
}

/**
 * Reconcile the `semanticFileContacts` junction rows that mirror a file's
 * `contactIds` array. Delete-then-reinsert, so it is correct for the brand-new
 * insert, an in-place `contactIds` edit, and teardown (`contactIds = undefined`
 * deletes all rows). The array stays on the file for inline reads; the junction
 * is the index-able copy `listByContact` queries. Mirrors
 * `knowledge/entryContacts.ts:insertEntryContacts` with reconciliation, since
 * files have an in-place editor (`update`).
 */
export async function syncFileContacts(
	ctx: MutationCtx,
	fileId: Id<'semanticFiles'>,
	contactIds: Id<'contacts'>[] | undefined
): Promise<void> {
	const existing = await ctx.db
		.query('semanticFileContacts')
		.withIndex('by_file', (q) => q.eq('fileId', fileId))
		.collect(); // bounded: junction rows for one file (contacts per file)
	for (const row of existing) await ctx.db.delete(row._id);
	// De-dup so a contactId repeated in the array yields one row.
	for (const contactId of new Set(contactIds ?? [])) {
		await ctx.db.insert('semanticFileContacts', { fileId, contactId });
	}
}
