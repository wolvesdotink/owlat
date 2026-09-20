/**
 * Classification field allowlists for the `draft` Agent step. The
 * classifier upstream can be steered by attacker text, so we never trust
 * its output blindly when interpolating into the privileged system role.
 * Anything outside the allowlist (or empty) is rewritten to 'unspecified'.
 *
 * Moved from the deleted `convex/agent/agentDrafter.ts` so unit tests of
 * the allowlist semantics keep working.
 */

// The allowlists are the classifier's own enums (agent/steps/classify) plus the
// legacy labels older rows still carry. They used to lag the classifier —
// 'urgent', 'normal', 'feature_request', 'complaint', 'information' were all
// rewritten to 'unspecified' — so the drafter saw a blank classification block
// for most mail and the complexity router never saw an urgent priority.
export const ALLOWED_CATEGORIES = new Set([
	'support',
	'sales',
	'billing',
	'feature_request',
	'complaint',
	'spam',
	'internal',
	'feedback',
	'partnership',
	'recruiting',
	'other',
	'unspecified',
]);

export const ALLOWED_INTENTS = new Set([
	'question',
	'complaint',
	'request',
	'information',
	'escalation',
	'acknowledgment',
	'praise',
	'unsubscribe',
	'informational',
	'urgent',
	'other',
	'unspecified',
]);

export const ALLOWED_SENTIMENTS = new Set([
	'positive',
	'neutral',
	'negative',
	'mixed',
	'unspecified',
]);

export const ALLOWED_PRIORITIES = new Set([
	'urgent',
	'normal',
	'low',
	'medium',
	'high',
	'critical',
	'unspecified',
]);

/** ISO 639-1 (optionally region-tagged) language code, lowercased; else undefined. */
export function safeLanguage(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const lc = value.trim().toLowerCase();
	return /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(lc) ? lc : undefined;
}

export function safeEnum(value: unknown, allowed: Set<string>): string {
	if (typeof value !== 'string') return 'unspecified';
	const lc = value.trim().toLowerCase();
	return allowed.has(lc) ? lc : 'unspecified';
}
