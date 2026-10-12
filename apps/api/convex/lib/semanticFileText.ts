/**
 * Pure text helpers of semantic file processing (`semanticFileProcessing.ts`),
 * split out to keep that action module under the size cap: tag scrubbing and
 * normalization, and the prompt truncation. Pure.
 */

import { detectInjection } from '../agent/steps/security_scan/patterns';

/**
 * Drop any tag that carries a prompt-injection attempt. Auto-tags are derived by
 * the LLM from untrusted extracted file content, so a planted instruction could
 * otherwise be persisted into `autoTags` / `searchableText` and reach a model via
 * retrieval. Deterministic pattern match — no extra LLM cost. Exported for unit
 * tests.
 */
export function scrubTags(tags: string[]): string[] {
	return tags.filter((tag) => !detectInjection(tag).detected);
}

/** Normalize a phrase into a lowercase kebab tag (e.g. "Q3 Financials" → "q3-financials"). */
export function slugifyTag(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

/** Cut text to `maxChars` for a prompt, saying so. */
export function truncateForLLM(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars) + '\n\n[Content truncated...]';
}
