import { describe, it, expect, beforeEach } from 'vitest';
import {
	resolvePostboxShortcut,
	isEditableTarget,
	isFocusComposeChord,
	nextUnreadIndex,
	postboxShortcutSheet,
	settlePendingCompose,
} from '../postboxShortcuts';
import { shortcutSheetKeys } from '../shortcutRegistry';
import { applyShortcutPreferences, resetShortcutPreferences } from '../shortcutScope';

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
	beforeEach(() => resetShortcutPreferences());

	it('maps the triage keys to their actions', () => {
		expect(resolvePostboxShortcut('e')).toBe('archive');
		expect(resolvePostboxShortcut('#')).toBe('trash');
		expect(resolvePostboxShortcut('Delete')).toBe('trash');
		expect(resolvePostboxShortcut('Backspace')).toBe('trash');
		expect(resolvePostboxShortcut('s')).toBe('star');
		expect(resolvePostboxShortcut('u')).toBe('toggleRead');
	});

	it('maps the extended vocabulary (r/a/f/h/m/l/v/x/Shift+U/?)', () => {
		expect(resolvePostboxShortcut('r')).toBe('reply');
		expect(resolvePostboxShortcut('a')).toBe('replyAll');
		expect(resolvePostboxShortcut('f')).toBe('forward');
		expect(resolvePostboxShortcut('h')).toBe('snooze');
		expect(resolvePostboxShortcut('m')).toBe('mute');
		expect(resolvePostboxShortcut('l')).toBe('label');
		expect(resolvePostboxShortcut('v')).toBe('move');
		expect(resolvePostboxShortcut('x')).toBe('toggleSelect');
		// Shift+U produces the key 'U' — distinct from the plain 'u' toggle.
		expect(resolvePostboxShortcut('U')).toBe('markUnread');
		expect(resolvePostboxShortcut('?')).toBe('help');
	});

	it('maps the vocabulary added with the registry (n/p unread jumps, z undo)', () => {
		expect(resolvePostboxShortcut('n')).toBe('nextUnread');
		expect(resolvePostboxShortcut('p')).toBe('previousUnread');
		expect(resolvePostboxShortcut('z')).toBe('undo');
	});

	it('follows the user`s preset — the resolver is a seam, not a table', () => {
		applyShortcutPreferences('gmail');
		// Gmail snoozes with `b`, so `h` goes back to meaning nothing.
		expect(resolvePostboxShortcut('b')).toBe('snooze');
		expect(resolvePostboxShortcut('h')).toBeNull();
		applyShortcutPreferences('owlat', [{ id: 'postbox.archive', keys: ['y'] }]);
		expect(resolvePostboxShortcut('y')).toBe('archive');
		expect(resolvePostboxShortcut('e')).toBeNull();
	});

	it('resolves against the postbox scope only, never the app-wide map', () => {
		// `g d` is "go to Dashboard" globally; a focused list row must not reach it.
		expect(resolvePostboxShortcut('g')).toBeNull();
	});

	it('returns null for unmapped keys', () => {
		expect(resolvePostboxShortcut('Escape')).toBeNull();
		expect(resolvePostboxShortcut('Tab')).toBeNull();
		// Capitalized variants of mapped keys are NOT mapped (Shift changes meaning).
		expect(resolvePostboxShortcut('R')).toBeNull();
		expect(resolvePostboxShortcut('E')).toBeNull();
		expect(resolvePostboxShortcut('M')).toBeNull();
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

describe('nextUnreadIndex (the n / p jumps)', () => {
	//            0      1      2      3
	const seen = [true, false, true, false];

	it('finds the nearest unread row in each direction', () => {
		expect(nextUnreadIndex(seen, 0, 1)).toBe(1);
		expect(nextUnreadIndex(seen, 1, 1)).toBe(3);
		expect(nextUnreadIndex(seen, 3, -1)).toBe(1);
	});

	it('starts at the top when nothing is focused yet', () => {
		expect(nextUnreadIndex(seen, -1, 1)).toBe(1);
		expect(nextUnreadIndex(seen, -1, -1)).toBe(-1);
	});

	it('does NOT wrap — a jump that teleported would lose your place', () => {
		expect(nextUnreadIndex(seen, 3, 1)).toBe(-1);
		expect(nextUnreadIndex(seen, 1, -1)).toBe(-1);
		expect(nextUnreadIndex([true, true], -1, 1)).toBe(-1);
	});
});

describe('the generated cheat sheet', () => {
	beforeEach(() => resetShortcutPreferences());

	it('documents every action in the resolver vocabulary', () => {
		const documentedKeys = new Set(
			postboxShortcutSheet().flatMap((g) => g.items.flatMap((i) => shortcutSheetKeys(i)))
		);
		// Every single-key triage shortcut shows up in the cheat sheet.
		for (const key of [
			'j',
			'k',
			'e',
			'#',
			's',
			'u',
			'x',
			'r',
			'a',
			'f',
			'h',
			'm',
			'l',
			'v',
			'?',
			'/',
			'n',
			'p',
			'z',
		]) {
			expect(documentedKeys.has(key), `cheat sheet missing "${key}"`).toBe(true);
		}
	});

	it('follows a preset, so it cannot promise a key the resolver dropped', () => {
		applyShortcutPreferences('gmail');
		const keys = new Set(
			postboxShortcutSheet().flatMap((g) => g.items.flatMap((i) => shortcutSheetKeys(i)))
		);
		expect(keys.has('b')).toBe(true);
		expect(keys.has('h')).toBe(false);
	});

	it('teaches the composer chords alongside the triage keys', () => {
		const ids = postboxShortcutSheet(true).flatMap((g) => g.items.map((i) => i.id));
		expect(ids).toContain('composer.send');
		expect(ids).toContain('postbox.archive');
	});
});
