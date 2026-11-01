'use node';

/**
 * Shared draft-generation service — the pipeline capability BOTH the B2B
 * shared-inbox agent (agent/steps/draft) and personal Postbox mail
 * (mail/ai/draftOnArrival) consume.
 *
 * The vision-machinery (draft + draft-quality self-check) originally lived
 * only inside the inbound agent's `draft` step, welded to `inboundMessages`.
 * This module extracts those capabilities into ONE code path so the OWNER's
 * personal inbox gets the same on-arrival draft + confidence as the shared
 * support inbox, without duplicating (or diverging) the prompt framing, the
 * SYSTEM_GUARD posture, or the fail-soft rules.
 *
 * FAIL-SOFT is preserved end-to-end: the self-check degrades to `null` (unknown
 * quality → never auto-approve). The primary draft generation itself throws on
 * prompt-injection in the assembled context, and on a model failure or a draft
 * that is tool-call markup twice over — the caller's catch turns that
 * into human review or no draft, never an auto-send. What the run already
 * spent is recorded before it throws.
 *
 * It makes no alternative-drafts call: no screen offers a reviewer a choice of
 * drafts, so a second capable-tier generation would be paid for and never
 * shown.
 */

import type { ActionCtx } from '../../_generated/server';
import {
	assertNoContextInjection,
	runSinglePassDraft,
	type SharedDraftParams,
	type SharedDraftResult,
} from './draftGeneration';
import { runCheapFirstDraft } from './cheapFirstDraft';

export { buildReplyLanguageInstruction } from './replyLanguage';
export { buildDraftMessages, buildDraftSystemPrompt } from './draftPrompt';
export {
	DraftInjectionError,
	DraftUnusableError,
	type CheapFirstWriter,
	type DraftStream,
	type SharedDraftParams,
	type SharedDraftResult,
} from './draftGeneration';
export {
	buildSelfCheckPrompt,
	draftQualitySchema,
	runDraftSelfCheck,
	type DraftQuality,
} from './draftSelfCheck';

// ─── Confirmed-facts block (clarification loop) ──────────────────────────────

/**
 * Turn the answered clarification questions into the TRUSTED confirmed-facts
 * block the draft renders OUTSIDE the untrusted tags. Pure + exported so a unit
 * test can assert the framing without a live model. Returns '' when there is
 * nothing confirmed. The values come from the authenticated owner (or their
 * stored memory), never from the inbound email, so they are safe as trusted
 * instruction.
 */
export function buildConfirmedContext(
	pending:
		| {
				questions: ReadonlyArray<{
					text: string;
					answer?: { value: string } | undefined;
				}>;
		  }
		| undefined
		| null
): string {
	if (!pending) return '';
	const lines: string[] = [];
	for (const q of pending.questions) {
		if (q.answer && q.answer.value.trim().length > 0) {
			lines.push(`- ${q.text.trim()} ${q.answer.value.trim()}`);
		}
	}
	if (lines.length === 0) return '';
	return lines.join('\n');
}

// ─── The pipeline ────────────────────────────────────────────────────────────

/**
 * THE shared draft pipeline every drafting surface runs: defense-in-depth
 * injection re-scan of the assembled context → primary generation (with
 * optional recall tools) → the host's quality check (`./draftGeneration.ts`
 * `runSinglePassDraft`). Answer mode streams the
 * generation into the owner's view and skips the check (no `selfCheck`
 * label); a reviewed Team draft may be written cheap-first (`writer`,
 * `./cheapFirstDraft.ts`).
 *
 * Deterministic for identical params under a mocked dispatch, which is exactly
 * what lets the B2B agent step and personal Postbox produce IDENTICAL output for
 * the same inbound message. Throws on prompt-injection in the assembled context
 * ({@link DraftInjectionError}), on a failed primary generation and on a draft
 * that stays tool-call markup after one retry (caller's catch → human review /
 * no draft); the self-check degrades softly.
 */
export async function runSharedDraft(
	ctx: ActionCtx,
	params: SharedDraftParams
): Promise<SharedDraftResult> {
	assertNoContextInjection(params.context);
	if (params.writer) return runCheapFirstDraft(ctx, params, params.writer);

	return runSinglePassDraft(ctx, params);
}
