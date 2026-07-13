'use node';

/**
 * Knowledge Extraction Pipeline
 *
 * Automatically extracts structured knowledge from processed inbound messages.
 * Pipeline: entity extraction → fact extraction → deduplication → contradiction check → store.
 */

import { createHash } from 'node:crypto';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { inboundMessageBody, readMailMessageText } from '../lib/messageBody';
import { CURRENT_EMBEDDING_MODEL } from '../lib/constants';
import { embed, type EmbeddingModel } from 'ai';
import { z } from 'zod';
import {
	resolveLanguageModel,
	resolveEmbeddingModel,
	assertEmbeddingDimension,
} from '../lib/llmProvider';
import { logInfo } from '../lib/runtimeLog';
import { runLlmObject } from '../lib/llm/dispatch';
import { recordLlmSpend } from '../analytics/llmUsage';
import { ENTRY_TYPES } from '../schema/knowledge';
import { normalizeForHash } from '../lib/knowledgeEdges';
import { detectInjection, detectSmuggling } from '../agent/steps/security_scan/patterns';

/**
 * Guard knowledge extraction against prompt injection planted in untrusted
 * inbound content. The extractor interpolates raw From/Subject/Body into an LLM
 * prompt, and the extracted facts later surface to users + the assistant — so a
 * planted instruction in an imported/backfilled email could poison the
 * knowledge graph and reach the model's output. The live agent pipeline runs
 * these guards on receive, but the migration + file backfill paths don't, so we
 * re-check here before building the prompt. Deterministic patterns only — no
 * extra LLM call/cost. Returns a reason string when extraction should be
 * skipped, else null.
 */
export function injectionRisk(text: string, html?: string): string | null {
	const injection = detectInjection(text);
	if (injection.detected) return `injection:${injection.pattern}`;
	const smuggling = detectSmuggling(html);
	if (smuggling.detected) return `smuggling:${smuggling.type}`;
	return null;
}

type ExtractedEntry = z.infer<typeof extractionSchema>['entries'][number];

const extractionSchema = z.object({
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
 * For each extracted entry, compute its embedding and persist it via
 * `knowledge.graph.saveEntry`. Shared by `extractFromMessage` (source
 * `agent_extracted`) and `extractFromFile` (source `file`) — the only
 * difference between the two call sites is the source/contact/thread
 * provenance, threaded through `source`.
 */
async function persistExtractedEntries(
	ctx: ActionCtx,
	embeddingModel: EmbeddingModel,
	entries: ExtractedEntry[],
	source: {
		sourceType: 'agent_extracted' | 'file' | 'email';
		sourceId: string;
		contactIds?: Id<'contacts'>[];
		threadId?: Id<'conversationThreads'>;
	}
): Promise<void> {
	const entryIds: Id<'knowledgeEntries'>[] = [];
	for (const entry of entries) {
		const { embedding } = await embed({
			model: embeddingModel,
			value: `${entry.title}: ${entry.content}`,
		});
		assertEmbeddingDimension(embedding);

		// Deterministic fingerprint of the normalized title+content, so saveEntry's
		// content-hash leg can dedup the same fact restated across sources.
		const contentHash = createHash('sha256')
			.update(normalizeForHash(entry.title, entry.content))
			.digest('hex');

		const entryId = await ctx.runMutation(internal.knowledge.graph.saveEntry, {
			entryType: entry.type,
			title: entry.title,
			content: entry.content,
			sourceType: source.sourceType,
			sourceId: source.sourceId,
			contactIds: source.contactIds,
			threadId: source.threadId,
			embedding: Array.from(embedding),
			embeddingModel: CURRENT_EMBEDDING_MODEL,
			embeddingGeneratedAt: Date.now(),
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
		});
	}
}

/**
 * Extract knowledge from a processed inbound message
 */
export const extractFromMessage = internalAction({
	args: {
		inboundMessageId: v.id('inboundMessages'),
	},
	handler: async (ctx, args) => {
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: args.inboundMessageId,
		});
		if (!message) return;
		const { text: bodyText, html: bodyHtml } = inboundMessageBody(message);

		const textContent = bodyText ?? '';
		if (textContent.length < 20) return; // Skip very short messages

		// Don't feed prompt-injection payloads into the extraction LLM.
		const risk = injectionRisk(textContent, bodyHtml);
		if (risk) {
			logInfo('[knowledge.extract] skipped: injection risk in untrusted message', { risk });
			return;
		}

		// Idempotency: a message re-run through the pipeline (e.g. cron retry)
		// must not duplicate its knowledge entries.
		const already = await ctx.runQuery(internal.knowledge.graph.countBySource, {
			sourceType: 'agent_extracted',
			sourceId: args.inboundMessageId,
		});
		if (already > 0) return;

		try {
			// ── Step 1: Extract knowledge using LLM ──
			const model = await resolveLanguageModel(ctx, 'extract');

			const {
				object: extraction,
				tokenUsage,
				modelUsed,
			} = await runLlmObject({
				model,
				schema: extractionSchema,
				prompt: `Extract organizational knowledge from this email message. Only extract information that would be useful for future reference.

From: ${message.from}
Subject: ${message.subject}
Body:
${textContent}

Extract any:
- Facts: verifiable information about people, companies, or things
- Decisions: choices that were made
- Events: things that happened at a specific time
- Preferences: how someone likes things done
- Goals: objectives being worked toward
- Relationships: connections between people
- Action Items: commitments or tasks mentioned

Only extract knowledge you are confident about. Skip trivial greetings or small talk.`,
				temperature: 0.1,
			});
			logInfo('[knowledge.extract] llm call', { tokenUsage, modelUsed });
			await recordLlmSpend(ctx, 'knowledge_extract_message', tokenUsage, modelUsed);

			if (!extraction.entries || extraction.entries.length === 0) return;

			// ── Step 2: Generate embeddings and store ──
			const embeddingModel = await resolveEmbeddingModel(ctx);
			await persistExtractedEntries(ctx, embeddingModel, extraction.entries, {
				sourceType: 'agent_extracted',
				sourceId: args.inboundMessageId,
				contactIds: message.contactId ? [message.contactId] : undefined,
				threadId: message.threadId ?? undefined,
			});
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[Knowledge Extraction] Failed:', error);
		}
	},
});

/**
 * Extract knowledge from a processed semantic file (files → knowledge graph).
 *
 * Mirrors `extractFromMessage` but reads the file's extracted text/summary.
 * Scheduled by `semanticFileProcessing.processFile` once a file has real
 * extracted text. Entries are stored with `sourceType: 'file'`.
 */
export const extractFromFile = internalAction({
	args: {
		fileId: v.id('semanticFiles'),
	},
	handler: async (ctx, args) => {
		const file = await ctx.runQuery(internal.semanticFiles.getInternal, { fileId: args.fileId });
		if (!file) return;

		const textContent = (file.extractedText ?? '').slice(0, 8000);
		if (textContent.length < 40) return; // Not enough content to extract from

		// Don't feed prompt-injection payloads into the extraction LLM.
		const risk = injectionRisk(textContent);
		if (risk) {
			logInfo('[knowledge.extractFile] skipped: injection risk in untrusted file', { risk });
			return;
		}

		// Idempotency: a file reprocessed by the backfill cron must not
		// duplicate its knowledge entries.
		const already = await ctx.runQuery(internal.knowledge.graph.countBySource, {
			sourceType: 'file',
			sourceId: args.fileId,
		});
		if (already > 0) return;

		try {
			const model = await resolveLanguageModel(ctx, 'extract');
			const {
				object: extraction,
				tokenUsage,
				modelUsed,
			} = await runLlmObject({
				model,
				schema: extractionSchema,
				prompt: `Extract organizational knowledge from this document. Only extract information that would be useful for future reference.

Filename: ${file.filename}
Title: ${file.title ?? file.filename}
${file.summary ? `Summary: ${file.summary}\n` : ''}Content:
${textContent}

Extract any facts, decisions, events, preferences, goals, relationships, or action items. Skip boilerplate and formatting noise.`,
				temperature: 0.1,
			});
			logInfo('[knowledge.extractFile] llm call', { tokenUsage, modelUsed });
			await recordLlmSpend(ctx, 'knowledge_extract_file', tokenUsage, modelUsed);

			if (!extraction.entries || extraction.entries.length === 0) return;

			const embeddingModel = await resolveEmbeddingModel(ctx);
			await persistExtractedEntries(ctx, embeddingModel, extraction.entries, {
				sourceType: 'file',
				sourceId: args.fileId,
				contactIds: file.contactIds ?? undefined,
				threadId: file.threadId ?? undefined,
			});
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[Knowledge File Extraction] Failed:', error);
		}
	},
});

/**
 * Strip HTML to rough plain text for messages that carry only an HTML body
 * (common for newsletters/marketing mail). Good enough for the extractor —
 * the LLM tolerates whitespace noise; we just want the words, not layout.
 */
function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Extract knowledge from an imported Postbox message (mailMessages → knowledge
 * graph). Mirrors `extractFromMessage` but reads a Postbox row's body and is
 * scoped to the sender contact resolved by the migration indexer. Entries are
 * stored with `sourceType: 'email'`, so they retrieve through the same
 * contact-scoped vector search as live agent-extracted knowledge.
 *
 * Idempotent: a re-run (migration restart / cron retry) no-ops if this message
 * already produced entries. Best-effort: a single message's failure never
 * derails the indexing sweep.
 */
export const extractFromMailMessage = internalAction({
	args: {
		mailMessageId: v.id('mailMessages'),
		// Sender contact(s) the entries are scoped to (resolved by the indexer).
		// Empty/undefined ⇒ org-general (visible to every contact's retrieval).
		contactIds: v.optional(v.array(v.id('contacts'))),
	},
	handler: async (ctx, args) => {
		const msg = await ctx.runQuery(internal.mail.migrationIndexing.getMessageForExtraction, {
			mailMessageId: args.mailMessageId,
		});
		if (!msg) return;

		let textContent = await readMailMessageText(ctx.storage, {
			textBodyInline: msg.textInline ?? undefined,
			textBodyStorageId: msg.textStorageId ?? undefined,
		});
		if (!textContent && msg.htmlInline) textContent = htmlToText(msg.htmlInline);
		textContent = textContent.slice(0, 8000);
		if (textContent.length < 20) return; // Skip very short messages

		// Don't feed prompt-injection payloads into the extraction LLM. The
		// imported mailbox is the highest-risk source — untrusted third-party mail
		// the live agent security_scan never saw.
		const risk = injectionRisk(textContent, msg.htmlInline ?? undefined);
		if (risk) {
			logInfo('[knowledge.extractMail] skipped: injection risk in imported mail', { risk });
			return;
		}

		// Idempotency: a message re-run through the indexer (migration restart)
		// must not duplicate its knowledge entries.
		const already = await ctx.runQuery(internal.knowledge.graph.countBySource, {
			sourceType: 'email',
			sourceId: args.mailMessageId,
		});
		if (already > 0) return;

		try {
			const model = await resolveLanguageModel(ctx, 'extract');
			const {
				object: extraction,
				tokenUsage,
				modelUsed,
			} = await runLlmObject({
				model,
				schema: extractionSchema,
				prompt: `Extract organizational knowledge from this email message. Only extract information that would be useful for future reference.

From: ${msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}
Subject: ${msg.subject}
Body:
${textContent}

Extract any:
- Facts: verifiable information about people, companies, or things
- Decisions: choices that were made
- Events: things that happened at a specific time
- Preferences: how someone likes things done
- Goals: objectives being worked toward
- Relationships: connections between people
- Action Items: commitments or tasks mentioned

Only extract knowledge you are confident about. Skip trivial greetings or small talk.`,
				temperature: 0.1,
			});
			logInfo('[knowledge.extractMail] llm call', { tokenUsage, modelUsed });
			await recordLlmSpend(ctx, 'knowledge_extract_mail', tokenUsage, modelUsed);

			if (!extraction.entries || extraction.entries.length === 0) return;

			const embeddingModel = await resolveEmbeddingModel(ctx);
			await persistExtractedEntries(ctx, embeddingModel, extraction.entries, {
				sourceType: 'email',
				sourceId: args.mailMessageId,
				contactIds: args.contactIds && args.contactIds.length > 0 ? args.contactIds : undefined,
			});
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[Knowledge Mail Extraction] Failed:', error);
		}
	},
});
