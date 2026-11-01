/**
 * The processing pipeline's reads and writes on `semanticFiles`: what
 * `files/processing.ts` reads before it processes a file and commits after,
 * the reads its semantic search hydrates hits through, and the two passes
 * that schedule processing again for files left without an embedding.
 *
 * All internal. Each builder's body is an exported helper, so the previous
 * release's paths (`semanticFiles.ts`) run the same code.
 */

import { v, type ObjectType } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { mailCaptureScopeValidator, semanticFileRetrievalGate } from '../lib/semanticFileAccess';
import { isAiProviderConfigured } from '../lib/aiNotConfigured';
import { patchCorpusRow, vectorFieldsForCommit } from '../lib/aiRouting/embeddingActivation';
import { measuredEmbeddingSpaceValidator } from '../lib/validators/embedding';
import { logInfo } from '../lib/runtimeLog';
import type { Id, Doc } from '../_generated/dataModel';
import { batchGet } from '../_utils/batchLoader';
import { hydrateFile, hydrateFiles } from '../lib/semanticFileCards';

// ============================================================
// Queries
// ============================================================

/**
 * Internal variant for the server-side processing pipeline
 * (`files/processing.processFile`), which runs as a scheduled
 * internalAction with no user session and so cannot call the session-gated
 * `files/library.get`.
 */
export const getInternal = internalQuery({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => await readFileInternal(ctx, args.fileId),
});

/** The body of `getInternal`. */
export async function readFileInternal(ctx: QueryCtx, fileId: Id<'semanticFiles'>) {
	const file = await ctx.db.get(fileId);
	if (!file) return null;
	return hydrateFile(ctx, file);
}

/** `getByIds`'s arguments, shared with its previous-release path. */
export const getByIdsArgs = {
	ids: v.array(v.id('semanticFiles')),
	mailCaptures: v.optional(mailCaptureScopeValidator),
};

/**
 * Fetch files by a list of ids, preserving input order, with storage URLs
 * resolved. Used to hydrate the hits from a vector search (`ctx.vectorSearch`
 * yields `{ _id, _score }`; this resolves them to documents). Internal — the
 * semantic-search action calls it. Files captured from inbound mail are kept
 * only within `mailCaptures` (lib/semanticFileAccess.ts); absent means none.
 */
export const getByIds = internalQuery({
	args: getByIdsArgs,
	handler: async (ctx, args) => await readFilesByIds(ctx, args),
});

/** The body of `getByIds`. */
export async function readFilesByIds(ctx: QueryCtx, args: ObjectType<typeof getByIdsArgs>) {
	// The ids are independent, so read them in one batch and hydrate the
	// survivors together, still in input order.
	const byId = await batchGet(ctx, args.ids);
	const canRetrieve = semanticFileRetrievalGate(ctx, args.mailCaptures ?? 'none');
	const files: Doc<'semanticFiles'>[] = [];
	for (const id of args.ids) {
		const file = byId.get(id);
		if (file && (await canRetrieve(file))) files.push(file);
	}
	return await hydrateFiles(ctx, files);
}

/** `ftsRankedFileIds`'s arguments, shared with its previous-release path. */
export const ftsRankedFileIdsArgs = {
	queryText: v.string(),
	limit: v.number(),
};

/**
 * Full-text leg of hybrid file retrieval: the file ids matching `queryText` over
 * the `search_files` index, in relevance order. `ctx.vectorSearch` lives on the
 * action context and `withSearchIndex` on the query context, so the semantic-
 * search action (`files/processing.semanticSearch`) calls this to get the
 * FTS ranking it fuses (via RRF) with its vector ranking. Mirrors
 * `knowledge/graph.ts:ftsRankedIds`. `search_files` declares no `filterFields`,
 * so — unlike the knowledge index — there is no `entryType`-style narrowing here.
 * Internal: scope/feature gating is the caller's job.
 */
export const ftsRankedFileIds = internalQuery({
	args: ftsRankedFileIdsArgs,
	handler: async (ctx, args): Promise<Id<'semanticFiles'>[]> => await rankFileIdsByText(ctx, args),
});

/** The body of `ftsRankedFileIds`. */
export async function rankFileIdsByText(
	ctx: QueryCtx,
	args: ObjectType<typeof ftsRankedFileIdsArgs>
): Promise<Id<'semanticFiles'>[]> {
	const rows = await ctx.db
		.query('semanticFiles')
		.withSearchIndex('search_files', (q) => q.search('searchableText', args.queryText))
		.take(args.limit);
	return rows.map((r) => r._id);
}

/** `getProcessingContext`'s arguments, shared with its previous-release path. */
export const processingContextArgs = {
	threadId: v.optional(v.id('conversationThreads')),
	contactIds: v.optional(v.array(v.id('contacts'))),
	previousVersionId: v.optional(v.id('semanticFiles')),
};

/**
 * Resolve the conversation/contact context a file was shared in, so the
 * processing pipeline can inherit auto-tags ("q3-financials", "acme-corp")
 * and compute a diff vs the prior version. Internal — called by processFile.
 */
export const getProcessingContext = internalQuery({
	args: processingContextArgs,
	handler: async (ctx, args) => await readProcessingContext(ctx, args),
});

/** The body of `getProcessingContext`. */
export async function readProcessingContext(
	ctx: QueryCtx,
	args: ObjectType<typeof processingContextArgs>
) {
	let threadSubject: string | undefined;
	if (args.threadId) {
		const thread = await ctx.db.get(args.threadId);
		threadSubject = thread?.subject ?? undefined;
	}

	const contactNames: string[] = [];
	const contacts = await batchGet(ctx, args.contactIds ?? []);
	for (const contactId of args.contactIds ?? []) {
		const contact = contacts.get(contactId);
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
}

// ============================================================
// Mutations
// ============================================================

/** Processing never produced an embedding for this file, in either vector column. */
function lacksEmbedding(file: Doc<'semanticFiles'>): boolean {
	return (
		file.embeddingGeneratedAt === undefined &&
		(file.embedding?.length ?? 0) === 0 &&
		(file.secondaryEmbedding?.length ?? 0) === 0
	);
}

/**
 * Safety-net backfill: re-schedule processing for recently-created files that
 * never got an embedding (e.g. the original scheduler call was lost to a
 * deploy gap). Bounded to a recent window so permanently text-less files
 * (whose embedding legitimately stays empty) aren't reprocessed forever.
 *
 * Without an AI provider no run can produce an embedding, so this would
 * re-extract every new file on each tick for the whole window. It schedules
 * nothing then; saving a provider later reprocesses those files once
 * (`reprocessAfterAiConfigured`).
 */
export const backfillUnprocessed = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => await backfillUnprocessedFiles(ctx, args.limit),
});

/** The body of `backfillUnprocessed`. */
export async function backfillUnprocessedFiles(
	ctx: MutationCtx,
	limit: number | undefined
): Promise<{ scheduled: number }> {
	if (!(await isAiProviderConfigured(ctx.db))) return { scheduled: 0 };
	const cutoff = Date.now() - 2 * 60 * 60 * 1000; // last 2 hours
	const files = await ctx.db
		.query('semanticFiles')
		.withIndex('by_created_at')
		.order('desc')
		.take(limit ?? 100);

	let scheduled = 0;
	for (const file of files) {
		if (file.createdAt < cutoff) break; // ordered desc — older files follow
		if (lacksEmbedding(file)) {
			await ctx.scheduler.runAfter(0, internal.files.processing.processFile, {
				fileId: file._id,
			});
			scheduled++;
		}
	}
	return { scheduled };
}

/** Newest files `reprocessAfterAiConfigured` reads, and at most how many it reprocesses. */
const AI_CONFIGURED_SCAN = 500;
const AI_CONFIGURED_REPROCESS_LIMIT = 200;
/** Spacing between those runs, so saving a provider does not fire them all at once. */
const AI_CONFIGURED_REPROCESS_SPACING_MS = 2_000;

/**
 * One pass, scheduled when the instance's first AI provider is saved: files
 * processed while no provider existed got their text but no summary,
 * embedding or knowledge entries, and nothing else would ever run them again.
 * Bounded to the newest files, each at most once, spaced out; a file whose
 * bytes the retention sweep released has nothing left to process.
 */
export const reprocessAfterAiConfigured = internalMutation({
	args: {},
	handler: async (ctx) => await reprocessFilesAfterAiConfigured(ctx),
});

/** The body of `reprocessAfterAiConfigured`. */
export async function reprocessFilesAfterAiConfigured(
	ctx: MutationCtx
): Promise<{ scheduled: number }> {
	const files = await ctx.db
		.query('semanticFiles')
		.withIndex('by_created_at')
		.order('desc')
		.take(AI_CONFIGURED_SCAN);

	let scheduled = 0;
	for (const file of files) {
		if (scheduled >= AI_CONFIGURED_REPROCESS_LIMIT) break;
		if (!file.storageId || !lacksEmbedding(file)) continue;
		await ctx.scheduler.runAfter(
			scheduled * AI_CONFIGURED_REPROCESS_SPACING_MS,
			internal.files.processing.processFile,
			{ fileId: file._id }
		);
		scheduled++;
	}
	return { scheduled };
}

/** `updateProcessedMetadata`'s arguments, shared with its previous-release path. */
export const processedMetadataArgs = {
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
	// The space the job measured for `embedding`; the vector is stamped with it,
	// or dropped when the configuration moved on, and the file stays unembedded
	// for the next processing pass (vectorFieldsForCommit). Optional for
	// previous-release jobs, whose vector is dropped; required after release N+1.
	embeddingSpace: v.optional(measuredEmbeddingSpaceValidator),
};

/**
 * Update file metadata after AI processing
 */
export const updateProcessedMetadata = internalMutation({
	args: processedMetadataArgs,
	handler: async (ctx, args) => await commitProcessedMetadata(ctx, args),
});

/** The body of `updateProcessedMetadata`. */
export async function commitProcessedMetadata(
	ctx: MutationCtx,
	{
		fileId,
		embeddingSpace,
		embedding,
		embeddingModel: _model,
		embeddingGeneratedAt: _at,
		...updates
	}: ObjectType<typeof processedMetadataArgs>
): Promise<void> {
	const file = await ctx.db.get(fileId);
	if (!file) return;
	const { isStale, fields, written } = await vectorFieldsForCommit(
		ctx,
		{ embedding, space: embeddingSpace },
		{}
	);
	if (isStale) logInfo('[semanticFiles] stale embedding space, stored without vector', { fileId });
	// Through the one corpus writer: processing changes the input
	// and the file's eligibility, so a staged rebuild learns of it.
	await patchCorpusRow(
		ctx,
		'semanticFiles',
		file,
		{ ...updates, ...fields, updatedAt: Date.now() },
		{ written }
	);
}
