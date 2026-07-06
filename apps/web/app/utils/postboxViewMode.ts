/**
 * Postbox inbox list view mode — which of the three list renderers the inbox
 * uses. Exactly one mode is active at a time (the old pair of independent
 * category/conversation toggles let "categories" silently override
 * "conversations"):
 *
 *   - 'flat'          → PostboxThreadList (single message list; the default)
 *   - 'conversations' → PostboxThreadGroupList (thread-grouped rows)
 *   - 'categories'    → PostboxThreadCategoryList (People / Newsletters /
 *                       Notifications / Receipts sections)
 *
 * Inbox-only: every other folder always renders flat, so the mode is a stored
 * preference of the person, not a per-folder property. Pure derivations so
 * the mapping stays unit-testable without mounting the Convex-backed layout.
 */

export type PostboxViewMode = 'flat' | 'conversations' | 'categories';

export const POSTBOX_VIEW_MODE_DEFAULT: PostboxViewMode = 'flat';

/** Segments for the labeled view-mode control in the inbox list header. */
export const POSTBOX_VIEW_MODE_OPTIONS: Array<{
	value: PostboxViewMode;
	label: string;
}> = [
	{ value: 'flat', label: 'Flat' },
	{ value: 'conversations', label: 'Conversations' },
	{ value: 'categories', label: 'Categories' },
];

/** Normalise a stored/unknown value to a valid view mode, defaulting safely. */
export function resolvePostboxViewMode(value: string | undefined | null): PostboxViewMode {
	return value === 'conversations' || value === 'categories' ? value : POSTBOX_VIEW_MODE_DEFAULT;
}

/**
 * Which list renderer a folder shows for a given mode. Grouped renderers are
 * inbox-only (categories/conversations are classified on inbox mail); every
 * other folder keeps the flat list with its hover/keyboard triage.
 */
export function postboxListRenderer(mode: PostboxViewMode, folderRole: string): PostboxViewMode {
	return folderRole === 'inbox' ? mode : 'flat';
}
