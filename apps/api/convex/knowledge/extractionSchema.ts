/**
 * The extraction's model schema and its deterministic injection check, split
 * out of `./extraction.ts` (a Node module, at the size cap). Runtime-neutral.
 */

import { z } from 'zod';
import { ENTRY_TYPES } from '../schema/knowledge';
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
