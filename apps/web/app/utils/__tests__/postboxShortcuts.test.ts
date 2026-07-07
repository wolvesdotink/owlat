import { describe, it, expect } from 'vitest';
import {
	resolvePostboxShortcut,
	isEditableTarget,
	isFocusComposeChord,
	settlePendingCompose,
	POSTBOX_SHORTCUT_GROUPS,
} from '../postboxShortcuts';

describe('isFocusComposeChord', () => {
	const chord = (over: Record<string, unknown>) => ({
		key: 'f',
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...over,
	});

	it('matches Cmd/Ctrl + Shift + F (either case)', () => {
		expect(isFocusComposeChord(chord({ metaKey: true, shiftKey: true }))).toBe(true);
		expect(isFocusComposeChord(chord({ ctrlKey: true, shiftKey: true }))).toBe(true);
		expect(isFocusComposeChord(chord({ metaKey: true, shiftKey: true, key: 'F' }))).toBe(true);
	});

	it('rejects the chord without Shift, without a modifier, with Alt, or a different key', () => {
		expect(isFocusComposeChord(chord({ metaKey: true }))).toBe(false);
		expect(isFocusComposeChord(chord({ shiftKey: true }))).toBe(false);
		expect(isFocusComposeChord(chord({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
		expect(isFocusComposeChord(chord({ metaKey: true, shiftKey: true, key: 'g' }))).toBe(false);
	});
});

describe('resolvePostboxShortcut', () => {
	it('maps the triage keys to their actions', () => {
		expect(resolvePostboxShortcut('e')).toBe('archive');
		expect(resolvePostboxShortcut('#')).toBe('trash');
		expect(resolvePostboxShortcut('Delete')).toBe('trash');
		expect(resolvePostboxShortcut('Backspace')).toBe('trash');
		expect(resolvePostboxShortcut('s')).toBe('star');
		expect(resolvePostboxShortcut('u')).toBe('toggleRead');
	});

	it('maps the extended vocabulary (r/a/f/h/l/v/x/Shift+U/?)', () => {
		expect(resolvePostboxShortcut('r')).toBe('reply');
		expect(resolvePostboxShortcut('a')).toBe('replyAll');
		expect(resolvePostboxShortcut('f')).toBe('forward');
		expect(resolvePostboxShortcut('h')).toBe('snooze');
		expect(resolvePostboxShortcut('l')).toBe('label');
		expect(resolvePostboxShortcut('v')).toBe('move');
		expect(resolvePostboxShortcut('x')).toBe('toggleSelect');
		// Shift+U produces the key 'U' — distinct from the plain 'u' toggle.
		expect(resolvePostboxShortcut('U')).toBe('markUnread');
		expect(resolvePostboxShortcut('?')).toBe('help');
	});

	it('returns null for unmapped keys', () => {
		expect(resolvePostboxShortcut('z')).toBeNull();
		expect(resolvePostboxShortcut('Escape')).toBeNull();
		expect(resolvePostboxShortcut('Tab')).toBeNull();
		// Capitalized variants of mapped keys are NOT mapped (Shift changes meaning).
		expect(resolvePostboxShortcut('R')).toBeNull();
		expect(resolvePostboxShortcut('E')).toBeNull();
	});
});

describe('isEditableTarget', () => {
	it('is true for input, textarea, and select elements', () => {
		expect(isEditableTarget(document.createElement('input'))).toBe(true);
		expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
		expect(isEditableTarget(document.createElement('select'))).toBe(true);
	});

	it('is true for contenteditable elements', () => {
		const div = document.createElement('div');
		div.contentEditable = 'true';
		document.body.appendChild(div);
		expect(isEditableTarget(div)).toBe(true);
		div.remove();
	});

	it('is false for plain elements and null', () => {
		expect(isEditableTarget(document.createElement('div'))).toBe(false);
		expect(isEditableTarget(document.createElement('button'))).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
	});
});

describe('settlePendingCompose (list → reader r/a/f handoff)', () => {
	it('is a no-op without a pending intent', () => {
		expect(settlePendingCompose(null, 'msg-a', 'msg-a')).toEqual({ open: null, clear: false });
	});

	it('consumes a matching intent exactly once (opens + clears)', () => {
		const pending = { messageId: 'msg-a', mode: 'reply' as const };
		expect(settlePendingCompose(pending, 'msg-a', 'msg-b')).toEqual({
			open: 'reply',
			clear: true,
		});
	});

	it('consumes when the target message is ALREADY open (id did not change)', () => {
		// r/a/f on the focused row of the currently-open message: the reader
		// re-settles when the intent itself changes, with an unchanged id.
		const pending = { messageId: 'msg-a', mode: 'forward' as const };
		expect(settlePendingCompose(pending, 'msg-a', 'msg-a')).toEqual({
			open: 'forward',
			clear: true,
		});
	});

	it('keeps an in-flight intent for another message while the id is unchanged', () => {
		// The list just armed the intent for msg-b; navigation has not landed yet.
		const pending = { messageId: 'msg-b', mode: 'replyAll' as const };
		expect(settlePendingCompose(pending, 'msg-a', 'msg-a')).toEqual({
			open: null,
			clear: false,
		});
	});

	it('drops a stale intent when a DIFFERENT message is opened', () => {
		// Intent was armed for msg-b, but the user opened msg-c (even by plain
		// click, much later): never open a composer, and clear the intent so it
		// cannot fire on a future open of msg-b.
		const pending = { messageId: 'msg-b', mode: 'reply' as const };
		expect(settlePendingCompose(pending, 'msg-c', 'msg-a')).toEqual({
			open: null,
			clear: true,
		});
	});

	it('drops a stale intent on first mount (no previous id)', () => {
		const pending = { messageId: 'msg-b', mode: 'reply' as const };
		expect(settlePendingCompose(pending, 'msg-a', undefined)).toEqual({
			open: null,
			clear: true,
		});
	});
});

describe('POSTBOX_SHORTCUT_GROUPS', () => {
	it('documents every action in the resolver vocabulary', () => {
		const documentedKeys = new Set(
			POSTBOX_SHORTCUT_GROUPS.flatMap((g) => g.shortcuts.flatMap((s) => [...s.keys]))
		);
		// Every single-key triage shortcut shows up in the cheat sheet.
		for (const key of ['j', 'k', 'e', '#', 's', 'u', 'x', 'r', 'a', 'f', 'h', 'l', 'v', '?', '/']) {
			expect(documentedKeys.has(key), `cheat sheet missing "${key}"`).toBe(true);
		}
	});
});
