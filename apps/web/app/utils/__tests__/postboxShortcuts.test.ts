import { describe, it, expect } from 'vitest';
import {
	resolvePostboxShortcut,
	isEditableTarget,
	POSTBOX_SHORTCUT_GROUPS,
} from '../postboxShortcuts';

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
