/**
 * The decisions of `files/processing.processFile`: where a file's title,
 * summary and auto-tags come from, what the processed row stores, and whether
 * the file feeds the knowledge graph. Pure: the action extracts the text,
 * calls the models and writes; these functions take what it read and return
 * plain data.
 */

import type { MeasuredSpace } from '../lib/aiRouting/embeddingRegistry';
import { buildFileSearchableText } from '../lib/fileSearchText';
import { scrubTags, slugifyTag, truncateForLLM } from '../lib/semanticFileText';

/** How much extracted text goes into the summarize/tag prompt. */
const SUMMARY_PROMPT_CHARS = 8000;
/** Below this the text is too short to summarize; the file keeps its own title. */
const MIN_SUMMARY_CHARS = 50;
/** How much extracted text the row stores. */
const STORED_TEXT_CHARS = 50_000;
/** Below this the text is too short for knowledge extraction. */
const MIN_GRAPH_TEXT_CHARS = 80;

export interface FileSummary {
	title: string | undefined;
	summary: string;
	autoTags: string[];
}

export type FileSummaryPlan =
	| ({ kind: 'settled' } & FileSummary)
	| { kind: 'ask'; textForAI: string; title: string | undefined };

/**
 * Where the summary comes from. `ask` sends the text to the model (or to a
 * provider batch); every other source is settled here. `title` on `ask` is
 * the file's own title, which a model title never replaces.
 */
export function planFileSummary(input: {
	/** Set when the extracted text tripped the prompt-injection guard. */
	injectionReason: string | null;
	/** The summary an earlier run stored, when this run owes only the embedding. */
	reused: FileSummary | undefined;
	batchedSummary: { title: string; summary: string; tags: string[] } | undefined;
	extractedText: string;
	isAiConfigured: boolean;
	title: string | undefined;
	filename: string;
}): FileSummaryPlan {
	const textForAI = truncateForLLM(input.extractedText, SUMMARY_PROMPT_CHARS);
	const none = { title: input.title, summary: '', autoTags: [] };
	// The extracted text goes into the prompt verbatim and the model's answer is
	// stored and later shown to the assistant, so a planted instruction could
	// poison downstream models. Poisoned text never reaches a model; the
	// filename keeps the file findable.
	if (input.injectionReason) {
		return { kind: 'settled', ...none, title: input.title || input.filename };
	}
	if (input.reused) return { kind: 'settled', ...input.reused };
	if (input.batchedSummary) {
		return {
			kind: 'settled',
			title: input.title || input.batchedSummary.title,
			summary: input.batchedSummary.summary,
			autoTags: input.batchedSummary.tags,
		};
	}
	if (textForAI.length <= MIN_SUMMARY_CHARS) return { kind: 'settled', ...none };
	// No model to ask: the same fallback as a failed call.
	if (!input.isAiConfigured) {
		return { kind: 'settled', ...none, title: input.title || input.filename };
	}
	return { kind: 'ask', textForAI, title: input.title };
}

/**
 * A coarse diff against the previous version's text, by word count. None
 * without a previous text, or for a placeholder (`[PDF file: …]`) body.
 */
export function versionChangeSummary(
	previousText: string | undefined,
	extractedText: string
): string | undefined {
	if (!previousText || !extractedText || extractedText.startsWith('[')) return undefined;
	const prevWords = previousText.trim().split(/\s+/).filter(Boolean).length;
	const curWords = extractedText.trim().split(/\s+/).filter(Boolean).length;
	const delta = curWords - prevWords;
	return delta === 0
		? 'Content length unchanged from previous version'
		: `${Math.abs(delta)} words ${delta > 0 ? 'added' : 'removed'} vs previous version`;
}

/**
 * The auto-tags the row stores: the model's, then the conversation and the
 * contacts the file was shared in (a file dropped in a "Q3 financials" thread
 * with "Acme Corp" gets q3-financials / acme-corp), deduplicated, with every
 * tag carrying an injection attempt dropped. The model's tags come from
 * untrusted file content and are later indexed and shown to a model again.
 */
export function finalAutoTags(
	autoTags: readonly string[],
	context: { threadSubject?: string; contactNames: readonly string[] }
): string[] {
	const contextTags = [context.threadSubject, ...context.contactNames]
		.filter((s): s is string => Boolean(s))
		.map(slugifyTag)
		.filter(Boolean);
	return scrubTags(Array.from(new Set([...autoTags, ...contextTags])));
}

/** What a file with no text and no title stores: an empty embedding and its name and tags. */
export function emptyFileMetadata(file: { filename: string; tags?: string[] }) {
	return {
		embedding: [],
		searchableText: buildFileSearchableText({ filename: file.filename, tags: file.tags }),
	};
}

/** What a processed file stores. */
export function processedFileMetadata(input: {
	file: { filename: string; tags?: string[] };
	context: { threadSubject?: string; contactNames: readonly string[]; previousText?: string };
	summary: FileSummary;
	extractedText: string;
	embedding: number[];
	embeddingSpace: MeasuredSpace | undefined;
}) {
	const { title, summary } = input.summary;
	const autoTags = finalAutoTags(input.summary.autoTags, input.context);
	return {
		title,
		summary,
		extractedText: input.extractedText.slice(0, STORED_TEXT_CHARS),
		autoTags,
		embedding: input.embedding,
		// Stamped with the measured space and its model, or dropped when the
		// configuration moved on (updateProcessedMetadata).
		embeddingSpace: input.embeddingSpace,
		searchableText: buildFileSearchableText({
			filename: input.file.filename,
			title,
			summary,
			tags: input.file.tags,
			autoTags,
			extractedText: input.extractedText,
		}),
		changeSummary: versionChangeSummary(input.context.previousText, input.extractedText),
	};
}

/**
 * Whether the file goes on to knowledge extraction (files → knowledge, the
 * "intelligence flows up" path): only real extracted text, not a binary stub
 * like "[PDF file: …]", with a model to extract with, and not while the
 * summary is out at a provider batch. A run that owes only the embedding
 * already fed the graph.
 */
export function feedsKnowledgeGraph(input: {
	isAiConfigured: boolean;
	isSummaryBatched: boolean;
	stages: readonly string[] | undefined;
	extractedText: string;
}): boolean {
	return (
		input.isAiConfigured &&
		!input.isSummaryBatched &&
		(input.stages === undefined || input.stages.includes('summary')) &&
		Boolean(input.extractedText) &&
		!input.extractedText.startsWith('[') &&
		input.extractedText.length > MIN_GRAPH_TEXT_CHARS
	);
}
