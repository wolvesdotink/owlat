/**
 * Autonomy-rule resolution helpers.
 *
 * `autonomyRules` now carries a per-sender dimension (see schema/inbox.ts): a
 * rule with an absent `sender` is the CATEGORY rule; a rule with a `sender` set
 * is a PER-SENDER / per-contact rule that takes precedence. Because both share
 * the `by_category` index, a bare `.first()` on that index can no longer be
 * trusted to return the category rule — it might hand back a sender rule. These
 * helpers make the two lookups explicit and are the single source of truth for
 * "which rule governs this (category, sender)", shared by the route-step
 * decision (`autonomy.checkPermissionInternal`), the atomic daily-cap charge
 * (`autonomy.incrementDailyCount`), and the suggestion/threshold flows.
 */

import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

/**
 * Default number of MATCHED shadow observations a (category, sender) slice must
 * accumulate before it is allowed to auto-send. A per-sender rule may override
 * this via `warmupRequired`. This is the "first-N-observed" warm-up: autonomy
 * never auto-sends a sender it has not yet watched succeed in shadow N times.
 */
export const WARMUP_MATCHES_DEFAULT = 3;

/**
 * The category rule for a category — the row with NO `sender`. Bounded: a
 * category has at most one category rule plus a handful of per-sender rules, so
 * the small collect + loop stays tiny. Returns null when only sender rules (or
 * nothing) exist for the category.
 */
export async function getCategoryRule(
	db: DatabaseReader,
	category: string,
): Promise<Doc<'autonomyRules'> | null> {
	const rows = await db
		.query('autonomyRules')
		.withIndex('by_category', (q) => q.eq('category', category))
		.collect();
	for (const row of rows) {
		if (row.sender == null) return row;
	}
	return null;
}

/**
 * The per-sender rule for an exact (sender, category) pair, or null when the
 * sender has no rule of its own in that category.
 */
export async function getSenderRule(
	db: DatabaseReader,
	category: string,
	sender: string,
): Promise<Doc<'autonomyRules'> | null> {
	return db
		.query('autonomyRules')
		.withIndex('by_sender_category', (q) => q.eq('sender', sender).eq('category', category))
		.first();
}

/**
 * The effective rule governing a (category, sender), resolved sender-first:
 *
 *   - `{ kind: 'rule', scope: 'sender' }`   — an enabled per-sender rule governs.
 *   - `{ kind: 'blocked' }`                 — a DISABLED per-sender rule: an
 *                                             explicit "never auto-send this
 *                                             sender" opt-out that overrides the
 *                                             category rule.
 *   - `{ kind: 'rule', scope: 'category' }` — no per-sender rule; an enabled
 *                                             category rule governs.
 *   - `{ kind: 'none' }`                    — no enabled rule at all → never auto
 *                                             (the safe default).
 *
 * `sender` is null when the caller could not resolve a sender (legacy callers
 * that pass only a category); in that case only the category rule is considered.
 */
export type EffectiveRule =
	| { kind: 'rule'; rule: Doc<'autonomyRules'>; scope: 'sender' | 'category' }
	| { kind: 'blocked'; reason: string }
	| { kind: 'none' };

export async function resolveEffectiveRule(
	db: DatabaseReader,
	category: string,
	sender: string | null,
): Promise<EffectiveRule> {
	if (sender) {
		const senderRule = await getSenderRule(db, category, sender);
		if (senderRule) {
			if (!senderRule.isEnabled) {
				return { kind: 'blocked', reason: `Auto-send is turned off for ${sender}` };
			}
			return { kind: 'rule', rule: senderRule, scope: 'sender' };
		}
	}

	const categoryRule = await getCategoryRule(db, category);
	if (categoryRule && categoryRule.isEnabled) {
		return { kind: 'rule', rule: categoryRule, scope: 'category' };
	}
	return { kind: 'none' };
}

/**
 * The running shadow scorecard slice for a (category, sender), or null when the
 * sender has never been observed in shadow. `matched` on that row is the count
 * of would-have-sent observations the human then approved unedited — the signal
 * the warm-up gate counts.
 */
export async function getScorecardSlice(
	db: DatabaseReader,
	category: string,
	sender: string,
): Promise<Doc<'agentShadowScorecard'> | null> {
	return db
		.query('agentShadowScorecard')
		.withIndex('by_category_sender', (q) => q.eq('category', category).eq('sender', sender))
		.first();
}
