/**
 * Natural-language handling rules — the DETERMINISTIC engine.
 *
 * A handling rule is authored by the user in plain English ("always decline
 * cold pitches", "flag anything from legal for me") and compiled ONCE, by a
 * cheap LLM (see ../handlingRulesCompile.ts), into a structured
 * `{ matcher, action }`. Everything in THIS file is pure, deterministic, and
 * network-free: the matcher is evaluated against each inbound message with no
 * model in the loop, so the untrusted email body can never reach an LLM through
 * a rule. The LLM only ever sees the TRUSTED, user-authored rule text at compile
 * time.
 *
 * Two consumers:
 *   - classify time: {@link evaluateHandlingRules} yields a category override
 *     (`categorize`) and/or an auto-archive decision (`auto_archive`).
 *   - autonomy: {@link restrictAutonomy} can only ever RESTRICT auto-send — a
 *     rule downgrades matching mail to human review (`never_auto_send`,
 *     `always_ask`, `draft_with_stance` = draft-only, `auto_archive`). It can
 *     NEVER widen a `false` auto-send decision into a `true` one.
 */

export type HandlingRuleActionType =
	| 'draft_with_stance'
	| 'categorize'
	| 'auto_archive'
	| 'always_ask'
	| 'never_auto_send';

/** Structured, deterministic matcher compiled from the rule prose. */
export interface HandlingRuleMatcher {
	/** Case-insensitive substrings matched against the sender address/name. */
	senders?: string[];
	/** Case-insensitive substrings matched against the subject. */
	subjectContains?: string[];
	/** Case-insensitive substrings matched against the body text. */
	bodyContains?: string[];
	/** Classifier categories this rule applies to (exact, case-insensitive). */
	categories?: string[];
}

export interface HandlingRuleAction {
	type: HandlingRuleActionType;
	/** For `draft_with_stance` — e.g. "a polite decline". */
	stance?: string;
	/** For `categorize` — the category to force. */
	category?: string;
}

/** Minimal shape the engine needs from a stored rule. */
export interface HandlingRuleLike {
	isEnabled: boolean;
	matcher: HandlingRuleMatcher;
	action: HandlingRuleAction;
	instruction: string;
}

/** The facts a rule is matched against. */
export interface HandlingRuleTarget {
	from: string;
	subject: string;
	body: string;
	/** Classifier category, when available (classify-time / route). */
	category?: string;
}

/** Action types that hold a message back from the autonomous send path. */
const RESTRICTING_ACTIONS: ReadonlySet<HandlingRuleActionType> = new Set([
	'never_auto_send',
	'always_ask',
	'draft_with_stance',
	'auto_archive',
]);

function includesAny(haystack: string, needles: string[] | undefined): boolean {
	if (!needles || needles.length === 0) return false;
	const lower = haystack.toLowerCase();
	for (const needle of needles) {
		const trimmed = needle.trim().toLowerCase();
		if (trimmed.length > 0 && lower.includes(trimmed)) return true;
	}
	return false;
}

function equalsAny(value: string | undefined, options: string[] | undefined): boolean {
	if (!options || options.length === 0) return false;
	if (value === undefined) return false;
	const lower = value.toLowerCase();
	for (const option of options) {
		if (option.trim().toLowerCase() === lower) return true;
	}
	return false;
}

/**
 * Does a single rule match a message? Facets present in the matcher are AND-ed
 * (a rule with `senders` + `categories` requires both); entries WITHIN one facet
 * are OR-ed. A matcher with NO facets never matches — a rule that would fire on
 * every message is treated as inert, never a catch-all, so a mis-compiled empty
 * matcher cannot silently govern the whole inbox.
 */
export function matchHandlingRule(rule: HandlingRuleLike, target: HandlingRuleTarget): boolean {
	if (!rule.isEnabled) return false;
	const m = rule.matcher;
	const facets: boolean[] = [];
	if (m.senders && m.senders.length > 0) facets.push(includesAny(target.from, m.senders));
	if (m.subjectContains && m.subjectContains.length > 0) {
		facets.push(includesAny(target.subject, m.subjectContains));
	}
	if (m.bodyContains && m.bodyContains.length > 0) {
		facets.push(includesAny(target.body, m.bodyContains));
	}
	if (m.categories && m.categories.length > 0) {
		facets.push(equalsAny(target.category, m.categories));
	}
	if (facets.length === 0) return false; // no facets → inert, never a catch-all
	for (const ok of facets) {
		if (!ok) return false;
	}
	return true;
}

export interface HandlingRuleOutcome {
	/** Instructions of the rules that matched (for the audit reason). */
	matchedInstructions: string[];
	/** Forced category from the first matching `categorize` rule, if any. */
	categoryOverride?: string;
	/** A matching `auto_archive` rule fired. */
	autoArchive: boolean;
	/** Stances requested by matching `draft_with_stance` rules. */
	stances: string[];
	/**
	 * A matching rule forbids autonomous sending for this message. Purely
	 * restrictive — see {@link restrictAutonomy}.
	 */
	restrictsAutoSend: boolean;
	/** Human-readable reasons (one per restricting/archiving rule). */
	reasons: string[];
}

/**
 * Evaluate every enabled rule against a message and fold the results. Pure and
 * order-independent for the boolean outcomes; the category override takes the
 * FIRST matching `categorize` rule (stable by input order).
 */
export function evaluateHandlingRules(
	rules: HandlingRuleLike[],
	target: HandlingRuleTarget
): HandlingRuleOutcome {
	const outcome: HandlingRuleOutcome = {
		matchedInstructions: [],
		autoArchive: false,
		stances: [],
		restrictsAutoSend: false,
		reasons: [],
	};

	for (const rule of rules) {
		if (!matchHandlingRule(rule, target)) continue;
		outcome.matchedInstructions.push(rule.instruction);
		const action = rule.action;

		if (action.type === 'categorize' && action.category && outcome.categoryOverride === undefined) {
			outcome.categoryOverride = action.category;
		}
		if (action.type === 'auto_archive') {
			outcome.autoArchive = true;
		}
		if (action.type === 'draft_with_stance' && action.stance) {
			outcome.stances.push(action.stance);
		}
		if (RESTRICTING_ACTIONS.has(action.type)) {
			outcome.restrictsAutoSend = true;
			outcome.reasons.push(
				`Handling rule "${rule.instruction}" (${action.type}) holds this message for human review.`
			);
		}
	}

	return outcome;
}

/**
 * Apply the handling-rule outcome to a base autonomy decision. RESTRICT-ONLY:
 * a rule can turn a permitted auto-send into human review, but can NEVER turn a
 * denied auto-send into a permitted one. This is the structural guarantee that a
 * natural-language rule can only ever tighten auto-send, never widen it.
 */
export function restrictAutonomy(
	baseAllowed: boolean,
	outcome: HandlingRuleOutcome
): { allowed: boolean; reason?: string } {
	if (!baseAllowed) return { allowed: false };
	if (outcome.restrictsAutoSend) {
		return {
			allowed: false,
			reason: outcome.reasons[0] ?? 'A handling rule holds this message for human review.',
		};
	}
	return { allowed: true };
}
