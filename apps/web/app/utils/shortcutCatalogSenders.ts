/**
 * The two sender chords of the Postbox, spread into
 * `SHORTCUT_CATALOG` right after the read/unread pair. Their own module only
 * because the catalog sits at its size cap.
 *
 *   - ⇧E sets the open message's sender to Auto-archive.
 *   - ⇧O ("opt out") unsubscribes from it, behind the Unsubscribe chip's
 *     confirm. Not ⇧U: that stays "mark unread" in every map, the shipped
 *     binding people already rely on.
 * Neither chord is bound by any scope the Postbox resolves or by any preset.
 */

import type { ShortcutDefinition } from './shortcutRegistry';

export const SENDER_SHORTCUTS: readonly ShortcutDefinition[] = [
	{
		id: 'postbox.senderAutoArchive',
		scope: 'postbox',
		keys: ['E'],
		labelKey: 'postbox.senders.shortcuts.autoArchive',
		groupKey: 'shared.shortcuts.groups.organize',
	},
	{
		id: 'postbox.senderUnsubscribe',
		scope: 'postbox',
		keys: ['O'],
		labelKey: 'postbox.senders.shortcuts.unsubscribe',
		groupKey: 'shared.shortcuts.groups.organize',
	},
];
