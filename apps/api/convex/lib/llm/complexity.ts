/**
 * Sub-millisecond, no-LLM heuristic for how complex a piece of *user-controlled*
 * text is, so a clearly-trivial request can be routed to a cheaper model. Two
 * rules, borrowed from spacebot's prompt router, keep this safe:
 *   1. Score ONLY user-controlled text — never the system prompt / context.
 *   2. Ambiguous text keeps the default (capable) model — quality never silently
 *      drops on a borderline request; only obviously-trivial text downgrades.
 */

import type { ClassifyIntent } from '../../agent/steps/classify/intents';

/** Complexity in [0, 1]: 0 = trivial ("thanks!"), 1 = involved (code, multi-part). */
export function scoreComplexity(text: string): number {
	const t = text.trim();
	if (t === '') return 0;
	const words = t.split(/\s+/).length;

	let score = 0;
	// Length — short asks are simpler (saturates around 40 words).
	score += Math.min(words / 40, 1) * 0.5;
	// Multiple sentences/questions mean more to reason about.
	const sentences = (t.match(/[.!?]+/g) ?? []).length;
	score += Math.min(sentences / 4, 1) * 0.2;
	// Code / markup / structured payloads → keep the capable model.
	if (/```|<\/?[a-z][\s\S]*?>|[{};]|\bfunction\b|\bSELECT\b|\bimport\b/i.test(t)) score += 0.4;
	// Multi-part / analytical asks add complexity.
	if (
		/\b(and also|additionally|furthermore|step by step|compare|analy[sz]e|explain why)\b/i.test(t)
	)
		score += 0.2;
	// Trivial acknowledgements / one-liners pull the score down.
	if (
		words <= 8 &&
		/\b(thanks?|thank you|ok|okay|got it|sounds good|will do|noted|yep|yes|no|fix (a )?typo|one[- ]?liner)\b/i.test(
			t
		)
	) {
		score -= 0.3;
	}

	return Math.max(0, Math.min(1, score));
}

/** At or below this score, text is "clearly trivial" and may be downgraded. */
export const COMPLEXITY_DOWNGRADE_THRESHOLD = 0.2;

/** Whether the user's text is trivial enough to route to the cheaper model. */
export function isTrivialUserText(text: string): boolean {
	return scoreComplexity(text) <= COMPLEXITY_DOWNGRADE_THRESHOLD;
}

/**
 * TRUSTED, sanitized classifier signals available to route the inbound agent's
 * `draft` step. Deliberately does NOT include the raw email body: in the agent
 * pipeline the sender is untrusted, so the email text must never steer the tier
 * choice (an attacker could otherwise craft a "thanks!"-looking body to force a
 * cheaper, lower-quality draft). These fields are the already-allowlisted output
 * of the `classify` step (agent/steps/draft/sanitize.ts).
 */
export interface ClassificationSignals {
	category: string;
	intent: string;
	priority: string;
	/** Classifier certainty in [0, 1]. */
	confidence: number;
}

/**
 * Minimum classifier certainty before a message may be treated as trivial. A
 * shaky classification must never justify a cheaper draft — ambiguity keeps the
 * capable tier so quality never silently drops.
 */
export const TRIVIAL_CLASSIFICATION_CONFIDENCE = 0.8;

/**
 * Intents whose replies are formulaic enough for the fast tier, in the
 * classifier's REAL domain (#1332). The set used to name `praise`,
 * `informational` and `unsubscribe`, which the classifier never emits, so only
 * `acknowledgment` ever matched. Corrected, an acknowledgement or a plain
 * piece of information is the formulaic reply; a question, a request, a
 * complaint or an escalation stays on the capable tier.
 *
 * Typed against the domain so it cannot drift again. It routes only REVIEWED
 * drafts written cheap-first ({@link classifiedDraftRoute}); the auto-sendable
 * route reads {@link ACTIVE_TRIVIAL_INTENTS}.
 */
export const TRIVIAL_INTENTS: ReadonlySet<ClassifyIntent> = new Set<ClassifyIntent>([
	'acknowledgment',
	'information',
]);

/**
 * The intents that route to the fast tier under `LLM_COMPLEXITY_ROUTING`:
 * exactly the one the old set matched, so that route is unchanged. The newly
 * eligible intents of {@link TRIVIAL_INTENTS} are NOT active there: such a
 * draft can be auto-sent, and nothing has evaluated the fast writer on them.
 * They are eligible only for a reviewed draft written cheap-first
 * ({@link classifiedDraftRoute}).
 */
export const ACTIVE_TRIVIAL_INTENTS: ReadonlySet<ClassifyIntent> = new Set<ClassifyIntent>([
	'acknowledgment',
]);

/** Priorities that must always keep the capable tier regardless of intent. */
const NON_DOWNGRADEABLE_PRIORITIES = new Set(['urgent', 'high', 'critical']);

/** The shared guards: certain enough, low stakes, and an intent in `intents`. */
function isTrivialFor(
	signals: ClassificationSignals,
	intents: ReadonlySet<ClassifyIntent>
): boolean {
	if (signals.confidence < TRIVIAL_CLASSIFICATION_CONFIDENCE) return false;
	if (NON_DOWNGRADEABLE_PRIORITIES.has(signals.priority)) return false;
	return (intents as ReadonlySet<string>).has(signals.intent);
}

/**
 * Decide, from TRUSTED classifier signals ONLY, whether an inbound message is
 * trivial enough to draft on the fast tier. Conservative and fail-safe: it
 * downgrades only high-confidence, low-stakes, formulaic-intent messages; every
 * ambiguous or important message keeps the capable tier. The raw (untrusted)
 * email body is intentionally not an input, so attacker-controlled text can
 * never influence the tier choice.
 */
export function isTrivialClassifiedMessage(signals: ClassificationSignals): boolean {
	return isTrivialFor(signals, ACTIVE_TRIVIAL_INTENTS);
}

/**
 * How the inbound agent's draft is written:
 *   - `fast`: `LLM_COMPLEXITY_ROUTING` downgrades it, exactly as before;
 *   - `cheap_first`: the fast writer first, then at most one escalation to the
 *     capable writer when its quality check does not pass
 *     (`agent/shared/cheapFirstDraft.ts`). Only for a REVIEWED draft (one that
 *     cannot be auto-sent), only with the routing policy's `cheapFirstWriter`
 *     at `reviewed`, and only for a message the corrected allowlist
 *     ({@link TRIVIAL_INTENTS}) and the same certainty and priority guards
 *     find formulaic;
 *   - `capable`: everything else, today's route. A complex message never
 *     goes cheap-first: it would only add a pass before the capable one.
 */
export type ClassifiedDraftRoute = 'capable' | 'fast' | 'cheap_first';

export interface ClassifiedDraftRouteOptions {
	/** `LLM_COMPLEXITY_ROUTING=1`. */
	readonly isComplexityRoutingOn: boolean;
	/** The routing policy's `cheapFirstWriter` switch (default `off`). */
	readonly cheapFirstWriter: 'off' | 'reviewed';
	/** The draft cannot be auto-sent: a person reviews it whatever it says. */
	readonly isReviewedDraft: boolean;
}

export function classifiedDraftRoute(
	signals: ClassificationSignals,
	opts: ClassifiedDraftRouteOptions
): ClassifiedDraftRoute {
	if (opts.isComplexityRoutingOn && isTrivialClassifiedMessage(signals)) return 'fast';
	if (
		opts.cheapFirstWriter === 'reviewed' &&
		opts.isReviewedDraft &&
		isTrivialFor(signals, TRIVIAL_INTENTS)
	) {
		return 'cheap_first';
	}
	return 'capable';
}
