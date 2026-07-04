'use node';

/**
 * The `draft` step's bounded `recallKnowledge` agent tool.
 *
 * The draft step used to consume a FROZEN context string with no tool loop: when
 * the model realized mid-draft that it needed a fact retrieval hadn't surfaced,
 * it could neither fetch it nor route to clarify — so it hallucinated or hedged.
 * This tool lets the model fetch MORE grounding, on demand, from the SAME
 * contact-scoped knowledge base the context step already drew on.
 *
 * Isolation: retrieval is contact-scoped through the exact same gate the context
 * step uses (`scopeToContact` = the inbound's contact, or `'org-general-only'`
 * when there is no resolved contact — never `'org-wide'` on this drafting path),
 * so a reply for contact A can never pull contact B's facts. Retrieved text is
 * UNTRUSTED, so it is injection-scrubbed + length-clamped before it re-enters the
 * model (same posture as the assistant tools).
 *
 * Bounded: at most {@link MAX_RECALL_CALLS} live retrievals per draft (the
 * factory closes over a per-draft counter); further calls return an empty,
 * instructive result instead of retrieving. FAIL-SOFT: any retrieval error
 * resolves to an empty fact list — the model then drafts with what it has (and
 * the downstream self-check + route gate still refuse to auto-send on a weak,
 * ungrounded draft), never blocking the pipeline.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { ActionCtx } from '../../../_generated/server';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { scrubForInjection, clampText } from '../../../assistant/prompt';

/** Max live knowledge retrievals the model may make while drafting one reply. */
export const MAX_RECALL_CALLS = 3;
/** Results returned per recall call. */
export const RECALL_RESULT_LIMIT = 5;
/** Per-fact content clamp (chars) before untrusted text re-enters the model. */
const RECALL_CONTENT_CHARS = 800;

export interface RecallToolArgs {
	runAction: ActionCtx['runAction'];
	/** The SAME contact-scope gate the context step used: the inbound's contact,
	 * or 'org-general-only' when the inbound has no resolved contact. Never
	 * 'org-wide' on the drafting path. */
	scopeToContact: Id<'contacts'> | 'org-general-only';
}

/**
 * Build the bounded, contact-scoped `recallKnowledge` tool for ONE draft. The
 * returned tool closes over a private call counter, so passing it into a single
 * `runLlmTextWithTools` turn caps the total live retrievals at
 * {@link MAX_RECALL_CALLS} regardless of how many times the model calls it.
 */
export function buildRecallKnowledgeTool(args: RecallToolArgs) {
	let calls = 0;
	return tool({
		description:
			'Fetch ADDITIONAL grounding facts about this specific contact and the ' +
			'organization from the knowledge base, when a fact you need to answer ' +
			'accurately is NOT already in the provided context. Prefer this over ' +
			'guessing: never invent a price, policy, date, or commitment. Returns an ' +
			'empty list when nothing relevant is found — in that case, do not assert ' +
			'the missing fact; answer only what the context supports (a human will ' +
			'review). Bounded to a few calls per reply.',
		inputSchema: z.object({
			query: z
				.string()
				.min(1)
				.describe('A short natural-language description of the fact you need.'),
		}),
		execute: async ({ query }) => {
			if (calls >= MAX_RECALL_CALLS) {
				return {
					facts: [],
					note: 'Recall limit reached. Draft using only the facts already available; do not invent the missing information.',
				};
			}
			calls++;
			try {
				const entries = await args.runAction(internal.knowledge.retrieval.semanticSearch, {
					queryText: query,
					limit: RECALL_RESULT_LIMIT,
					// SAME isolation gate as the context step — contact-scoped, never
					// org-wide, so this can only surface org-general OR this contact's
					// knowledge.
					scopeToContact: args.scopeToContact,
					// Flat retrieval — the tool is a targeted fetch-more, not a graph walk.
					expandGraph: false,
				});
				return {
					facts: entries.map((e) => ({
						title: scrubForInjection(e.title),
						type: e.entryType,
						confidence: e.confidence,
						// A superseded fact is surfaced but flagged so the model doesn't
						// rely on it over a newer one.
						stale: e._stale ?? false,
						content: scrubForInjection(clampText(e.content, RECALL_CONTENT_CHARS)),
					})),
				};
			} catch {
				// FAIL-SOFT: retrieval failure ⇒ no facts. The model drafts with what it
				// has; the self-check + route gate still guard auto-send.
				return { facts: [] };
			}
		},
	});
}
