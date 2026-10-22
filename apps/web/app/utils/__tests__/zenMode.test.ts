import { describe, expect, it } from 'vitest';
import { isOverlayOpen, isZenChord, zenTakesEscape } from '../zenMode';

const press = {
	composing: false,
	editable: false,
	overlayOpen: false,
	pageOwnsEscape: false,
};

describe('zenTakesEscape', () => {
	it('takes a plain Esc, before the page gets it', () => {
		expect(zenTakesEscape(press)).toBe(true);
	});

	it('leaves Esc to an open dialog or menu', () => {
		expect(zenTakesEscape({ ...press, overlayOpen: true })).toBe(false);
	});

	it('leaves Esc to the text being typed, and to an IME composing it', () => {
		expect(zenTakesEscape({ ...press, editable: true })).toBe(false);
		expect(zenTakesEscape({ ...press, composing: true })).toBe(false);
	});

	it('leaves Esc to a page that is chrome-less on its own terms (Answer mode)', () => {
		expect(zenTakesEscape({ ...press, pageOwnsEscape: true })).toBe(false);
	});
});

describe('isZenChord', () => {
	it('matches Cmd or Ctrl with Shift and F, whatever case the browser reports', () => {
		expect(isZenChord({ key: 'F', metaKey: true, shiftKey: true })).toBe(true);
		expect(isZenChord({ key: 'f', ctrlKey: true, shiftKey: true })).toBe(true);
	});

	it('does not match find (no Shift), Alt chords or a bare F', () => {
		expect(isZenChord({ key: 'f', metaKey: true })).toBe(false);
		expect(isZenChord({ key: 'F', metaKey: true, shiftKey: true, altKey: true })).toBe(false);
		expect(isZenChord({ key: 'F', shiftKey: true })).toBe(false);
	});
});

describe('isOverlayOpen', () => {
	it('sees dialogs and menus, not listboxes that are always on the page', () => {
		const root = document.createElement('div');
		root.innerHTML = '<ul role="listbox"></ul>';
		expect(isOverlayOpen(root)).toBe(false);
		root.innerHTML = '<div role="menu"></div>';
		expect(isOverlayOpen(root)).toBe(true);
		root.innerHTML = '<div role="dialog"></div>';
		expect(isOverlayOpen(root)).toBe(true);
	});
});
