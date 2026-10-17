/**
 * The two sender chords of the Postbox (SPEC §5), spread into
 * `SHORTCUT_CATALOG` right after the read/unread pair. Their own module only
 * because the catalog sits at its size cap.
 *
 *   - ⇧E sets the open message's sender to Auto-archive.
 *   - ⇧U unsubscribes from it, behind the Unsubscribe chip's confirm. ⇧U used
 *     to be "mark unread", which plain `u` already toggles; the Gmail and
 *     Outlook presets keep it there and leave this one unbound.
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
		keys: ['U'],
		labelKey: 'postbox.senders.shortcuts.unsubscribe',
		groupKey: 'shared.shortcuts.groups.organize',
	},
];
