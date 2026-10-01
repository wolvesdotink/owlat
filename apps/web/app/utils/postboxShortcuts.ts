/**
 * Single-key shortcut vocabulary shared by the Postbox thread list and reader
 * (Gmail/Superhuman-style triage).
 *
 * The mapping itself no longer lives here: it is the `postbox` scope of the one
 * app-wide registry (`utils/shortcutCatalog.ts`), so the same table feeds the
 * cheat sheet and honours the user's preset/remaps. This module is the seam the
 * Postbox components call — key in, action out — which is why the signature did
 * not change when the switch statement behind it did.
 *
 * Modifier chords (Cmd/Ctrl) are the caller's responsibility to filter out —
 * see `usePostboxListKeyboard` and the reader's window handler. Shift is
 * significant only through the produced key itself (`Shift+U` → `'U'`).
 */

import type { ShortcutScope } from './shortcutRegistry';
import { buildShortcutSheet } from './shortcutRegistry';
import { SHORTCUT_CATALOG } from './shortcutCatalog';
import { resolveActiveChord, shortcutBindings } from './shortcutScope';

export type PostboxShortcutAction =
	| 'archive'
	| 'trash'
	| 'star'
	| 'toggleRead'
	| 'markUnread'
	| 'reply'
	| 'replyAll'
	| 'forward'
	| 'snooze'
	| 'mute'
	| 'label'
	| 'move'
	| 'toggleSelect'
	| 'nextUnread'
	| 'previousUnread'
	| 'undo'
	| 'close'
	| 'help';

/**
 * Resolved against the `postbox` scope ALONE, deliberately without the global
 * fallthrough: this runs from a focused list row, where an unclaimed key must
 * stay inert rather than reach the app-wide map and, say, open a "new campaign"
 * dialog over the mailbox.
 */
const POSTBOX_SCOPES: readonly ShortcutScope[] = ['postbox'];

const ACTION_BY_ID: Readonly<Record<string, PostboxShortcutAction>> = {
	'postbox.archive': 'archive',
	'postbox.trash': 'trash',
	'postbox.star': 'star',
	'postbox.toggleRead': 'toggleRead',
	'postbox.markUnread': 'markUnread',
	'postbox.reply': 'reply',
	'postbox.replyAll': 'replyAll',
	'postbox.forward': 'forward',
	'postbox.snooze': 'snooze',
	'postbox.mute': 'mute',
	'postbox.label': 'label',
	'postbox.move': 'move',
	'postbox.toggleSelect': 'toggleSelect',
	'postbox.nextUnread': 'nextUnread',
	'postbox.previousUnread': 'previousUnread',
	'postbox.undo': 'undo',
	'postbox.close': 'close',
	'postbox.help': 'help',
};

export function resolvePostboxShortcut(key: string): PostboxShortcutAction | null {
	const id = resolveActiveChord(key, POSTBOX_SCOPES);
	return id ? (ACTION_BY_ID[id] ?? null) : null;
}

/**
 * The "?" cheat sheet, generated from the catalog rather than hand-listed
 * (the old copy had already drifted from the resolver it claimed to document).
 * `groupKey`/`labelKey` are i18n keys — the overlay is the render boundary that
 * runs them through `t()`.
 */
export function postboxShortcutSheet(isMac = false) {
	return buildShortcutSheet(SHORTCUT_CATALOG, shortcutBindings.value, {
		// The composer chords are listed too: they are the keys a person reaches
		// for straight after `r`, and the sheet is the only place they are taught.
		scopes: ['postbox', 'composer'],
		isMac,
	});
}

/**
 * Where `n` / `p` land: the nearest UNREAD row in `direction` from `from`.
 *
 * Deliberately does not wrap — Gmail's `n`/`p` stop at the ends, and a jump
 * that silently teleported to the top of the folder would be a very bad way to
 * lose your place mid-triage. `-1` means "nothing unread that way", which the
 * caller renders as "focus stays put".
 *
 * `from` may be `-1` (nothing focused yet), in which case a forward jump starts
 * at the top of the list and a backward one has nowhere to go.
 */
export function nextUnreadIndex(seen: readonly boolean[], from: number, direction: 1 | -1): number {
	if (direction === -1 && from <= 0) return -1;
	const start = from < 0 ? 0 : from + direction;
	for (let i = start; i >= 0 && i < seen.length; i += direction) {
		if (!seen[i]) return i;
	}
	return -1;
}

/**
 * True when a keyboard event originates from a text-entry surface (input,
 * textarea, select, or contenteditable) — single-key shortcuts must stay
 * inert there so typing "e" into a search box never archives mail.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el || typeof el.tagName !== 'string') return false;
	if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
	return el.isContentEditable === true;
}
