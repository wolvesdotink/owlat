import { describe, it, expect, beforeEach } from 'vitest';
import {
	resolvePostboxShortcut,
	isEditableTarget,
	nextUnreadIndex,
	postboxShortcutSheet,
} from '../postboxShortcuts';
import { shortcutSheetKeys } from '../shortcutRegistry';
import { applyShortcutPreferences, resetShortcutPreferences } from '../shortcutScope';

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

	it('maps Esc to closing the open conversation (the key the cheat sheet always listed)', () => {
		expect(resolvePostboxShortcut('Escape')).toBe('close');
	});

	it('returns null for unmapped keys', () => {
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
