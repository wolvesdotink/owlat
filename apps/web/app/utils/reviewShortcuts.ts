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
 * Data source for the inline keyboard hint on the Review Queue page. `label`
 * is an i18n key — this module is pure, so the page runs it through `t()`.
 */
export const REVIEW_SHORTCUT_GROUPS: ReadonlyArray<{ keys: readonly string[]; label: string }> = [
	{ keys: ['j', '↓'], label: 'shared.reviewShortcuts.labels.next' },
	{ keys: ['k', '↑'], label: 'shared.reviewShortcuts.labels.previous' },
	{ keys: ['Enter'], label: 'shared.reviewShortcuts.labels.openThread' },
	{ keys: ['1–9'], label: 'shared.reviewShortcuts.labels.pickOption' },
	{ keys: ['a'], label: 'shared.reviewShortcuts.labels.approveAndSend' },
	{ keys: ['e'], label: 'shared.reviewShortcuts.labels.edit' },
	{ keys: ['s'], label: 'shared.reviewShortcuts.labels.skip' },
	{ keys: ['x', '#'], label: 'shared.reviewShortcuts.labels.reject' },
];
