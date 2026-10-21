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
 *
 * A hint that teaches a key comes in variants, one per set of keys it can name.
 * The list passes which shortcuts fire right now (preset, remaps and the scope
 * on screen decide that), and the first variant whose keys all fire wins, so a
 * hint never tells someone to press a key that does nothing and never prints a
 * blank where a key should be.
 */

export interface PostboxListEmptyState {
	readonly icon: string;
	readonly titleKey: string;
	readonly hintKey?: string;
	/**
	 * The hint's message parameters that name a key, as shortcut catalog ids,
	 * so the list prints each key as this person has it bound, for this machine.
	 */
	readonly hintShortcuts?: Readonly<Record<string, string>>;
	/** Offer the "set up a filter" link (empty custom folders only). */
	readonly showFilterAction: boolean;
}

const KEY = 'components.postbox.postboxThreadList';

interface HintVariant {
	readonly key: string;
	/** Message parameter -> shortcut catalog id. */
	readonly shortcuts?: Readonly<Record<string, string>>;
}

/** The first variant whose keys all fire; no hint when none qualifies. */
function pickHint(
	variants: readonly HintVariant[],
	isShortcutLive: (id: string) => boolean
): Pick<PostboxListEmptyState, 'hintKey' | 'hintShortcuts'> {
	const variant = variants.find((v) => Object.values(v.shortcuts ?? {}).every(isShortcutLive));
	if (!variant) return {};
	return variant.shortcuts
		? { hintKey: variant.key, hintShortcuts: variant.shortcuts }
		: { hintKey: variant.key };
}

export function postboxListEmptyState(args: {
	/** A triage chip (Unread/Starred/Attachments) is hiding rows that exist. */
	filterActive: boolean;
	/** A further page exists and there is a cursor to reach it. */
	hasMore: boolean;
	/** The label view renders with folder-role "inbox" but is not the inbox. */
	emptyContext?: 'label';
	folderRole: string;
	/** Whether a shortcut catalog id fires right now. */
	isShortcutLive: (id: string) => boolean;
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
			...pickHint(
				[
					{ key: `${KEY}.emptyLabelHint`, shortcuts: { keys: 'postbox.label' } },
					{ key: `${KEY}.emptyLabelNoKeyHint` },
				],
				args.isShortcutLive
			),
			showFilterAction: false,
		};
	}
	if (args.folderRole === 'inbox') {
		return {
			icon: 'lucide:check-circle-2',
			titleKey: `${KEY}.emptyInboxTitle`,
			// Teach the two moves a new member reaches for first: compose and the
			// command palette. Quiet enough to stay welcome once the inbox fills.
			// Both moves are keys, so without either key there is nothing to teach.
			...pickHint(
				[
					{
						key: `${KEY}.emptyInboxHint`,
						shortcuts: { compose: 'global.compose', palette: 'global.commandPalette' },
					},
					{ key: `${KEY}.emptyInboxComposeHint`, shortcuts: { compose: 'global.compose' } },
					{
						key: `${KEY}.emptyInboxPaletteHint`,
						shortcuts: { palette: 'global.commandPalette' },
					},
				],
				args.isShortcutLive
			),
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
