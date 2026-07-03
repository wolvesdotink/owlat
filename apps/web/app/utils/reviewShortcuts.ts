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

export type ReviewShortcutAction = 'approve' | 'edit' | 'reject';

export function resolveReviewShortcut(key: string): ReviewShortcutAction | null {
	switch (key) {
		case 'a':
			return 'approve';
		case 'e':
			return 'edit';
		case 'x':
		case '#':
			return 'reject';
		default:
			return null;
	}
}

/** Data source for the inline keyboard hint on the Review Queue page. */
export const REVIEW_SHORTCUT_GROUPS: ReadonlyArray<{ keys: readonly string[]; label: string }> = [
	{ keys: ['j', '↓'], label: 'Next' },
	{ keys: ['k', '↑'], label: 'Previous' },
	{ keys: ['Enter'], label: 'Open thread' },
	{ keys: ['a'], label: 'Approve & send' },
	{ keys: ['e'], label: 'Edit' },
	{ keys: ['x', '#'], label: 'Reject' },
];
