/**
 * Semantic File Processing
 *
 * AI-powered processing pipeline for uploaded files:
 * 1. Text extraction (based on MIME type)
 * 2. AI summarization
 * 3. Auto-tag generation
 * 4. Embedding generation for vector search
 */

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	resolveLanguageModel,
	getEmbeddingModel,
	assertEmbeddingDimension,
} from './lib/llmProvider';
import { CURRENT_EMBEDDING_MODEL } from './lib/constants';
import { embed } from 'ai';
import { z } from 'zod';
import { logInfo } from './lib/runtimeLog';
import { runLlmObject } from './lib/llm/dispatch';
import { recordLlmSpend } from './analytics/llmUsage';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';
import { isContactScopeVisible } from './lib/contactScope';
import { reciprocalRankFusion } from './lib/rrf';

/**
 * Process a newly uploaded file: extract text, generate summary,
 * create tags, and compute embedding vector.
 */
export const processFile = internalAction({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => {
		// Get file metadata
		const file = await ctx.runQuery(internal.semanticFiles.getInternal, { fileId: args.fileId });
		if (!file) return;

		// Resolve the conversation/contact context this file was shared in, so
		// tags can be inherited and a version diff computed.
		const fileCtx = await ctx.runQuery(internal.semanticFiles.getProcessingContext, {
			threadId: file.threadId,
			contactIds: file.contactIds,
			previousVersionId: file.previousVersionId,
		});

		// Get the file blob from storage
		const blob = await ctx.storage.get(file.storageId);
		if (!blob) return;

		// 1. Extract text based on MIME type
		let extractedText = '';
		try {
			extractedText = await extractText(blob, file.mimeType, file.filename);
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('Text extraction failed:', error);
		}

		if (!extractedText && !file.title) {
			// Nothing to process — store empty embedding
			await ctx.runMutation(internal.semanticFiles.updateProcessedMetadata, {
				fileId: args.fileId,
				embedding: [],
				searchableText: file.filename,
			});
			return;
		}

		// 2. Generate summary and tags via LLM
		const textForAI = truncateForLLM(extractedText, 8000);
		let summary = '';
		let autoTags: string[] = [];
		let title = file.title;

		if (textForAI.length > 50) {
			try {
				const result = await runLlmObject({
					model: await resolveLanguageModel(ctx, 'summarize'),
					schema: z.object({
						title: z.string().describe('Short descriptive title for the file'),
						summary: z.string().describe('2-3 sentence summary of the file content'),
						tags: z.array(z.string()).describe('5-10 relevant tags for categorization'),
					}),
					prompt: `Analyze this file and provide a title, summary, and tags.

Filename: ${file.filename}
MIME type: ${file.mimeType}${fileCtx.threadSubject ? `\nShared in conversation: "${fileCtx.threadSubject}"` : ''}${fileCtx.contactNames.length ? `\nRelated contacts: ${fileCtx.contactNames.join(', ')}` : ''}

Content:
${textForAI}`,
				});
				logInfo('[semantic_file] llm call', {
					tokenUsage: result.tokenUsage,
					modelUsed: result.modelUsed,
				});
				await recordLlmSpend(ctx, 'semantic_file', result.tokenUsage, result.modelUsed);

				title = title || result.object.title;
				summary = result.object.summary;
				autoTags = result.object.tags;
			} catch (error) {
				// eslint-disable-next-line no-console
				console.error('LLM processing failed:', error);
				// Fallback: use filename as title
				title = title || file.filename;
			}
		}

		// 3. Generate embedding
		let embedding: number[] = [];
		const embeddingText = [title, summary, extractedText.slice(0, 2000)].filter(Boolean).join(' ');

		if (embeddingText.length > 10) {
			try {
				const embeddingResult = await embed({
					model: getEmbeddingModel(),
					value: embeddingText,
				});
				assertEmbeddingDimension(embeddingResult.embedding);
				embedding = embeddingResult.embedding;
			} catch (error) {
				// eslint-disable-next-line no-console
				console.error('Embedding generation failed:', error);
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
		const searchableText = [
			file.filename,
			title,
			summary,
			...(autoTags ?? []),
			...(file.tags ?? []),
			extractedText.slice(0, 1000),
		]
			.filter(Boolean)
			.join(' ');

		// 5. Store results
		await ctx.runMutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId: args.fileId,
			title,
			summary,
			extractedText: extractedText.slice(0, 50000), // Cap stored text
			autoTags,
			embedding,
			embeddingModel: embedding.length > 0 ? CURRENT_EMBEDDING_MODEL : undefined,
			embeddingGeneratedAt: embedding.length > 0 ? Date.now() : undefined,
			searchableText: searchableText.slice(0, 5000),
			changeSummary,
		});

		// 6. Feed the file into the knowledge graph (files → knowledge, the
		// "intelligence flows up" path). Skip when there's no real extracted
		// text (binary stubs like "[PDF file: …]").
		if (extractedText && !extractedText.startsWith('[') && extractedText.length > 80) {
			await ctx.runAction(internal.knowledge.extraction.extractFromFile, {
				fileId: args.fileId,
			});
		}
	},
});

/** Normalize a phrase into a lowercase kebab tag (e.g. "Q3 Financials" → "q3-financials"). */
function slugifyTag(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

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
 */
export const semanticSearch = internalAction({
	args: {
		queryText: v.optional(v.string()),
		embedding: v.optional(v.array(v.float64())),
		limit: v.optional(v.number()),
		// Required: 'org-wide' is the explicit member-path opt-out.
		scopeToContact: v.union(v.id('contacts'), v.literal('org-general-only'), v.literal('org-wide')),
	},
	handler: async (
		ctx,
		args
	): Promise<Array<Doc<'semanticFiles'> & { url: string | null; _score: number }>> => {
		const queryText = args.queryText?.trim();

		let vector = args.embedding;
		if (!vector || vector.length === 0) {
			if (!queryText) return [];
			try {
				const { embedding } = await embed({ model: getEmbeddingModel(), value: queryText });
				vector = Array.from(embedding);
			} catch (error) {
				logInfo('[semantic_file] search embed failed', { error: String(error) });
				return [];
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

		// Leg 1 — semantic vector search (paraphrase / conceptual matches).
		const hits = await ctx.vectorSearch('semanticFiles', 'vector_files', {
			vector,
			limit: fetchLimit,
		});
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

		// Contact scoping AFTER fusion (over-fetched above so this doesn't starve
		// the result set).
		const visible =
			scope === 'org-wide'
				? scored
				: scored.filter((file) => isContactScopeVisible(file.contactIds, scope));
		return visible.slice(0, limit);
	},
});

// ============================================================
// Text Extraction Helpers
// ============================================================

// Exported for unit tests — pure, no ctx. Encodes which formats yield real
// extracted text (text/json/html/csv/pdf) vs a filename-only placeholder
// (docx/xlsx/images/unknown).
export async function extractText(blob: Blob, mimeType: string, filename: string): Promise<string> {
	// HTML — strip tags. MUST precede the generic `text/*` branch below:
	// `text/html` starts with `text/`, so checking text/* first would return the
	// raw markup (incl. <script>/<style> bodies) straight into the LLM /
	// knowledge-graph ingestion path.
	if (mimeType === 'text/html') {
		const html = await blob.text();
		return stripHtmlTags(html);
	}

	// Plain text files
	if (mimeType.startsWith('text/') || mimeType === 'application/json') {
		return await blob.text();
	}

	// CSV
	if (mimeType === 'text/csv' || filename.endsWith('.csv')) {
		return await blob.text();
	}

	// PDF — pure-JS extraction via unpdf (serverless-friendly, no native deps).
	// Falls back to the placeholder stub on any failure so corrupt or
	// extraction-failed PDFs still flow through the pipeline.
	if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
		const placeholder = `[PDF file: ${filename}]`;
		try {
			const buffer = await blob.arrayBuffer();
			const pdf = await getDocumentProxy(new Uint8Array(buffer));
			const { text } = await extractPdfText(pdf, { mergePages: true });
			const cleaned = text.replace(/\s+/g, ' ').trim();
			return cleaned.length > 0 ? cleaned : placeholder;
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('PDF text extraction failed:', error);
			return placeholder;
		}
	}

	// For remaining binary formats (DOCX, XLSX, etc.), we'd need external
	// libraries or a processing service. For now, return a placeholder and
	// rely on filename/title.

	if (
		mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
		mimeType === 'application/msword'
	) {
		return `[Word document: ${filename}]`;
	}

	if (
		mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
		mimeType === 'application/vnd.ms-excel'
	) {
		return `[Spreadsheet: ${filename}]`;
	}

	// Images — no text extraction (could use OCR in future)
	if (mimeType.startsWith('image/')) {
		return `[Image: ${filename}]`;
	}

	return `[File: ${filename}]`;
}

// Exported for unit tests. Drops <script>/<style> bodies before tags so file
// content fed to the LLM/knowledge graph can't smuggle markup or scripts.
export function stripHtmlTags(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// Exported for unit tests.
export function truncateForLLM(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars) + '\n\n[Content truncated...]';
}
