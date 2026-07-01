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
			{ keys: ['⌘', 'Enter'], label: 'Send (in composer)' },
			{ keys: ['⌘', 'Shift', 'Enter'], label: 'Schedule send (in composer)' },
		],
	},
	{
		title: 'Help',
		shortcuts: [{ keys: ['?'], label: 'Show / hide this cheat sheet' }],
	},
];
