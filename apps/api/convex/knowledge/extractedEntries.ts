'use node';

/**
 * The extraction's structured output and its persistence: each extracted entry
 * is checked for an existing row (M4), embedded under the extraction's root,
 * stamped with the space its vector is in (ADR-0073) and saved through
 * `knowledge.graph.saveEntry`. Split out of `knowledge/extraction.ts`, which
 * holds the three extraction actions.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { toIndexVector, type IndexEmbedder } from '../lib/llmProvider';
import {
	EmbeddingRevisionChangedError,
	measuredEmbeddingSpace,
	probeEmbeddingRevision,
} from '../lib/aiRouting/embeddingProbe';
import { knowledgeEmbeddingInput } from '../lib/aiRouting/embeddingInputs';
import { meterLlmCall } from '../analytics/meteredSpend';
import { runEmbedding } from '../lib/llm/embed';
import type { LlmRootContext } from '../lib/llm/requestMeter';
import { scheduledRoot } from '../lib/llm/actionDeadline';
import { ENTRY_TYPES } from '../schema/knowledge';
import { normalizeForHash } from '../lib/knowledgeEdges';

export type ExtractedEntry = z.infer<typeof extractionSchema>['entries'][number];

export const extractionSchema = z.object({
	entries: z
		.array(
			z.object({
				// Derived from the same ENTRY_TYPES tuple the Convex entryTypeValidator is
				// built from, so the LLM-facing enum can't drift from the stored column.
				type: z.enum(ENTRY_TYPES),
				title: z.string().describe('Brief title for this piece of knowledge'),
				content: z.string().describe('Detailed description of the knowledge'),
				confidence: z.number().min(0).max(1).describe('How confident you are this is accurate'),
				tags: z.array(z.string()).optional().describe('Relevant tags for categorization'),
			})
		)
		.describe('Knowledge entries extracted from the message'),
});

/**
 * The entries to save for a source: the ones an interrupted run stored
 * (`pendingEntries`, Sol r2 F3), else what the model returns now.
 */
export async function entriesToSave(
	pendingEntries: ExtractedEntry[] | undefined,
	ask: () => Promise<ExtractedEntry[] | undefined>
): Promise<ExtractedEntry[]> {
	return pendingEntries ?? (await ask()) ?? [];
}

/**
 * For each extracted entry, compute its embedding and persist it via
 * `knowledge.graph.saveEntry`. Shared by `extractFromMessage` (source
 * `agent_extracted`) and `extractFromFile` (source `file`) — the only
 * difference between the two call sites is the source/contact/thread
 * provenance, threaded through `source`.
 */
export async function persistExtractedEntries(
	ctx: ActionCtx,
	embedder: IndexEmbedder,
	entries: ExtractedEntry[],
	source: {
		sourceType: 'agent_extracted' | 'file' | 'email';
		sourceId: string;
		contactIds?: Id<'contacts'>[];
		threadId?: Id<'conversationThreads'>;
	},
	root: LlmRootContext
): Promise<void> {
	// Resumable (Sol r2 F3): `in_progress`, with the entries to save, until every
	// one is saved and linked (`knowledge/extractionProgress.ts`).
	const marker = { sourceType: source.sourceType, sourceId: source.sourceId };
	await ctx.runMutation(internal.knowledge.extractionProgress.markExtraction, {
		...marker,
		status: 'in_progress',
		entries,
	});
	const entryIds: Id<'knowledgeEntries'>[] = [];
	for (const entry of entries) {
		// Deterministic fingerprint of the normalized title+content, so saveEntry's
		// content-hash leg can dedup the same fact restated across sources.
		const contentHash = createHash('sha256')
			.update(normalizeForHash(entry.title, entry.content))
			.digest('hex');

		// M4: an entry saveEntry would answer with an existing row is not embedded
		// (knowledge/entryDedupe.ts). Asked per entry, in order, so a repeat
		// within this batch finds the row its first occurrence just wrote.
		const existing = await ctx.runQuery(internal.knowledge.entryDedupe.findExistingEntry, {
			sourceType: source.sourceType,
			sourceId: source.sourceId,
			title: entry.title,
			contentHash,
			contactIds: source.contactIds,
			threadId: source.threadId,
		});
		if (existing) {
			entryIds.push(existing);
			continue;
		}

		const before = await probeEmbeddingRevision(embedder.target);
		const { embedding } = await meterLlmCall(
			ctx,
			{ feature: 'embedding_knowledge', root },
			(meter) =>
				runEmbedding({ meter, model: embedder.model, value: knowledgeEmbeddingInput(entry) }),
			// A lost ledger row under-counts; failing retrieval or indexing over it is worse.
			{ onWriteError: 'ignore' }
		);
		// The space this vector is in, with the model that made it: saveEntry
		// stamps it, or drops the vector if the configuration moved on. A model
		// replaced during the call stores the entry without a vector; the
		// re-embed job embeds it later.
		const measured = await measuredEmbeddingSpace(embedder.target, embedding, before).catch(
			(error: unknown) => {
				if (error instanceof EmbeddingRevisionChangedError) return null;
				throw error;
			}
		);

		const entryId = await ctx.runMutation(internal.knowledge.graph.saveEntry, {
			entryType: entry.type,
			title: entry.title,
			content: entry.content,
			sourceType: source.sourceType,
			sourceId: source.sourceId,
			contactIds: source.contactIds,
			threadId: source.threadId,
			embedding: measured ? toIndexVector(embedding) : [],
			embeddingSpace: measured ?? undefined,
			confidence: entry.confidence,
			tags: entry.tags,
			contentHash,
		});
		entryIds.push(entryId);
	}

	// Hand the freshly-persisted batch to the deterministic structural linker
	// (clique among siblings + same-thread fan-out). Fire-and-forget so edge
	// construction never sits on the extraction action's critical path; the
	// mutation self-gates on `ai.knowledge` and is idempotent via upsertEdge.
	if (entryIds.length > 0) {
		await ctx.scheduler.runAfter(0, internal.knowledge.edges.linkStructural, {
			entryIds,
			threadId: source.threadId,
			sourceType: source.sourceType,
			sourceId: source.sourceId,
			// The inference pass runs later, in its own action: the root, not the deadline.
			root: scheduledRoot(root),
		});
	}
	await ctx.runMutation(internal.knowledge.extractionProgress.markExtraction, {
		...marker,
		status: 'complete',
	});
}
