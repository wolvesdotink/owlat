/**
 * Semantic Files
 *
 * File storage with embedding-based retrieval and auto-tagging.
 * Files uploaded or received as attachments are indexed with
 * text extraction, AI-generated summaries, and vector embeddings
 * for semantic search.
 */

import { v } from 'convex/values';
import { paginationOptsValidator, type PaginationResult } from 'convex/server';
import { internalQuery, internalMutation, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requireAdminContext } from './lib/sessionOrganization';
import { throwInvalidInput } from './_utils/errors';
import {
	isExtensionAllowed,
	isMimeTypeAllowed,
	isExecutableExtension,
	detectDoubleExtension,
	DEFAULT_FILE_POLICY,
} from '@owlat/email-scanner';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';
import type { Id, Doc } from './_generated/dataModel';

// ============================================================
// Queries
// ============================================================

/** Minimal storage accessor — both query and mutation ctx satisfy it. */
type StorageReader = { storage: { getUrl: (id: Id<'_storage'>) => Promise<string | null> } };

/**
 * Attach a resolved storage URL to a file row. Every reader returns files with a
 * `url`, so this one helper owns the `ctx.storage.getUrl(file.storageId)` hop.
 */
async function hydrateFile(
	ctx: StorageReader,
	file: Doc<'semanticFiles'>,
): Promise<Doc<'semanticFiles'> & { url: string | null }> {
	return { ...file, url: await ctx.storage.getUrl(file.storageId) };
}

/** Hydrate a list of file rows with storage URLs, preserving order. */
function hydrateFiles(
	ctx: StorageReader,
	files: Doc<'semanticFiles'>[],
): Promise<Array<Doc<'semanticFiles'> & { url: string | null }>> {
	return Promise.all(files.map((file) => hydrateFile(ctx, file)));
}

/**
 * Get a file by ID
 */
export const get = authedQuery({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => {
		const file = await ctx.db.get(args.fileId);
		if (!file) return null;
		return hydrateFile(ctx, file);
	},
});

/**
 * Internal variant for the server-side processing pipeline
 * (`semanticFileProcessing.processFile`), which runs as a scheduled
 * internalAction with no user session and so cannot call the session-gated
 * `get` above.
 */
export const getInternal = internalQuery({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => {
		const file = await ctx.db.get(args.fileId);
		if (!file) return null;
		return hydrateFile(ctx, file);
	},
});

/**
 * Fetch files by a list of ids, preserving input order, with storage URLs
 * resolved. Used to hydrate the hits from a vector search (`ctx.vectorSearch`
 * yields `{ _id, _score }`; this resolves them to documents). Internal — the
 * semantic-search action calls it.
 */
export const getByIds = internalQuery({
	args: { ids: v.array(v.id('semanticFiles')) },
	handler: async (ctx, args) => {
		const out: Array<Doc<'semanticFiles'> & { url: string | null }> = [];
		for (const id of args.ids) {
			const file = await ctx.db.get(id);
			if (file) out.push(await hydrateFile(ctx, file));
		}
		return out;
	},
});

/**
 * Full-text leg of hybrid file retrieval: the file ids matching `queryText` over
 * the `search_files` index, in relevance order. `ctx.vectorSearch` lives on the
 * action context and `withSearchIndex` on the query context, so the semantic-
 * search action (`semanticFileProcessing.semanticSearch`) calls this to get the
 * FTS ranking it fuses (via RRF) with its vector ranking. Mirrors
 * `knowledge/graph.ts:ftsRankedIds`. `search_files` declares no `filterFields`,
 * so — unlike the knowledge index — there is no `entryType`-style narrowing here.
 * Internal: scope/feature gating is the caller's job.
 */
export const ftsRankedFileIds = internalQuery({
	args: {
		queryText: v.string(),
		limit: v.number(),
	},
	handler: async (ctx, args): Promise<Id<'semanticFiles'>[]> => {
		const rows = await ctx.db
			.query('semanticFiles')
			.withSearchIndex('search_files', (q) => q.search('searchableText', args.queryText))
			.take(args.limit);
		return rows.map((r) => r._id);
	},
});

/**
 * Resolve the conversation/contact context a file was shared in, so the
 * processing pipeline can inherit auto-tags ("q3-financials", "acme-corp")
 * and compute a diff vs the prior version. Internal — called by processFile.
 */
export const getProcessingContext = internalQuery({
	args: {
		threadId: v.optional(v.id('conversationThreads')),
		contactIds: v.optional(v.array(v.id('contacts'))),
		previousVersionId: v.optional(v.id('semanticFiles')),
	},
	handler: async (ctx, args) => {
		let threadSubject: string | undefined;
		if (args.threadId) {
			const thread = await ctx.db.get(args.threadId);
			threadSubject = thread?.subject ?? undefined;
		}

		const contactNames: string[] = [];
		for (const contactId of args.contactIds ?? []) {
			const contact = await ctx.db.get(contactId);
			if (!contact) continue;
			const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email;
			if (name) contactNames.push(name);
		}

		let previousText: string | undefined;
		if (args.previousVersionId) {
			const prev = await ctx.db.get(args.previousVersionId);
			previousText = prev?.extractedText ?? undefined;
		}

		return { threadSubject, contactNames, previousText };
	},
});

const sourceTypeValidator = v.union(
	v.literal('upload'),
	v.literal('email_attachment'),
	v.literal('agent_generated')
);

/**
 * Apply the `sourceType` provenance filter to a page of files and resolve a
 * storage URL for each survivor. The filter runs after pagination (mirroring
 * `mediaAssets.list`), so a page can come back sparse while matching files sit
 * on later pages — the client auto-loads further pages until the grid fills.
 * This pushes filtering across the whole table instead of the old client-side
 * narrowing over only the newest 50/20 fetched rows.
 */
async function applySourceFilter(
	ctx: StorageReader,
	results: PaginationResult<Doc<'semanticFiles'>>,
	sourceType: 'upload' | 'email_attachment' | 'agent_generated' | undefined,
): Promise<PaginationResult<Doc<'semanticFiles'> & { url: string | null }>> {
	const page = sourceType
		? results.page.filter((f) => f.sourceType === sourceType)
		: results.page;
	const hydrated = await hydrateFiles(ctx, page);
	return { ...results, page: hydrated };
}

/**
 * List files (paginated, newest first) with an optional `sourceType` filter.
 */
export const list = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		sourceType: v.optional(sourceTypeValidator),
	},
	handler: async (ctx, args) => {
		const results = await ctx.db
			.query('semanticFiles')
			.withIndex('by_created_at')
			.order('desc')
			.paginate(args.paginationOpts);
		return applySourceFilter(ctx, results, args.sourceType);
	},
});

/**
 * Full-text search for files by content/title (paginated), with an optional
 * `sourceType` filter applied across the whole result set, not just one page.
 */
export const search = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		query: v.string(),
		sourceType: v.optional(sourceTypeValidator),
	},
	handler: async (ctx, args) => {
		const results = await ctx.db
			.query('semanticFiles')
			.withSearchIndex('search_files', (q) => q.search('searchableText', args.query))
			.paginate(args.paginationOpts);
		return applySourceFilter(ctx, results, args.sourceType);
	},
});

// Note: true semantic (vector) search for files lives on the action ctx, not
// the query ctx — it's the internalAction `semanticFileProcessing.semanticSearch`,
// called by the agent (agent/steps/context_retrieval) and the assistant tools.
// There is intentionally no `semanticSearch` query here: a query can't run
// `ctx.vectorSearch`, so any such query would only return recency-ordered files
// while looking like semantic search — a trap. Callers wanting semantic file
// results must go through the action.

/**
 * Get version history for a file
 */
export const getVersionHistory = authedQuery({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => {
		const versions: Array<Doc<'semanticFiles'> & { url: string | null }> = [];
		let currentId: Id<'semanticFiles'> | undefined = args.fileId;

		while (currentId) {
			const file: Doc<'semanticFiles'> | null = await ctx.db.get(currentId);
			if (!file) break;

			versions.push(await hydrateFile(ctx, file));

			currentId = file.previousVersionId;
		}

		return versions;
	},
});

/**
 * Get files related to a contact
 */
export const listByContact = authedQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// Query the index-able semanticFileContacts mirror by contact instead of
		// scanning the newest 200 files and JS-filtering the contactIds array —
		// complete (no silent truncation past 200) and O(files-for-this-contact).
		const links = await ctx.db
			.query('semanticFileContacts')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: junction rows for one contact (files per person)

		const files: Array<Doc<'semanticFiles'> & { url: string | null }> = [];
		for (const link of links) {
			const file = await ctx.db.get(link.fileId);
			if (!file) continue;
			files.push(await hydrateFile(ctx, file));
		}

		// Newest first, then cap.
		files.sort((a, b) => b.createdAt - a.createdAt);
		return files.slice(0, args.limit ?? 20);
	},
});

// ============================================================
// Mutations
// ============================================================

/**
 * Upload a new file (user-facing)
 */
export const create = authedMutation({
	args: {
		storageId: v.id('_storage'),
		filename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		title: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		sourceType: v.union(
			v.literal('upload'),
			v.literal('email_attachment'),
			v.literal('agent_generated')
		),
		sourceMessageId: v.optional(v.string()),
		uploadContext: v.optional(v.string()),
		contactIds: v.optional(v.array(v.id('contacts'))),
		threadId: v.optional(v.id('conversationThreads')),
		previousVersionId: v.optional(v.id('semanticFiles')),
	},
	handler: async (ctx, args) => {
		const session = await requireAdminContext(ctx);

		// Security: validate file type before storing the record, matching the
		// media library (mediaAssets.create). The knowledge base accepts
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
		if (args.fileSize > MAX_LIBRARY_FILE_BYTES) {
			throwInvalidInput(`File exceeds the ${MAX_LIBRARY_FILE_MB} MB upload limit`);
		}

		const fileId = await insertSemanticFile(ctx, { ...args, uploadedBy: session.userId });
		// Kick off async processing: text extraction, summary, auto-tags, embedding.
		await ctx.scheduler.runAfter(0, internal.semanticFileProcessing.processFile, { fileId });
		return fileId;
	},
});

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
	args: {
		storageId: v.id('_storage'),
		filename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		sourceType: v.union(v.literal('email_attachment'), v.literal('agent_generated')),
		sourceMessageId: v.optional(v.string()),
		uploadContext: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		contactIds: v.optional(v.array(v.id('contacts'))),
		threadId: v.optional(v.id('conversationThreads')),
	},
	handler: async (ctx, args): Promise<Id<'semanticFiles'> | null> => {
		// Same allowlist the user-upload `create` mutation enforces — never store
		// an executable/disallowed type just because it arrived over the wire.
		const doubleExt = detectDoubleExtension(args.filename);
		if (
			(doubleExt.detected && doubleExt.executableExtension) ||
			isExecutableExtension(args.filename) ||
			!isExtensionAllowed(args.filename, DEFAULT_FILE_POLICY) ||
			!isMimeTypeAllowed(args.mimeType, DEFAULT_FILE_POLICY)
		) {
			// Drop the staged blob so a rejected attachment doesn't leak storage.
			await ctx.storage.delete(args.storageId);
			return null;
		}

		const fileId = await insertSemanticFile(ctx, args);
		await ctx.scheduler.runAfter(0, internal.semanticFileProcessing.processFile, { fileId });
		return fileId;
	},
});

/**
 * Shared insert used by `create` (user upload) and the internal
 * attachment/agent ingestion paths. Inserts the row with provenance and a
 * provisional searchableText; the processing pipeline fills the rest.
 */
async function insertSemanticFile(
	ctx: MutationCtx,
	args: {
		storageId: Id<'_storage'>;
		filename: string;
		mimeType: string;
		fileSize: number;
		title?: string;
		tags?: string[];
		sourceType: 'upload' | 'email_attachment' | 'agent_generated';
		sourceMessageId?: string;
		uploadContext?: string;
		uploadedBy?: string;
		contactIds?: Id<'contacts'>[];
		threadId?: Id<'conversationThreads'>;
		previousVersionId?: Id<'semanticFiles'>;
	}
): Promise<Id<'semanticFiles'>> {
	const now = Date.now();
	const version = args.previousVersionId
		? await getNextVersion(ctx, args.previousVersionId)
		: 1;

	const fileId = await ctx.db.insert('semanticFiles', {
		storageId: args.storageId,
		filename: args.filename,
		mimeType: args.mimeType,
		fileSize: args.fileSize,
		title: args.title,
		tags: args.tags,
		sourceType: args.sourceType,
		sourceMessageId: args.sourceMessageId,
		uploadContext: args.uploadContext,
		uploadedBy: args.uploadedBy,
		contactIds: args.contactIds,
		threadId: args.threadId,
		version,
		previousVersionId: args.previousVersionId,
		embedding: [], // Populated by processFile
		searchableText: `${args.filename} ${args.title ?? ''}`,
		createdAt: now,
		updatedAt: now,
	});

	// Mirror contactIds into the index-able semanticFileContacts junction.
	await syncFileContacts(ctx, fileId, args.contactIds);
	return fileId;
}

/**
 * Safety-net backfill: re-schedule processing for recently-created files that
 * never got an embedding (e.g. the original scheduler call was lost to a
 * deploy gap). Bounded to a recent window so permanently text-less files
 * (whose embedding legitimately stays empty) aren't reprocessed forever.
 */
export const backfillUnprocessed = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const cutoff = Date.now() - 2 * 60 * 60 * 1000; // last 2 hours
		const files = await ctx.db
			.query('semanticFiles')
			.withIndex('by_created_at')
			.order('desc')
			.take(args.limit ?? 100);

		let scheduled = 0;
		for (const file of files) {
			if (file.createdAt < cutoff) break; // ordered desc — older files follow
			if (file.embeddingGeneratedAt === undefined && (file.embedding?.length ?? 0) === 0) {
				await ctx.scheduler.runAfter(0, internal.semanticFileProcessing.processFile, {
					fileId: file._id,
				});
				scheduled++;
			}
		}
		return { scheduled };
	},
});

/**
 * Update file metadata after AI processing
 */
export const updateProcessedMetadata = internalMutation({
	args: {
		fileId: v.id('semanticFiles'),
		title: v.optional(v.string()),
		summary: v.optional(v.string()),
		extractedText: v.optional(v.string()),
		autoTags: v.optional(v.array(v.string())),
		embedding: v.array(v.float64()),
		embeddingModel: v.optional(v.string()),
		embeddingGeneratedAt: v.optional(v.number()),
		searchableText: v.optional(v.string()),
		changeSummary: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { fileId, ...updates } = args;
		await ctx.db.patch(fileId, {
			...updates,
			updatedAt: Date.now(),
		});
	},
});

/**
 * Update user-editable metadata
 */
export const update = authedMutation({
	args: {
		fileId: v.id('semanticFiles'),
		title: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		contactIds: v.optional(v.array(v.id('contacts'))),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const { fileId, ...updates } = args;
		const cleanUpdates: Partial<Doc<'semanticFiles'>> = { updatedAt: Date.now() };
		if (updates.title !== undefined) cleanUpdates.title = updates.title;
		if (updates.tags !== undefined) cleanUpdates.tags = updates.tags;
		if (updates.contactIds !== undefined) cleanUpdates.contactIds = updates.contactIds;

		await ctx.db.patch(fileId, cleanUpdates);

		// Keep the junction in sync when the contactIds array is edited in place.
		if (updates.contactIds !== undefined) {
			await syncFileContacts(ctx, fileId, updates.contactIds);
		}
	},
});

/**
 * Delete a file
 */
export const remove = authedMutation({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const file = await ctx.db.get(args.fileId);
		if (!file) return;

		// Tear down the junction rows before the parent file.
		await syncFileContacts(ctx, args.fileId, undefined);
		// Delete the stored file
		await ctx.storage.delete(file.storageId);
		await ctx.db.delete(args.fileId);
	},
});

// ============================================================
// Helpers
// ============================================================

async function getNextVersion(ctx: MutationCtx, previousVersionId: Id<'semanticFiles'>): Promise<number> {
	const prev = await ctx.db.get(previousVersionId);
	return prev ? prev.version + 1 : 1;
}

/**
 * Reconcile the `semanticFileContacts` junction rows that mirror a file's
 * `contactIds` array. Delete-then-reinsert, so it is correct for the brand-new
 * insert, an in-place `contactIds` edit, and teardown (`contactIds = undefined`
 * deletes all rows). The array stays on the file for inline reads; the junction
 * is the index-able copy `listByContact` queries. Mirrors
 * `knowledge/graph.ts:insertEntryContacts` with reconciliation, since files have
 * an in-place editor (`update`).
 */
export async function syncFileContacts(
	ctx: MutationCtx,
	fileId: Id<'semanticFiles'>,
	contactIds: Id<'contacts'>[] | undefined,
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
