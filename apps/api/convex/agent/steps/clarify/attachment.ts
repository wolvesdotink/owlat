'use node';

/**
 * Attachment-ambiguity clarification helpers for the `clarify` step.
 *
 * Split out of `clarify/index.ts` (per CONVENTIONS.md "Split only above ~500
 * LOC" — do NOT baseline frozen debt) and mirroring how the pure matcher lives
 * in `inbox/attachmentMatch.ts`. Everything here is deterministic (model-free)
 * and FAIL-SOFT: any failure resolves to zero questions so ingest is never
 * blocked and the agent never guesses which file to attach.
 */

import { internal } from '../../../_generated/api';
import type { ActionCtx } from '../../../_generated/server';
import {
	computeAttachmentSuggestions,
	type AttachmentSuggestions,
} from '../../../inbox/attachmentSuggest';
import { detectAttachmentRequest } from '../../../inbox/attachmentMatch';
import type { ClarificationQuestion, ClarifyInput } from './index';

/** Cap on how many candidate filenames we offer as pick-one options. */
const MAX_ATTACHMENT_OPTIONS = 4;
const MAX_OPTION_LABEL_CHARS = 80;

/** Minimal ctx surface — satisfied by the `clarify` step's execute ctx. */
type AttachmentClarifyCtx = Pick<ActionCtx, 'runAction' | 'runQuery'>;

/**
 * Shape an ambiguous attachment choice into the single "which file?" clarification
 * question, with the candidate filenames as pick-one options. The label prefers a
 * human title over the raw filename. Pure + exported for tests.
 */
export function buildAttachmentQuestion(
	candidates: AttachmentSuggestions['candidates']
): ClarificationQuestion {
	const options: string[] = [];
	for (const candidate of candidates.slice(0, MAX_ATTACHMENT_OPTIONS)) {
		const label = (candidate.title?.trim() || candidate.filename).slice(0, MAX_OPTION_LABEL_CHARS);
		if (label.length > 0) options.push(label);
	}
	return {
		id: 'clarify_attachment',
		slotType: 'attachment',
		text: 'Which file should I attach to this reply?',
		options,
	};
}

/**
 * Deterministic (model-free) attachment-ambiguity check. When the inbound asks
 * for a document and the contact-scoped `semanticFiles` match is genuinely
 * ambiguous (several comparable files, no clear winner), return the single
 * "which file?" question so the owner picks instead of the agent guessing. A
 * single confident match returns [] here — the `draft` step surfaces that as a
 * one-tap suggestion rather than a question. FAIL-SOFT: any failure → [].
 */
export async function detectAttachmentClarification(
	ctx: AttachmentClarifyCtx,
	input: ClarifyInput
): Promise<ClarificationQuestion[]> {
	try {
		// Cheap gate first — skip the message read entirely when no document is
		// being asked for (the overwhelmingly common case).
		if (!detectAttachmentRequest(input.context).requested) return [];
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: input.inboundMessageId,
		});
		const suggestions = await computeAttachmentSuggestions(ctx, {
			context: input.context,
			contactId: message?.contactId,
		});
		if (!suggestions || !suggestions.ambiguous) return [];
		return [buildAttachmentQuestion(suggestions.candidates)];
	} catch {
		return [];
	}
}
