/** The Deliverability Lab analysis engine: pure, deterministic, runtime-neutral. */

export type { DeliverabilityEmail, Finding, FindingSeverity, Verdict } from './types';
export { verdictOf, worstVerdict } from './types';
export {
	normalizeSpamScore,
	scoreSpam,
	SPAM_FAIL_THRESHOLD,
	SPAM_SCORE_MAX,
	SPAM_WARN_THRESHOLD,
	type SpamScoreReport,
} from './spamScore';
export { auditLinks, type LinkAuditReport } from './linkAudit';
export { auditAccessibility, type AccessibilityReport } from './accessibility';
export { analyzeEmail, summarizeFailure, type DeliverabilityReport } from './report';
export { MAX_SCAN_LENGTH } from './html';
