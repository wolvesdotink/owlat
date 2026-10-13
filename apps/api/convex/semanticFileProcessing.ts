'use node';

/**
 * Semantic File Processing
 *
 * Node runtime: both actions run the shared LLM dispatch
 * (`lib/llm/dispatch`, itself `'use node'`), and this module defines nothing
 * but actions (the remaining exports are pure helpers used only by tests).
 *
 * AI-powered processing pipeline for uploaded files:
 * 1. Text extraction (based on MIME type)
 * 2. AI summarization
 * 3. Auto-tag generation
 * 4. Embedding generation for vector search
 */

import { v } from 'convex/values';
import { htmlToPlainText } from '@owlat/shared/html';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { resolveIndexEmbedder, toIndexVector } from './lib/llmProvider';
import { measuredEmbeddingSpace, probeEmbeddingRevision } from './lib/aiRouting/embeddingProbe';
import { fileEmbeddingInput } from './lib/aiRouting/embeddingInputs';
import type { MeasuredSpace } from './lib/aiRouting/embeddingRegistry';
import { embedRetrievalQuery, searchSpaceVectors } from './knowledge/vectorSearch';
import { logError, logInfo } from './lib/runtimeLog';
import { secretFreeErrorText } from './lib/embeddingSpace';
import { meterLlmCall } from './analytics/meteredSpend';
import { runEmbedding } from './lib/llm/embed';
import { rootRequest } from './lib/llm/requestMeter';
import { llmRootContextValidator } from './lib/llmUsageTags';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';
import { isContactScopeVisible } from './lib/contactScope';
import { isInMailCaptureScope, mailCaptureScopeValidator } from './lib/semanticFileAccess';
import { buildFileSearchableText } from './lib/fileSearchText';
import { reciprocalRankFusion } from './lib/rrf';
import { injectionRisk } from './knowledge/extraction';
import { scrubTags, slugifyTag, truncateForLLM } from './lib/semanticFileText';
import { classifyExtraction, extractionPlaceholder } from './lib/fileExtraction';
import { anchorActionDeadline, boundedRoot } from './lib/llm/actionDeadline';
import {
	batchedFileSummaryValidator,
	deferFileForBudget,
	fileStageValidator,
	owedFileStages,
	reusableSummary,
} from './analytics/backgroundDeferral';
import { aiProviderConfigured, sendSummaryThroughBatch, summarizeFile } from './lib/semanticFileAi';

/**
 * Process a newly uploaded file: extract text, generate summary,
 * create tags, and compute embedding vector.
 */
export const processFile = internalAction({
	args: {
		fileId: v.id('semanticFiles'),
		/** Runs this file already deferred at the spend ceiling (ADR-0073, D1). */
		deferrals: v.optional(v.number()),
		/** The paid stages a deferred run still owes; absent: all of them. */
		stages: v.optional(v.array(fileStageValidator)),
		/** The summary a provider batch returned (L14): used instead of asking the model. */
		batchedSummary: v.optional(batchedFileSummaryValidator),
	},
	handler: async (ctx, args) => {
		// One model budget for this action, from its start (ADR-0073).
		anchorActionDeadline(ctx);
		// Get file metadata
		const file = await ctx.runQuery(internal.semanticFiles.getInternal, { fileId: args.fileId });
		if (!file) return;
		// Every model call processing this file groups under one root (ADR-0073).
		const fileRoot = rootRequest('file', args.fileId);

		// Resolve the conversation/contact context this file was shared in, so
		// tags can be inherited and a version diff computed.
		const fileCtx = await ctx.runQuery(internal.semanticFiles.getProcessingContext, {
			threadId: file.threadId,
			contactIds: file.contactIds,
			previousVersionId: file.previousVersionId,
		});

		// Get the file blob from storage. A file whose bytes the retention sweep
		// released has nothing left to extract — its summary, extracted text and
		// embedding are already on the row and stay there.
		if (!file.storageId) return;
		const blob = await ctx.storage.get(file.storageId);
		if (!blob) return;

		// 1. Extract text based on MIME type
		let extractedText = '';
		try {
			extractedText = await extractText(blob, file.mimeType, file.filename);
		} catch (error) {
			// Fail soft: the file still gets filename/tag metadata below. Name the
			// file so an operator can tell which upload lost its text.
			logError('[semantic_file] text extraction failed', {
				fileId: args.fileId,
				filename: file.filename,
				mimeType: file.mimeType,
				error,
			});
		}

		if (!extractedText && !file.title) {
			// Nothing to process — store empty embedding. Rebuild rather than
			// overwrite with the bare filename, so the tags typed at upload stay
			// searchable on a file we can't extract text from.
			await ctx.runMutation(internal.semanticFiles.updateProcessedMetadata, {
				fileId: args.fileId,
				embedding: [],
				searchableText: buildFileSearchableText({
					filename: file.filename,
					tags: file.tags,
				}),
			});
			return;
		}

		// Prompt-injection guard on the untrusted extracted body. The text is fed
		// verbatim into the summarize/tag LLM prompt below, and its output is
		// persisted and later surfaced back to the assistant, so a planted
		// instruction could poison downstream models. When the deterministic
		// patterns flag the body, skip the LLM summarization/tag step entirely
		// (never feed poisoned text to a model) and fall back to filename metadata.
		const injectionReason = injectionRisk(extractedText);
		if (injectionReason) {
			logInfo('[semantic_file] extracted text tripped the injection guard; skipping AI summary', {
				fileId: args.fileId,
				reason: injectionReason,
			});
		}

		// Without a provider this action used to throw at the embedding step, so
		// the file never got its extracted text stored, and the backfill re-ran it
		// into the same error for two hours.
		// D1 (ADR-0073): at the spend ceiling the paid steps defer to a later run.
		const aiConfigured =
			(await aiProviderConfigured(ctx)) &&
			!(await deferFileForBudget(
				ctx,
				args.fileId,
				args.deferrals,
				args.stages,
				args.batchedSummary
			));
		if (!aiConfigured) {
			logInfo('[semantic_file] no AI provider, or deferred at the spend ceiling; text only', {
				fileId: args.fileId,
			});
		}

		// 2. Generate summary and tags via LLM
		const textForAI = truncateForLLM(extractedText, 8000);
		let summary = '';
		let autoTags: string[] = [];
		let title = file.title;
		// Paid stages spend admission refuses are owed to a later run (D1, ADR-0073).
		const owed = owedFileStages(ctx, args.fileId, args.deferrals);
		const reused = reusableSummary(file, args.stages);
		// The summary went to a provider batch: the embedding and the graph wait for it.
		let isSummaryBatched = false;

		if (injectionReason) {
			// Poisoned extracted text: don't hand it to the model. Keep filename-only
			// metadata so the file is still searchable without an AI round-trip.
			title = title || file.filename;
		} else if (reused) {
			// A deferred run whose summary already landed: only the embedding is owed.
			({ title, summary, autoTags } = reused);
		} else if (args.batchedSummary) {
			// L14: the summary came back from the provider's batch API.
			title = title || args.batchedSummary.title;
			summary = args.batchedSummary.summary;
			autoTags = args.batchedSummary.tags;
		} else if (textForAI.length > 50 && !aiConfigured) {
			// No model to ask: the same fallback as a failed call below.
			title = title || file.filename;
		} else if (textForAI.length > 50) {
			try {
				const summaryInput = { file, fileCtx, textForAI, root: fileRoot };
				// L14: out to the provider's batch API when the switch allows; this
				// file is processed again with the summary once it is back.
				isSummaryBatched = await sendSummaryThroughBatch(ctx, {
					...summaryInput,
					fileId: args.fileId,
				});
				if (!isSummaryBatched) {
					const result = await summarizeFile(ctx, summaryInput);
					title = title || result.title;
					summary = result.summary;
					autoTags = result.tags;
				}
			} catch (error) {
				logError('[semantic_file] summarize/tag call failed', {
					fileId: args.fileId,
					filename: file.filename,
					error,
				});
				// D1: a refused call is owed, with the embedding that reads its summary.
				owed.note(error, ['summary', 'embedding']);
				// Fallback: use filename as title
				title = title || file.filename;
			}
		}

		// 3. Generate embedding
		let embedding: number[] = [];
		let embeddingSpace: MeasuredSpace | undefined;
		const embeddingText = fileEmbeddingInput({ title, summary, extractedText });

		if (aiConfigured && embeddingText && !isSummaryBatched) {
			// Resolve OUTSIDE the try so a misconfigured embedder surfaces an
			// actionable error instead of being swallowed into a silent empty vector;
			// only a transient embed() failure fails soft (metadata without search).
			const embedder = await resolveIndexEmbedder(ctx);
			try {
				const before = await probeEmbeddingRevision(embedder.target);
				const result = await meterLlmCall(
					ctx,
					{ feature: 'embedding_file', root: fileRoot },
					(meter) => runEmbedding({ meter, model: embedder.model, value: embeddingText }),
					// A lost ledger row under-counts; failing retrieval or indexing over it is worse.
					{ onWriteError: 'ignore' }
				);
				embeddingSpace = await measuredEmbeddingSpace(embedder.target, result.embedding, before);
				embedding = toIndexVector(result.embedding);
			} catch (error) {
				logError('[semantic_file] embedding generation failed', {
					fileId: args.fileId,
					filename: file.filename,
					error: secretFreeErrorText(error),
				});
				owed.note(error, ['embedding']);
			}
		}

		// 3b. Inherit tags from the conversation/contact context the file was
		// shared in (e.g. a file dropped in a "Q3 financials" thread with
		// "Acme Corp" gets q3-financials / acme-corp).
		const contextTags = [fileCtx.threadSubject, ...fileCtx.contactNames]
			.filter((s): s is string => Boolean(s))
			.map(slugifyTag)
			.filter(Boolean);
		autoTags = Array.from(new Set([...autoTags, ...contextTags]));

		// Scrub any auto-tag that carries an injection attempt before it is
		// persisted, indexed into `searchableText`, and surfaced back to a model via
		// retrieval. The auto-tags are LLM-derived from untrusted file content.
		autoTags = scrubTags(autoTags);

		// 3c. Version provenance: a coarse diff summary vs the previous version.
		let changeSummary: string | undefined;
		if (fileCtx.previousText && extractedText && !extractedText.startsWith('[')) {
			const prevWords = fileCtx.previousText.trim().split(/\s+/).filter(Boolean).length;
			const curWords = extractedText.trim().split(/\s+/).filter(Boolean).length;
			const delta = curWords - prevWords;
			changeSummary =
				delta === 0
					? 'Content length unchanged from previous version'
					: `${Math.abs(delta)} words ${delta > 0 ? 'added' : 'removed'} vs previous version`;
		}

		// 4. Build searchable text
		const searchableText = buildFileSearchableText({
			filename: file.filename,
			title,
			summary,
			tags: file.tags,
			autoTags,
			extractedText,
		});

		// 5. Store results
		await ctx.runMutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId: args.fileId,
			title,
			summary,
			extractedText: extractedText.slice(0, 50000), // Cap stored text
			autoTags,
			embedding,
			// Stamped with the measured space and its model, or dropped when the
			// configuration moved on (updateProcessedMetadata).
			embeddingSpace,
			searchableText,
			changeSummary,
		});

		// 6. Feed the file into the knowledge graph (files → knowledge, the
		// "intelligence flows up" path). Skip when there's no real extracted
		// text (binary stubs like "[PDF file: …]"), or no model to extract with.
		if (
			aiConfigured &&
			!isSummaryBatched &&
			// A run that owes only the embedding already fed the graph.
			(args.stages === undefined || args.stages.includes('summary')) &&
			extractedText &&
			!extractedText.startsWith('[') &&
			extractedText.length > 80
		) {
			await ctx.runAction(internal.knowledge.extraction.extractFromFile, {
				fileId: args.fileId,
				// Awaited: the extraction spends from this action's clock (ADR-0073).
				root: boundedRoot(ctx, fileRoot),
			});
		}
		await owed.schedule();
	},
});

/**
 * Semantic file search (hybrid vector + full-text).
 *
 * Provide either `queryText` (embedded here, and used as-is for the FTS leg) or a
 * pre-computed `embedding` (vector leg only — no FTS without query text). Returns
 * full file documents (with storage URLs) in fused relevance order, each
 * annotated with its vector similarity `_score` (0 for a hit that only matched
 * full-text). Used by the agent context-retrieval step to surface source
 * documents alongside knowledge.
 *
 * SYMMETRIC with `knowledge.retrieval.semanticSearch`: both run two legs — vector
 * (`vector_files`) + full-text (`search_files`) — and fuse them with Reciprocal
 * Rank Fusion (`lib/rrf.ts:reciprocalRankFusion`, the SAME fusion, not a parallel
 * one). The FTS leg closes the documented vector-only asymmetry so a draft can
 * ground on exact tokens (an order number, a SKU, a surname) that pure vector
 * recall blurs; `searchableText` is populated from the extracted body (see lines
 * 144-165 above). RRF is scale-agnostic (no cosine-vs-BM25 normalization) and
 * degrades to vector-only when there's no query text or the FTS leg fails.
 *
 * Contact scoping (`scopeToContact`, REQUIRED) mirrors
 * `knowledge.retrieval.semanticSearch` and is the data-isolation gate for the
 * agent draft pipeline. Neither index can filter on `contactIds` (Convex can't
 * index array fields), so contact membership is enforced by over-fetching a
 * candidate pool and post-filtering AFTER fusion. The arg is required so a
 * forgotten arg can't silently read org-wide:
 *   - 'org-wide'         → no scoping (the trusted-member assistant path).
 *   - <contactId>        → org-general files (no `contactIds`) OR files linked
 *                          to that contact. A reply for contact A must not cite
 *                          contact B's uploaded contract/invoice.
 *   - 'org-general-only' → only org-general files (inbound has no resolved
 *                          contact → fail closed).
 *
 * Mail-capture scoping (`mailCaptures`, REQUIRED): a file captured from inbound
 * mail keeps its mailbox's permission, so it is returned only within the scope
 * the caller names (lib/semanticFileAccess.ts `mailCaptureScopeValidator`).
 */
export const semanticSearch = internalAction({
	args: {
		queryText: v.optional(v.string()),
		embedding: v.optional(v.array(v.float64())),
		// The space a precomputed `embedding` is in (`embedRetrievalQuery`). Without
		// it the vector leg is skipped: a vector is only ever compared within its
		// own space (searchSpaceVectors).
		embeddingSpaceId: v.optional(v.id('embeddingSpaces')),
		limit: v.optional(v.number()),
		// Required: 'org-wide' is the explicit member-path opt-out.
		scopeToContact: v.union(v.id('contacts'), v.literal('org-general-only'), v.literal('org-wide')),
		// Required: which files captured from inbound mail the caller may see
		// (lib/semanticFileAccess.ts). They keep their mailbox's permission.
		mailCaptures: mailCaptureScopeValidator,
		/** The caller's root request, so the query embedding's ledger row groups under it. */
		root: v.optional(llmRootContextValidator),
	},
	handler: async (
		ctx,
		args
	): Promise<Array<Doc<'semanticFiles'> & { url: string | null; _score: number }>> => {
		// One model budget for this action, from its start (ADR-0073).
		anchorActionDeadline(ctx);
		const queryText = args.queryText?.trim();

		// A caller's vector is used as given, with the space it was embedded in
		// (Team retrieval embeds once for this search and the knowledge search).
		// Otherwise the query is embedded here, and only when the table holds a
		// vector to find (knowledge/vectorCorpus.ts); with none, the full-text leg
		// runs alone.
		let vector = args.embedding && args.embedding.length > 0 ? args.embedding : undefined;
		let spaceId = args.embeddingSpaceId;
		if (!vector) {
			if (!queryText) return [];
			const query = await embedRetrievalQuery(
				ctx,
				['semanticFiles'],
				queryText,
				'[semantic_file] search',
				args.root
			);
			if (query.kind === 'failed') return [];
			if (query.kind === 'vector') {
				vector = query.embedding;
				spaceId = query.embeddingSpaceId;
			}
		}

		const limit = args.limit ?? 10;
		const scope = args.scopeToContact;
		// Over-fetch both legs (regardless of scope) so (a) the post-fusion contact
		// filter still has enough survivors to return `limit`, and (b) RRF ranks
		// over a real candidate pool on BOTH paths, not an already-thinned one.
		// Convex caps vectorSearch at 256; the final slice keeps the returned count
		// at `limit`.
		const fetchLimit = Math.min(256, Math.max(limit * 5, 50));

		// Leg 1 — semantic vector search (paraphrase / conceptual matches), in the
		// query vector's own space only.
		const hits = vector
			? await searchSpaceVectors(ctx, 'semanticFiles', {
					vector,
					embeddingSpaceId: spaceId,
					limit: fetchLimit,
				})
			: [];
		const vectorRanked: Id<'semanticFiles'>[] = hits.map((h) => h._id);
		const scoreById = new Map<string, number>(hits.map((h) => [h._id as string, h._score]));

		// Leg 2 — full-text search (exact tokens — order numbers, SKUs, surnames —
		// the embedding blurs). Only when we have query text; fails soft to
		// vector-only on any error.
		let ftsRanked: Id<'semanticFiles'>[] = [];
		if (queryText) {
			try {
				ftsRanked = await ctx.runQuery(internal.semanticFiles.ftsRankedFileIds, {
					queryText,
					limit: fetchLimit,
				});
			} catch (error) {
				logInfo('[semantic_file] fts leg failed', { error: String(error) });
			}
		}

		// Fuse the two rankings (scale-agnostic; vector-only when FTS is empty).
		const fusedIds = reciprocalRankFusion<Id<'semanticFiles'>>([vectorRanked, ftsRanked]);
		if (fusedIds.length === 0) return [];

		// Hydrate in fused order (getByIds preserves input order, drops deleted).
		const files = await ctx.runQuery(internal.semanticFiles.getByIds, { ids: fusedIds });
		const scored = files.map((file) => ({
			...file,
			_score: scoreById.get(file._id as string) ?? 0,
		}));

		// Mail-capture and contact scoping AFTER fusion (over-fetched above so
		// this doesn't starve the result set).
		const visible = scored.filter(
			(file) =>
				isInMailCaptureScope(file, args.mailCaptures) &&
				(scope === 'org-wide' || isContactScopeVisible(file.contactIds, scope))
		);
		return visible.slice(0, limit);
	},
});

// ============================================================
// Text Extraction Helpers
// ============================================================

/**
 * Turn a stored file into the text everything downstream reads.
 *
 * WHAT EACH FORMAT YIELDS IS NOT DECIDED HERE — `lib/fileExtraction` owns the
 * one classification, and the V8-side capture path consults the same table to
 * mark a name-only file as such instead of rendering it like a PDF the
 * assistant read cover to cover. This module is `'use node'` and that one is
 * not, which is a one-way restriction: a Node module may import a V8-safe one
 * (this file already imports `lib/constants`, `lib/fileSearchText` and
 * `lib/rrf`), so there is no second branch list to keep in step.
 *
 * Exported for unit tests — pure, no ctx.
 */
export async function extractText(blob: Blob, mimeType: string, filename: string): Promise<string> {
	const format = classifyExtraction(mimeType, filename);

	// HTML — strip tags, including `<script>`/`<style>` BODIES, so nothing
	// smuggled in markup reaches the LLM / knowledge-graph ingestion path.
	if (format === 'html') return htmlToPlainText(await blob.text());

	// Plain text, JSON and CSV are their own bytes.
	if (format === 'text' || format === 'csv') return await blob.text();

	// PDF — pure-JS extraction via unpdf (serverless-friendly, no native deps).
	// Falls back to the placeholder on any failure, so corrupt, encrypted or
	// scanned-image PDFs still flow through the pipeline.
	if (format === 'pdf') {
		const placeholder = extractionPlaceholder(format, filename);
		try {
			const buffer = await blob.arrayBuffer();
			const pdf = await getDocumentProxy(new Uint8Array(buffer));
			const { text } = await extractPdfText(pdf, { mergePages: true });
			const cleaned = text.replace(/\s+/g, ' ').trim();
			return cleaned.length > 0 ? cleaned : placeholder;
		} catch (error) {
			logError('[semantic_file] PDF text extraction failed', {
				filename,
				error,
			});
			return placeholder;
		}
	}

	// DOCX, XLSX, images and everything unrecognised: reading them would need
	// external libraries or a processing service, so the file is ingested under
	// its own name and nothing else.
	return extractionPlaceholder(format, filename);
}
