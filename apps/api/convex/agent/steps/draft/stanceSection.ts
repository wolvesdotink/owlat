'use node';

/**
 * Standing-stance assembly for the `draft` step — extracted from
 * `draft/index.ts` (kept under the ~500 LOC cap; CONVENTIONS.md).
 *
 * A matched `draft_with_stance` natural-language handling rule ("draft a polite
 * decline for recruiters") carries a compiled stance the drafter must take.
 * These stances are TRUSTED, user-authored standing instructions (SYSTEM_GUARD:
 * the rule text is trusted, the inbound email is not), so they are presented to
 * the model as authoritative — never as data from the untrusted email.
 */

import type { ActionCtx } from '../../../_generated/server';
import { internal } from '../../../_generated/api';
import { evaluateHandlingRules, toHandlingEvalMessage } from '../../../mail/handlingRules';

/** Minimal ctx surface — only needs to read the active handling rules. */
type StanceCtx = Pick<ActionCtx, 'runQuery'>;

/** The inbound fields the deterministic matcher inspects. */
type StanceMessage = {
	from?: string;
	subject?: string;
	textBody?: string;
	htmlBody?: string;
} | null;

/**
 * Build the standing-stance system message from the stances of matched
 * `draft_with_stance` handling rules. Pure + exported so a unit test can assert
 * the framing without a live model. Returns '' when there is no matched stance.
 * Presents the stances as authoritative standing instructions — this is what
 * makes "draft a polite decline for recruiters" actually shape the draft.
 */
export function buildStanceSection(stances: string[]): string {
	const lines: string[] = [];
	for (const stance of stances) {
		const trimmed = stance.trim();
		if (trimmed.length > 0) lines.push(`- ${trimmed}`);
	}
	if (lines.length === 0) return '';
	return (
		'Standing instructions from the mailbox owner for messages like this. ' +
		'They are authoritative — follow them when drafting this reply:\n' +
		lines.join('\n')
	);
}

/**
 * Evaluate the active handling rules against this inbound message and return the
 * standing-stance system message (or '' when nothing matches). Evaluated
 * deterministically from the same active rules the classify step matched on, so
 * the stance that RESTRICTED auto-send (route step) also actually shapes the
 * reply. OPTIONAL + FAIL-SOFT: no rules / no match / any accessor error
 * collapses to exactly today's generic draft (empty stance section).
 */
export async function resolveStanceSection(
	ctx: StanceCtx,
	message: StanceMessage
): Promise<string> {
	try {
		const rules = await ctx.runQuery(internal.mail.handlingRules.listActiveInternal, {});
		if (rules.length > 0 && message) {
			const outcome = evaluateHandlingRules(
				rules,
				toHandlingEvalMessage({
					from: message.from,
					subject: message.subject,
					textBody: message.textBody,
					htmlBody: message.htmlBody,
				})
			);
			return buildStanceSection(outcome.stances);
		}
	} catch {
		// fail-soft — degrade to today's generic draft
	}
	return '';
}
