/**
 * The model guard was skipped for a Team inbox message, and why. The
 * deterministic checks (patterns, spam score, URL reputation) ran; only the
 * model guard did not, and it runs before the agent does anything further
 * with the message. Module scope: the copy is catalog keys.
 */
import type { GuardNotRunReason } from '@owlat/shared/aiRouting';

/** `securityFlags.guardNotRun` as `inbox.queries.getThread` returns it. */
export interface GuardNotRunMarker {
	reason: GuardNotRunReason;
	at: number;
}

/** One sentence per reason. Total over the shared union: a new reason fails to compile here. */
export const GUARD_NOT_RUN_REASON_KEYS: Record<GuardNotRunReason, string> = {
	spam_archived: 'components.inbox.guardNotRun.reason.spamArchived',
	agent_disabled: 'components.inbox.guardNotRun.reason.agentDisabled',
	budget_refused: 'components.inbox.guardNotRun.reason.budgetRefused',
};
