import { describe, it, expect } from 'vitest';
import {
	ANSWER_PHONE_QUERY,
	ANSWER_SPLIT_QUERY,
	answerLayoutFor,
	clampSheetHeight,
	initialSheet,
	keyboardInset,
	sheetForTab,
	sheetHeights,
	snapSheet,
	stepSheet,
	tabForSheet,
	toggleSheet,
	type AnswerLayout,
	type AnswerSheetState,
} from '../answerModeLayout';

describe('answerLayoutFor', () => {
	it('splits from 1100px, stacks from 768px and is the phone layout below', () => {
		expect(answerLayoutFor({ phone: false, split: true })).toBe('split');
		expect(answerLayoutFor({ phone: false, split: false })).toBe('stacked');
		expect(answerLayoutFor({ phone: true, split: false })).toBe('phone');
	});

	it('falls back to the split layout when every query says yes (no viewport)', () => {
		expect(answerLayoutFor({ phone: true, split: true })).toBe('split');
	});

	it('uses the md breakpoint and 1100px in its queries', () => {
		expect(ANSWER_PHONE_QUERY).toBe('(max-width: 767.98px)');
		expect(ANSWER_SPLIT_QUERY).toBe('(min-width: 1100px)');
	});
});

describe('sheet steps', () => {
	it('steps one height at a time and stops at the ends', () => {
		expect(stepSheet('peek', 'up')).toBe('half');
		expect(stepSheet('half', 'up')).toBe('full');
		expect(stepSheet('full', 'up')).toBe('full');
		expect(stepSheet('full', 'down')).toBe('half');
		expect(stepSheet('half', 'down')).toBe('peek');
		expect(stepSheet('peek', 'down')).toBe('peek');
	});

	it('toggles a resting sheet up to half and a raised one out of the way', () => {
		expect(toggleSheet('peek')).toBe('half');
		expect(toggleSheet('half')).toBe('peek');
		// Full never vanishes in one tap: the draft stays in sight.
		expect(toggleSheet('full')).toBe('half');
	});

	it('starts a phone on the conversation and a tablet with the composer up', () => {
		expect(initialSheet('phone', 'conversation')).toBe('peek');
		expect(initialSheet('phone', 'reply')).toBe('full');
		expect(initialSheet('stacked', 'conversation')).toBe('half');
		expect(initialSheet('split', 'reply')).toBe('half');
	});
});

describe('tab and sheet sync', () => {
	it('makes only the full phone sheet the Reply tab', () => {
		expect(tabForSheet('peek', 'phone')).toBe('conversation');
		expect(tabForSheet('half', 'phone')).toBe('conversation');
		expect(tabForSheet('full', 'phone')).toBe('reply');
	});

	it('counts any visible tablet composer as the reply', () => {
		expect(tabForSheet('peek', 'stacked')).toBe('conversation');
		expect(tabForSheet('half', 'stacked')).toBe('reply');
		expect(tabForSheet('full', 'stacked')).toBe('reply');
	});

	it('opens the Reply tab full and drops back to the peek row from it', () => {
		expect(sheetForTab('reply', 'phone', 'peek')).toBe('full');
		expect(sheetForTab('reply', 'phone', 'half')).toBe('full');
		expect(sheetForTab('conversation', 'phone', 'full')).toBe('peek');
		// A raised sheet is already on the Conversation tab: nothing moves.
		expect(sheetForTab('conversation', 'phone', 'half')).toBe('half');
	});

	it('raises a lowered tablet sheet for the reply (Cmd/Ctrl+J) and keeps a raised one', () => {
		expect(sheetForTab('reply', 'stacked', 'peek')).toBe('half');
		expect(sheetForTab('reply', 'stacked', 'full')).toBe('full');
		expect(sheetForTab('conversation', 'stacked', 'half')).toBe('peek');
	});

	it('agrees with itself both ways, so syncing never ping-pongs', () => {
		for (const layout of ['phone', 'stacked'] as AnswerLayout[]) {
			for (const state of ['peek', 'half', 'full'] as AnswerSheetState[]) {
				expect(sheetForTab(tabForSheet(state, layout), layout, state)).toBe(state);
			}
		}
	});
});

describe('snapSheet', () => {
	const phone = { layout: 'phone' as const, containerHeight: 600, peekHeight: 60 };

	it('reads the heights as the peek row, 55% and the whole body on a phone', () => {
		expect(sheetHeights('phone', 600, 60)).toEqual({ peek: 60, half: 330, full: 600 });
		expect(sheetHeights('stacked', 800, 60)).toEqual({ peek: 60, half: 480, full: 680 });
	});

	it('settles a slow release on the nearest height', () => {
		expect(snapSheet({ ...phone, height: 100, velocity: 0 })).toBe('peek');
		expect(snapSheet({ ...phone, height: 300, velocity: 0.2 })).toBe('half');
		expect(snapSheet({ ...phone, height: 520, velocity: -0.2 })).toBe('full');
	});

	it('carries a flick on to the next height in its direction', () => {
		// Just above the peek row, flicked up: half, even though peek is nearer.
		expect(snapSheet({ ...phone, height: 90, velocity: 1 })).toBe('half');
		// Just above half, flicked up: full.
		expect(snapSheet({ ...phone, height: 340, velocity: 1 })).toBe('full');
		// Just below full, flicked down: half.
		expect(snapSheet({ ...phone, height: 580, velocity: -1 })).toBe('half');
		// Flicked down from under half: the peek row.
		expect(snapSheet({ ...phone, height: 320, velocity: -1 })).toBe('peek');
	});

	it('keeps a flick past either end at that end', () => {
		expect(snapSheet({ ...phone, height: 600, velocity: 2 })).toBe('full');
		expect(snapSheet({ ...phone, height: 60, velocity: -2 })).toBe('peek');
	});

	it('clamps a live drag between the peek row and the body', () => {
		expect(clampSheetHeight(10, 600, 60)).toBe(60);
		expect(clampSheetHeight(900, 600, 60)).toBe(600);
		expect(clampSheetHeight(250.4, 600, 60)).toBe(250);
	});
});

describe('keyboardInset', () => {
	it('is what the layout viewport has below the visual one', () => {
		// iOS: 844px tall, the keyboard leaves 508px, nothing scrolled.
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: 508, offsetTop: 0, scale: 1 })).toBe(
			336
		);
		// The visual viewport scrolled down 40px inside the layout one.
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: 508, offsetTop: 40, scale: 1 })).toBe(
			296
		);
	});

	it('is nothing without a keyboard, or on a pinch-zoomed page', () => {
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: 844, offsetTop: 0, scale: 1 })).toBe(
			0
		);
		expect(
			keyboardInset({ layoutHeight: 844, viewportHeight: 400, offsetTop: 100, scale: 2 })
		).toBe(0);
		// Sub-pixel rounding noise is not a keyboard.
		expect(
			keyboardInset({ layoutHeight: 844, viewportHeight: 843.5, offsetTop: 0, scale: 1 })
		).toBe(0);
	});
});
