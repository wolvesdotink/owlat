/**
 * The engine's single entry point: run every analyzer over an email and roll the
 * results into one deliverability report with an overall verdict. `overall` is
 * the WORST verdict any analyzer produced — the report is only `pass` when spam,
 * links, and accessibility are all clean — which is exactly the signal the
 * restrict-only send gate needs: it objects when, and only when, `overall` is a
 * disqualifying `fail`.
 */

import { auditAccessibility, type AccessibilityReport } from './accessibility';
import { auditLinks, type LinkAuditReport } from './linkAudit';
import { scoreSpam, type SpamScoreReport } from './spamScore';
import type { DeliverabilityEmail, Finding, Verdict } from './types';
import { worstVerdict } from './types';

export interface DeliverabilityReport {
	readonly overall: Verdict;
	readonly spam: SpamScoreReport;
	readonly links: LinkAuditReport;
	readonly accessibility: AccessibilityReport;
	/** Every finding from every analyzer, in a stable analyzer order. */
	readonly findings: readonly Finding[];
}

/** Analyze an email across all three checks. Deterministic and side-effect free. */
export function analyzeEmail(email: DeliverabilityEmail): DeliverabilityReport {
	const spam = scoreSpam(email);
	const links = auditLinks(email);
	const accessibility = auditAccessibility(email);

	const overall = [spam.verdict, links.verdict, accessibility.verdict].reduce(
		worstVerdict,
		'pass' as Verdict
	);

	return {
		overall,
		spam,
		links,
		accessibility,
		findings: [...spam.findings, ...links.findings, ...accessibility.findings],
	};
}

/** The single human-facing objection line the send gate raises on a `fail`. */
export function summarizeFailure(report: DeliverabilityReport): string {
	const blockers = report.findings.filter((finding) => finding.severity === 'fail');
	const reasons = blockers.map((finding) => finding.message).slice(0, 3);
	const detail = reasons.length > 0 ? ` ${reasons.join(' ')}` : '';
	return `Deliverability Lab held this send: the draft failed pre-send checks.${detail}`;
}
