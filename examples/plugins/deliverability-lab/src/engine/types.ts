/**
 * Shared, runtime-neutral value types for the Deliverability Lab analysis
 * engine. The engine is PURE: every analyzer is a deterministic function of its
 * input with no clock, network, randomness, or shared mutable state, so the same
 * email always produces the same report. That determinism is what lets the same
 * engine back a synchronous in-process send gate (Tier 1), an advisory connected
 * score hook (Tier 2), and a sandboxed seed-list job (Tier 3) without any of the
 * three disagreeing about whether a campaign is safe to ship.
 */

/** The bounded, immutable projection of an email the engine analyzes. */
export interface DeliverabilityEmail {
	/** RFC5322 From header value, e.g. `Team <team@example.com>`. */
	readonly from: string;
	readonly subject: string;
	/** HTML part, if the message has one. */
	readonly html?: string;
	/** Plain-text part / alternative, if the message has one. */
	readonly text?: string;
}

/** Severity of a single finding. `fail` is disqualifying; `warn` is advisory. */
export type FindingSeverity = 'warn' | 'fail';

/**
 * One issue an analyzer raised. `code` is a stable machine identifier (safe to
 * branch on); `message` is human-facing and already bounded — no analyzer ever
 * echoes unbounded untrusted email content into it.
 */
export interface Finding {
	readonly code: string;
	readonly severity: FindingSeverity;
	readonly message: string;
}

/** `pass` → nothing wrong; `warn` → advisory issues; `fail` → disqualifying issues. */
export type Verdict = 'pass' | 'warn' | 'fail';

/** Roll a set of findings up into the strongest verdict any of them implies. */
export function verdictOf(findings: readonly Finding[]): Verdict {
	if (findings.some((finding) => finding.severity === 'fail')) return 'fail';
	if (findings.length > 0) return 'warn';
	return 'pass';
}

/** The strongest (worst) of two verdicts. */
export function worstVerdict(a: Verdict, b: Verdict): Verdict {
	const rank: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 };
	return rank[a] >= rank[b] ? a : b;
}
