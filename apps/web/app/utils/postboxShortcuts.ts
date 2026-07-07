/**
 * Single-key shortcut vocabulary shared by the Postbox thread list and reader
 * (Gmail/Superhuman-style triage). Pure key→action resolution so the mapping
 * is unit-testable without mounting the Convex-backed components.
 *
 * Modifier chords (Cmd/Ctrl) are the caller's responsibility to filter out —
 * see `usePostboxListKeyboard` and the reader's window handler. Shift is
 * significant only through the produced key itself (`Shift+U` → `'U'`).
 */

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
	| 'label'
	| 'move'
	| 'toggleSelect'
	| 'help';

export function resolvePostboxShortcut(key: string): PostboxShortcutAction | null {
	switch (key) {
		case 'e':
			return 'archive';
		case '#':
		case 'Delete':
		case 'Backspace':
			return 'trash';
		case 's':
			return 'star';
		case 'u':
			return 'toggleRead';
		case 'U': // Shift+U
			return 'markUnread';
		case 'r':
			return 'reply';
		case 'a':
			return 'replyAll';
		case 'f':
			return 'forward';
		case 'h':
			return 'snooze';
		case 'l':
			return 'label';
		case 'v':
			return 'move';
		case 'x':
			return 'toggleSelect';
		case '?':
			return 'help';
		default:
			return null;
	}
}

/**
 * True when a keyboard event is the "focus compose" chord (Cmd/Ctrl+Shift+F):
 * promote the active popup composer to the centered distraction-free surface.
 * Pure so the chord contract is unit-testable without a window handler.
 */
export function isFocusComposeChord(event: {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}): boolean {
	return (
		(event.metaKey || event.ctrlKey) &&
		event.shiftKey &&
		!event.altKey &&
		(event.key === 'f' || event.key === 'F')
	);
}

export type PostboxComposeMode = 'reply' | 'replyAll' | 'forward';

/**
 * Compose intent handed from the thread list's r/a/f shortcuts to the reader
 * (which owns the quoting/recipient logic). Stored under
 * `POSTBOX_PENDING_COMPOSE_KEY` in `useState` by both sides so the contract
 * can't drift.
 */
export type PostboxPendingCompose = { messageId: string; mode: PostboxComposeMode };

export const POSTBOX_PENDING_COMPOSE_KEY = 'postbox:pending-compose';

/**
 * Decide what the reader does with a pending compose intent. Pure so the
 * list→reader handoff is unit-testable.
 *
 * - Intent matches the displayed message → open that composer and clear it
 *   (this also covers r/a/f on a row whose message is ALREADY open: the
 *   reader re-evaluates when the intent itself changes, not only on id
 *   change).
 * - Intent for another message while the displayed id did NOT change → keep
 *   it armed (the list just set it and navigation is still in flight).
 * - Displayed id CHANGED to a non-matching message → the intent is stale
 *   (the user opened something else); clear it so it can't pop a composer on
 *   an unrelated open later.
 */
export function settlePendingCompose(
	pending: PostboxPendingCompose | null,
	messageId: string,
	previousMessageId: string | undefined
): { open: PostboxComposeMode | null; clear: boolean } {
	if (!pending) return { open: null, clear: false };
	if (pending.messageId === messageId) return { open: pending.mode, clear: true };
	return { open: null, clear: messageId !== previousMessageId };
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

/** Data source for the "?" cheat-sheet overlay (PostboxShortcutHelp). */
export const POSTBOX_SHORTCUT_GROUPS: ReadonlyArray<{
	title: string;
	shortcuts: ReadonlyArray<{ keys: readonly string[]; label: string }>;
}> = [
	{
		title: 'Navigation',
		shortcuts: [
			{ keys: ['j', '↓'], label: 'Next message' },
			{ keys: ['k', '↑'], label: 'Previous message' },
			{ keys: ['Enter'], label: 'Open message' },
			{ keys: ['/'], label: 'Focus search' },
			{ keys: ['b'], label: 'Toggle Today / Browse (inbox)' },
			{ keys: ['Esc'], label: 'Close the open conversation / back to Today' },
		],
	},
	{
		title: 'Triage',
		shortcuts: [
			{ keys: ['e'], label: 'Archive' },
			{ keys: ['#', 'Del'], label: 'Move to trash' },
			{ keys: ['s'], label: 'Star / unstar' },
			{ keys: ['u'], label: 'Toggle read' },
			{ keys: ['Shift', 'U'], label: 'Mark unread' },
			{ keys: ['x'], label: 'Select / deselect' },
		],
	},
	{
		title: 'Organize',
		shortcuts: [
			{ keys: ['h'], label: 'Snooze' },
			{ keys: ['l'], label: 'Add label' },
			{ keys: ['v'], label: 'Move to folder' },
		],
	},
	{
		title: 'Compose',
		shortcuts: [
			{ keys: ['r'], label: 'Reply' },
			{ keys: ['a'], label: 'Reply all' },
			{ keys: ['f'], label: 'Forward' },
			{ keys: ['⌘', 'Shift', 'F'], label: 'Focus the composer' },
			{ keys: ['⌘', 'Enter'], label: 'Send (in composer)' },
			{ keys: ['⌘', 'Shift', 'Enter'], label: 'Schedule send (in composer)' },
		],
	},
	{
		title: 'Help',
		shortcuts: [{ keys: ['?'], label: 'Show / hide this cheat sheet' }],
	},
];
