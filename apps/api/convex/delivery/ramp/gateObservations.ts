/**
 * WHAT THE GATES OBSERVE — the evidence shapes, as distinct from the verdicts.
 *
 * Split out of `gateTypes.ts` for size (CONVENTIONS' ~500 LOC guideline);
 * `gateTypes.ts` re-exports both, so it stays the one import surface for the
 * gate vocabulary and no reader has to know about the seam.
 *
 * Neither shape carries a RATE. Both are COUNTS plus the instant the newest of
 * them was recorded, because every rate in this subsystem is derived in exactly
 * one place — a second one is a second answer, and the controller and the
 * dashboard must never be able to disagree about a number (ADR-0042).
 */

import type { SeedArmPlacementCounts } from '@owlat/shared/seedPlacement';
import type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';

/**
 * What receivers said in their own 4xx/5xx text over the window, reduced to the
 * only question the ramp asks of it: how many responses were BLOCK messages?
 *
 * The classification itself is the MTA's (`classifySmtpResponse`), and the
 * category names are the shared vocabulary in
 * `@owlat/shared/smtpBlockCategories` — this side counts, it does not parse.
 *
 * PRODUCED BY `analytics/smtpResponseCategories.ts` (issue #501), for the
 * controller (`rampControllerInputs.ts`) and the dashboard alike — exactly as its
 * neighbour below is produced from the probe ledger. The MTA reports each
 * classified 4xx/5xx as a TYPED category on an `smtp.classified` webhook; the
 * counter it lands in is keyed per (org, cell, arm, UTC day) and sharded, and the
 * summarizer sums it over whichever window the reader is judging.
 *
 * `null` FROM THAT SUMMARIZER IS ABSENCE AND NOT A ZERO, which is the whole
 * reason the producer returns an option rather than an empty observation. A
 * window with no rows means the deployment did not measure and the gate's clause
 * yields no verdict; a window of rows that were all rate pressure means it DID
 * measure and receivers are not refusing us. Those are opposite facts, and a
 * zeroed observation standing in for the first would report the second.
 */
export interface SmtpBlockObservation {
	/** Every classified response over the window — the denominator. */
	readonly observed: number;
	/**
	 * HOW MANY RESPONSES LANDED IN EACH CATEGORY. ONE FIELD, because the numerator
	 * and the names are one fact and a type that lets them disagree is a type that
	 * will.
	 *
	 * An earlier shape carried a `blocked` count and a `categories` list side by
	 * side. Nothing tied them together: a producer whose count included throttles
	 * while the list happened to name one refusal would halt a healthy cell, and a
	 * producer whose count was right while the list named only rate pressure would
	 * silently never fire the hard stop at all. Both readings typechecked. Here the
	 * gate DERIVES the numerator by summing the keys in `SMTP_BLOCK_CATEGORIES` and
	 * DERIVES the named categories as the ones with a positive count, so the two can
	 * only ever describe the same rows.
	 *
	 * RATE PRESSURE BELONGS IN HERE TOO. `rate_limited` and friends are not blocks
	 * and never contribute to the numerator, but they are what the receiver said and
	 * the audit row (plan D12) is better for having them.
	 *
	 * THE SHARED VOCABULARY, not free text. The stored row is
	 * `v.array(v.string())`, so the narrowing happens ONCE where that row is read
	 * (`isSmtpFailureCategory` — the WHOLE vocabulary, not the block subset, which
	 * would drop every category above) rather than on every element on every gate
	 * evaluation.
	 */
	readonly blockedByCategory: Readonly<Partial<Record<SmtpFailureCategory, number>>>;
	readonly observedAt: number;
}

/**
 * One arm's seed sweep for this cell: PER-PLACEMENT PROBE COUNTS over the
 * placement window, plus the instant the newest of them was classified. A
 * tripwire and never a gauge (plan D17) — there is no share in here, and the
 * gate derives none of its own from it.
 *
 * THE WHOLE SHARED VOCABULARY (`SeedArmPlacementCounts` over `SEED_PLACEMENTS`),
 * not the three placements the gate happens to branch on. `category` is REACHED
 * and `deleted` is not, so a producer that had to fold five placements into
 * three on the way in would be writing a second answer to "did this probe reach
 * the inbox" — the question `isSeedPlacementReached` exists to answer once
 * (ADR-0042 applied to the seed ledger).
 *
 * Omitted placements are zero; the roll-up scrubs negative, fractional and
 * non-finite counts before any of them can become a sample size.
 *
 * PRODUCED BY `analytics/seedPlacementSweeps.ts` from the probe ledger, for the
 * controller (`rampControllerInputs.ts`) and the dashboard alike.
 */
export interface SeedPlacementObservation extends SeedArmPlacementCounts {
	readonly observedAt: number;
}
