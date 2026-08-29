/**
 * Single-key shortcut vocabulary for the agent Review Queue (the approval gate
 * for AI-drafted replies). Deliberately a SEPARATE, smaller vocabulary from the
 * Postbox triage keys (utils/postboxShortcuts.ts): the review gate is about
 * approve / edit / reject, not archive / star / label.
 *
 * The vocabulary itself is the `review` scope of the one app-wide registry
 * (utils/shortcutCatalog.ts) — separate from the Postbox one by SCOPE rather
 * than by being a second hand-written switch, which is what lets both surfaces
 * spend `e` and `s` on different verbs and still generate honest cheat sheets.
 * This module is the seam the queue calls: key in, action out.
 *
 * Modifier chords (Cmd/Ctrl/Alt) are filtered out by the caller
 * (usePostboxListKeyboard, which useReviewQueueKeyboard reuses).
 */

import type { ShortcutScope } from './shortcutRegistry';
import { buildShortcutSheet } from './shortcutRegistry';
import { SHORTCUT_CATALOG } from './shortcutCatalog';
import { resolveActiveChord, shortcutBindings } from './shortcutScope';

export type ReviewShortcutAction = 'approve' | 'edit' | 'reject' | 'skip';

/** Same reasoning as the Postbox seam: this scope only, no global fallthrough. */
const REVIEW_SCOPES: readonly ShortcutScope[] = ['review'];

const ACTION_BY_ID: Readonly<Record<string, ReviewShortcutAction>> = {
	'review.approve': 'approve',
	'review.edit': 'edit',
	'review.reject': 'reject',
	'review.skip': 'skip',
};

export function resolveReviewShortcut(key: string): ReviewShortcutAction | null {
	const id = resolveActiveChord(key, REVIEW_SCOPES);
	const action = id ? ACTION_BY_ID[id] : undefined;
	if (action) return action;
	// `x` belongs to the multi-select layer in the registry (the Postbox
	// `x = select` idiom, and what the cheat sheet promises), so it never
	// resolves to an action here. On a surface with NO selection model the
	// caller reaches this resolver first and `x` still means reject — `#`
	// remains the reject key that works everywhere.
	return key === 'x' ? 'reject' : null;
}

/**
 * Multi-select vocabulary for the browse list (piece C2): Space / `x` toggle
 * the focused card, Shift+J / Shift+K extend the selection while moving, `*`
 * selects everything visible (Gmail's select-all chord, first half). Resolved
 * BEFORE the single-card vocabulary above so `x` means "select" wherever a
 * selection model is active — matching the Postbox thread list.
 */
export type ReviewSelectShortcutAction =
	| 'toggleSelect'
	| 'extendSelectDown'
	| 'extendSelectUp'
	| 'selectAllVisible';

const SELECT_ACTION_BY_ID: Readonly<Record<string, ReviewSelectShortcutAction>> = {
	'review.toggleSelect': 'toggleSelect',
	'review.selectAll': 'selectAllVisible',
};

export function resolveReviewSelectShortcut(key: string): ReviewSelectShortcutAction | null {
	// Shift+J / Shift+K are a MOVE plus a selection drag, so the list keyboard
	// owns them (`postbox.extendSelection` / `review.extendSelection` are
	// documented, non-remappable catalog entries); this resolver only reports
	// which end they extend.
	if (key === 'J') return 'extendSelectDown';
	if (key === 'K') return 'extendSelectUp';
	const id = resolveActiveChord(key, REVIEW_SCOPES);
	return id ? (SELECT_ACTION_BY_ID[id] ?? null) : null;
}

/**
 * The inline keyboard hint on the Review Queue page, generated from the one
 * catalog. `groupKey`/`labelKey` are i18n keys — the page is the render
 * boundary that runs them through `t()`.
 *
 * `x` is listed under Select rather than Reject: with a selection model active
 * the multi-select layer claims it first (see `resolveReviewSelectShortcut`),
 * so `#` is the reject key the hint can promise on every surface.
 */
export function reviewShortcutSheet(isMac = false) {
	return buildShortcutSheet(SHORTCUT_CATALOG, shortcutBindings.value, {
		scopes: REVIEW_SCOPES,
		isMac,
	});
}

/** Flat legend rows, in catalog order — what the page's one-line hint renders. */
export function reviewShortcutLegend(isMac = false): { keys: string[]; label: string }[] {
	return reviewShortcutSheet(isMac).flatMap((group) =>
		group.items.map((item) => ({ keys: item.keys, label: item.labelKey }))
	);
}
