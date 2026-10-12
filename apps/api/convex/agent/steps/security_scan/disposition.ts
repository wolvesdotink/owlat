/**
 * The `security_scan` step's decisions, pure (ADR-0073, Phase 1c):
 *
 *   - L1: a quarantine the deterministic layers already confirm needs no model
 *     guard call.
 *   - D13: the model guard is skipped only for mail archived on its spam score
 *     (or, behind `mtaVerdictTerminal`, on the MTA's verdict) and for mail that
 *     arrives while the agent is off. Quarantine keeps precedence over both.
 *   - L5: the MTA's spam verdict ends the run only behind its switch.
 *   - L4: an early handling-rule archive comes after every safety outcome.
 *
 * The step's `route` and `execute` both read {@link scanDisposition}, so the
 * outcome the step persists on the agent-off path is the one it routes.
 */

import type { Infer } from 'convex/values';
import type { GuardNotRunReason, ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import type { securityFlagsValidator } from '../../../lib/convexValidators';
import { guardRequirement } from '../../../lib/aiRouting/guardRecord';
import { INJECTION_CONFIDENCE_THRESHOLD } from './patterns';

/** At or above this deterministic spam score the message is archived as spam. */
export const SPAM_ARCHIVE_SCORE = 80;

type MtaSpamVerdict = 'ham' | 'spam' | 'quarantine';

/** What the deterministic layers (regex, smuggling, URL reputation) found. */
export interface DeterministicFindings {
	patternInjection: boolean;
	/** Highest confidence among the deterministic injection layers. */
	patternConfidence: number;
	phishingDetected: boolean;
}

/**
 * L1: the deterministic layers alone already route the message to quarantine,
 * so no model verdict can change the outcome and the guard is not called.
 */
export function isDeterministicQuarantine(findings: DeterministicFindings): boolean {
	return (
		findings.phishingDetected ||
		(findings.patternInjection && findings.patternConfidence >= INJECTION_CONFIDENCE_THRESHOLD)
	);
}

/**
 * L5: the MTA's verdict ends the Team run only when the routing policy says so.
 * `quarantine` from the MTA is a spam-filter hold, not Owlat's injection
 * quarantine, so both non-ham verdicts archive as spam.
 */
export function isMtaVerdictTerminal(
	policy: Pick<ResolvedRoutingPolicy, 'mtaVerdictTerminal'>,
	verdict: MtaSpamVerdict | undefined
): boolean {
	return (
		policy.mtaVerdictTerminal === 'enforce' && (verdict === 'spam' || verdict === 'quarantine')
	);
}

/**
 * D13: why the model guard may be skipped, or `null` when it must run. Called
 * only when no deterministic quarantine settled the message. Spam archive wins
 * over agent-off, mirroring the route order.
 */
export function guardSkipReason(facts: {
	spamScore: number;
	isMtaVerdictTerminal: boolean;
	agentEnabled: boolean;
}): GuardNotRunReason | null {
	if (facts.spamScore >= SPAM_ARCHIVE_SCORE || facts.isMtaVerdictTerminal) return 'spam_archived';
	if (!facts.agentEnabled) return 'agent_disabled';
	return null;
}

/** The fields of the step's output the disposition reads. */
export interface DispositionFacts {
	isInjection: boolean;
	maxConfidence: number;
	phishingDetected: boolean;
	spamScore: number;
	agentEnabled: boolean;
	isMtaVerdictTerminal?: boolean;
	isEarlyRuleArchive?: boolean;
}

export type ScanDisposition =
	| 'quarantine'
	| 'archive_spam'
	| 'agent_off'
	| 'archive_handling_rule'
	| 'continue';

/**
 * The step's outcome, in precedence order: quarantine (a high-confidence
 * injection or a known-malicious URL), spam archive, agent off, an early
 * handling-rule archive (L4), otherwise on to retrieval and classification.
 */
export function scanDisposition(facts: DispositionFacts): ScanDisposition {
	if (
		(facts.isInjection && facts.maxConfidence >= INJECTION_CONFIDENCE_THRESHOLD) ||
		facts.phishingDetected
	) {
		return 'quarantine';
	}
	if (facts.spamScore >= SPAM_ARCHIVE_SCORE || facts.isMtaVerdictTerminal === true) {
		return 'archive_spam';
	}
	if (!facts.agentEnabled) return 'agent_off';
	if (facts.isEarlyRuleArchive === true) return 'archive_handling_rule';
	return 'continue';
}

export const GUARD_REQUIRED_ERROR =
	'The injection guard has not run on this message; it must run before the agent continues.';

/**
 * D13: a message whose scan skipped the model guard must not reach any step
 * after the scan until the guard has run. Every pipeline start (a new message,
 * a retry, a quarantine release) re-enters at `security_scan`, which runs it,
 * so only a path that resumes mid-pipeline can be refused here; the walker then
 * fails the message, and a retry restarts at the scan.
 *
 * Only the recorded skip refuses. A message with no scan record at all
 * (`not_scanned`) cannot reach a later step in production, and its rows predate
 * D13 or were never meant for the agent; it is not treated as a skip.
 */
export function guardBlocksStep(
	message: { securityFlags?: Infer<typeof securityFlagsValidator> } | null,
	kind: string
): boolean {
	return kind !== 'security_scan' && guardRequirement(message?.securityFlags) === 'guard_not_run';
}

/**
 * Where a stored Team message stands before a generative consumer outside the
 * pipeline reads it (knowledge extraction, thread interpretation, a briefing's
 * conversation history):
 *   - `rejected`: the scan or a late guard already held it back: quarantined,
 *     malware, a malicious URL, or an injection at quarantine confidence. Keyed
 *     on the persisted status and flags, so it holds after a late guard has
 *     cleared the D13 marker and for a deterministic quarantine with no marker
 *     at all (#1339).
 *   - `needs_guard`: its scan skipped the model guard (D13); run it first.
 *   - `clear`: anything else, including a message never scanned (store-only
 *     mail), which these consumers read before D13 too.
 */
export type GuardStanding = 'rejected' | 'needs_guard' | 'clear';

export function guardStanding(message: {
	processingStatus?: string;
	virusVerdict?: string;
	securityFlags?: Infer<typeof securityFlagsValidator>;
}): GuardStanding {
	const flags = message.securityFlags;
	if (
		message.processingStatus === 'quarantined' ||
		message.virusVerdict === 'infected' ||
		flags?.phishingDetected === true ||
		(flags?.injectionDetected === true && flags.confidence >= INJECTION_CONFIDENCE_THRESHOLD)
	) {
		return 'rejected';
	}
	return guardRequirement(flags) === 'guard_not_run' ? 'needs_guard' : 'clear';
}

/**
 * What one late guard run found: the injection it flagged at quarantine
 * confidence, if any, and whether it could not classify all of a non-empty
 * sample (`guardUnavailable`).
 */
export interface LateGuardVerdict {
	flagged?: { confidence: number; reason: string };
	isIncomplete: boolean;
}

/**
 * Fold one late guard run into the stored scan of the SAME scan generation
 * (`scanTimestamp`, which a late guard keeps). Monotonic, so concurrent late
 * guards (extraction, interpretation, a briefing's history) can complete in
 * any order: the D13 marker goes, a flagged injection is added and never
 * removed by a benign result, `guardUnavailable` only ever turns on, and
 * nothing the scan recorded is weakened. Pure.
 */
export function mergeLateGuard(
	flags: Infer<typeof securityFlagsValidator>,
	verdict: LateGuardVerdict
): Infer<typeof securityFlagsValidator> {
	const { guardNotRun: _done, ...rest } = flags;
	const flagged = verdict.flagged;
	return {
		...rest,
		...(flagged
			? {
					injectionDetected: true,
					injectionType: flags.injectionDetected ? flags.injectionType : 'llm_prompt_injection',
					confidence: Math.max(flags.confidence, flagged.confidence),
					flaggedContent: flags.flaggedContent ?? flagged.reason,
				}
			: {}),
		guardUnavailable: flags.guardUnavailable === true || verdict.isIncomplete,
	};
}
