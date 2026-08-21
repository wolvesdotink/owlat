/**
 * Single-key shortcut vocabulary for the agent Review Queue (the approval gate
 * for AI-drafted replies). Deliberately a SEPARATE, smaller vocabulary from the
 * Postbox triage keys (utils/postboxShortcuts.ts): the review gate is about
 * approve / edit / reject, not archive / star / label.
 *
 * Pure key→action resolution so the mapping is unit-testable without mounting
 * the Convex-backed page. Modifier chords (Cmd/Ctrl/Alt) are filtered out by
 * the caller (usePostboxListKeyboard, which useReviewQueueKeyboard reuses).
 */

export type ReviewShortcutAction = 'approve' | 'edit' | 'reject' | 'skip';

export function resolveReviewShortcut(key: string): ReviewShortcutAction | null {
	switch (key) {
		case 'a':
			return 'approve';
		case 'e':
			return 'edit';
		// NOTE: on the browse list `x` is claimed FIRST by the multi-select layer
		// (resolveReviewSelectShortcut below — the Postbox `x = select` idiom), so
		// this reject mapping only fires on surfaces without selection (and `#`
		// stays the universal reject key).
		case 'x':
		case '#':
			return 'reject';
		case 's':
			// Skip is NON-destructive: move on to the next card without acting.
			return 'skip';
		default:
			return null;
	}
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

export function resolveReviewSelectShortcut(key: string): ReviewSelectShortcutAction | null {
	switch (key) {
		case ' ':
		case 'x':
			return 'toggleSelect';
		case 'J': // Shift+j
			return 'extendSelectDown';
		case 'K': // Shift+k
			return 'extendSelectUp';
		case '*':
			return 'selectAllVisible';
		default:
			return null;
	}
}

/**
 * Data source for the inline keyboard hint on the Review Queue page. `label`
 * is an i18n key — this module is pure, so the page runs it through `t()`.
 *
 * `x` is listed under Select rather than Reject: with a selection model active
 * the multi-select layer claims it first (see `resolveReviewSelectShortcut`),
 * so `#` is the reject key the hint can promise on every surface.
 */
export const REVIEW_SHORTCUT_GROUPS: ReadonlyArray<{ keys: readonly string[]; label: string }> = [
	{ keys: ['j', '↓'], label: 'shared.reviewShortcuts.labels.next' },
	{ keys: ['k', '↑'], label: 'shared.reviewShortcuts.labels.previous' },
	{ keys: ['Enter'], label: 'shared.reviewShortcuts.labels.openThread' },
	{ keys: ['1–9'], label: 'shared.reviewShortcuts.labels.pickOption' },
	{ keys: ['a'], label: 'shared.reviewShortcuts.labels.approveAndSend' },
	{ keys: ['e'], label: 'shared.reviewShortcuts.labels.edit' },
	{ keys: ['s'], label: 'shared.reviewShortcuts.labels.skip' },
	{ keys: ['#'], label: 'shared.reviewShortcuts.labels.reject' },
	{ keys: ['Space', 'x'], label: 'shared.reviewShortcuts.labels.select' },
	{ keys: ['Shift', 'j/k'], label: 'shared.reviewShortcuts.labels.extendSelection' },
	{ keys: ['*'], label: 'shared.reviewShortcuts.labels.selectAll' },
];
