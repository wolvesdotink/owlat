/**
 * What a Postbox thread list says when it has no rows to show.
 *
 * "Empty" is four different situations wearing one layout, and saying the wrong
 * one is worse than saying nothing: a folder filtered down to zero that reads
 * "All clear" tells the reader their mail is gone. So the choice is made here,
 * as a pure derivation over the four inputs the list already has, and pinned by
 * unit tests instead of by mounting a Convex-backed list in each state.
 *
 * Labels are catalog KEYS — module scope cannot call `useI18n` — resolved by the
 * list at its own render boundary.
 */

export interface PostboxListEmptyState {
	readonly icon: string;
	readonly titleKey: string;
	readonly hintKey?: string;
	/** Offer the "set up a filter" link (empty custom folders only). */
	readonly showFilterAction: boolean;
}

const KEY = 'components.postbox.postboxThreadList';

export function postboxListEmptyState(args: {
	/** A triage chip (Unread/Starred/Attachments) is hiding rows that exist. */
	filterActive: boolean;
	/** A further page exists and there is a cursor to reach it. */
	hasMore: boolean;
	/** The label view renders with folder-role "inbox" but is not the inbox. */
	emptyContext?: 'label';
	folderRole: string;
}): PostboxListEmptyState {
	if (args.filterActive) {
		return {
			icon: 'lucide:check-circle-2',
			titleKey: `${KEY}.emptyFilteredTitle`,
			// The chips filter the LOADED pages, so "nothing matches" can mean "not
			// on these pages yet". Say so while a further page exists — the Load
			// more below the empty state is then a real next step rather than a
			// leftover control under a dead end.
			...(args.hasMore ? { hintKey: `${KEY}.emptyFilteredMoreHint` } : {}),
			showFilterAction: false,
		};
	}
	if (args.emptyContext === 'label') {
		return {
			icon: 'lucide:tag',
			titleKey: `${KEY}.emptyLabelTitle`,
			hintKey: `${KEY}.emptyLabelHint`,
			showFilterAction: false,
		};
	}
	if (args.folderRole === 'inbox') {
		return {
			icon: 'lucide:check-circle-2',
			titleKey: `${KEY}.emptyInboxTitle`,
			// Teach the two moves a new member reaches for first: compose and the
			// command palette. Quiet enough to stay welcome once the inbox fills.
			hintKey: `${KEY}.emptyInboxHint`,
			showFilterAction: false,
		};
	}
	if (args.folderRole === '') {
		return {
			icon: 'lucide:folder-open',
			titleKey: `${KEY}.emptyFolderTitle`,
			hintKey: `${KEY}.emptyFolderHint`,
			showFilterAction: true,
		};
	}
	return { icon: 'lucide:inbox', titleKey: `${KEY}.emptyDefaultTitle`, showFilterAction: false };
}
