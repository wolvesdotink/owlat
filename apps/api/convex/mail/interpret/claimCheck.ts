/**
 * Claim checks as decision questions (ADR-0073, plan Phase 3), the pure half:
 * the bounded state of one claim and its quotes, and the verdict a stored
 * claim-check label means for the reducer.
 *
 * Only whole claims are asked about: a clipped statement or quote could lose
 * the condition or contradiction that decides it, so a claim that does not fit
 * is not asked and stays unverified (the same rule the language verifier
 * keeps). The exact quote checks run before this: grounding only lets a claim
 * through whose quotes are exact spans of the message.
 *
 * Pure and isolate-safe.
 */

import type { BuiltDecisionState } from '../../lib/decision/evidence';
import { stateContentHash } from '../../lib/decision/evidence';
import { INTERPRET_TEXT_LIMITS, MAX_QUOTES_PER_CLAIM } from './schema';
import type { VerifyClaim, VerifyVerdict } from './pipeline';

/** A claim statement's length: an item's or fact's two clamped assertions and framing. */
export const CLAIM_STATEMENT_CHARS = 2 * INTERPRET_TEXT_LIMITS.assertion + 200;

/** Whether the claim fits the state whole: its statement, at most three quotes, each within the quote limit. */
export function fitsClaimCheck(claim: VerifyClaim): boolean {
	return (
		claim.statement.length <= CLAIM_STATEMENT_CHARS &&
		claim.quotes.length <= MAX_QUOTES_PER_CLAIM &&
		claim.quotes.every((quote) => quote.length <= INTERPRET_TEXT_LIMITS.quote)
	);
}

/**
 * The state of one bounded claim/evidence pair, or null when the claim does
 * not fit whole. Never a sender-memory key (a claim is not a message label).
 */
export function claimCheckState(claim: VerifyClaim): BuiltDecisionState | null {
	if (!fitsClaimCheck(claim)) return null;
	const state = { claim: claim.statement, quotes: [...claim.quotes] };
	return { state, isComplete: false, contentFingerprint: stateContentHash(state) };
}

/**
 * A claim-check label as the verifier's verdict: only `supported` applies a
 * claim; `contradicted` drops it; `insufficient` and an ambiguous answer keep
 * it a proposal, exactly like the language verifier's `unclear`.
 */
export function verdictOfLabel(label: string | undefined): VerifyVerdict | undefined {
	if (label === 'supported') return 'supported';
	if (label === 'contradicted') return 'unsupported';
	if (label === 'insufficient' || label === 'unknown') return 'unclear';
	return undefined;
}

/** Today's verdict as a claim-check label, the baseline of a shadow observation. */
export function labelOfVerdict(verdict: VerifyVerdict): string {
	if (verdict === 'supported') return 'supported';
	if (verdict === 'unsupported') return 'contradicted';
	return 'insufficient';
}
