import { describe, it, expect } from 'vitest';

import { resolveComposerKeyAction } from '../postboxComposerKeys';

function key(
	overrides: Partial<Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>>
) {
	return {
		key: '',
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...overrides,
	};
}

const READY = { canSend: true, overlayOpen: false };

describe('resolveComposerKeyAction', () => {
	describe('Cmd/Ctrl+Enter → send', () => {
		it('sends with Cmd+Enter when the draft is sendable', () => {
			expect(resolveComposerKeyAction(key({ key: 'Enter', metaKey: true }), READY)).toBe('send');
		});

		it('sends with Ctrl+Enter (non-mac)', () => {
			expect(resolveComposerKeyAction(key({ key: 'Enter', ctrlKey: true }), READY)).toBe('send');
		});

		it('does NOT send when the draft is not sendable (no recipients / sending / scheduled)', () => {
			expect(
				resolveComposerKeyAction(key({ key: 'Enter', metaKey: true }), {
					canSend: false,
					overlayOpen: false,
				})
			).toBeNull();
		});

		it('ignores plain Enter without the modifier', () => {
			expect(resolveComposerKeyAction(key({ key: 'Enter' }), READY)).toBeNull();
		});
	});

	describe('Cmd/Ctrl+Alt+Enter → send with the opposite after-reply action', () => {
		it('sends the other way with Cmd+Alt+Enter and Ctrl+Alt+Enter', () => {
			expect(
				resolveComposerKeyAction(key({ key: 'Enter', metaKey: true, altKey: true }), READY)
			).toBe('sendAlternate');
			expect(
				resolveComposerKeyAction(key({ key: 'Enter', ctrlKey: true, altKey: true }), READY)
			).toBe('sendAlternate');
		});

		it('respects the same guards as the Send button', () => {
			expect(
				resolveComposerKeyAction(key({ key: 'Enter', metaKey: true, altKey: true }), {
					canSend: false,
					overlayOpen: false,
				})
			).toBeNull();
		});

		it('leaves Alt+Enter without the modifier, and Cmd+Alt+Shift+Enter, alone', () => {
			expect(resolveComposerKeyAction(key({ key: 'Enter', altKey: true }), READY)).toBeNull();
			expect(
				resolveComposerKeyAction(
					key({ key: 'Enter', metaKey: true, altKey: true, shiftKey: true }),
					READY
				)
			).toBeNull();
		});
	});

	describe('Cmd/Ctrl+Shift+Enter → schedule', () => {
		it('opens the schedule dialog with Cmd+Shift+Enter', () => {
			expect(
				resolveComposerKeyAction(key({ key: 'Enter', metaKey: true, shiftKey: true }), READY)
			).toBe('schedule');
		});

		it('respects the same guards as the Schedule button', () => {
			expect(
				resolveComposerKeyAction(key({ key: 'Enter', ctrlKey: true, shiftKey: true }), {
					canSend: false,
					overlayOpen: false,
				})
			).toBeNull();
		});
	});

	describe('Escape → minimize', () => {
		it('minimizes when no inner dialog/dropdown is open', () => {
			expect(resolveComposerKeyAction(key({ key: 'Escape' }), READY)).toBe('minimize');
		});

		it('does NOT minimize while an inner overlay is open — the overlay closes first', () => {
			expect(
				resolveComposerKeyAction(key({ key: 'Escape' }), {
					canSend: true,
					overlayOpen: true,
				})
			).toBeNull();
		});

		it('ignores modified Escape chords', () => {
			expect(resolveComposerKeyAction(key({ key: 'Escape', shiftKey: true }), READY)).toBeNull();
			expect(resolveComposerKeyAction(key({ key: 'Escape', metaKey: true }), READY)).toBeNull();
		});
	});

	it('ignores unrelated keys', () => {
		expect(resolveComposerKeyAction(key({ key: 'a', metaKey: true }), READY)).toBeNull();
	});
});
