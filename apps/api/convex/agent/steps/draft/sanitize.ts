/**
 * Classification field allowlists for the `draft` Agent step. The
 * classifier upstream can be steered by attacker text, so we never trust
 * its output blindly when interpolating into the privileged system role.
 * Anything outside the allowlist (or empty) is rewritten to 'unspecified'.
 *
 * Moved from the deleted `convex/agent/agentDrafter.ts` so unit tests of
 * the allowlist semantics keep working.
 */

export const ALLOWED_CATEGORIES = new Set([
	'support', 'sales', 'feedback', 'spam', 'billing',
	'partnership', 'recruiting', 'other', 'unspecified',
]);

export const ALLOWED_INTENTS = new Set([
	'question', 'request', 'complaint', 'praise', 'unsubscribe',
	'informational', 'urgent', 'other', 'unspecified',
]);

export const ALLOWED_SENTIMENTS = new Set([
	'positive', 'neutral', 'negative', 'mixed', 'unspecified',
]);

export const ALLOWED_PRIORITIES = new Set([
	'low', 'medium', 'high', 'critical', 'unspecified',
]);

export function safeEnum(value: unknown, allowed: Set<string>): string {
	if (typeof value !== 'string') return 'unspecified';
	const lc = value.trim().toLowerCase();
	return allowed.has(lc) ? lc : 'unspecified';
}
