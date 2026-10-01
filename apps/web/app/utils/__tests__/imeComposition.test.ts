import { describe, expect, it } from 'vitest';
import { isImeComposing } from '../imeComposition';

const key = (init: KeyboardEventInit & { keyCode?: number }) =>
	({ isComposing: false, keyCode: 13, ...init }) as KeyboardEvent;

describe('isImeComposing (#1052)', () => {
	it('is true while the composition is active', () => {
		expect(isImeComposing(key({ key: 'Enter', isComposing: true }))).toBe(true);
	});

	it("is true for Safari's confirming Enter, which arrives after compositionend", () => {
		expect(isImeComposing(key({ key: 'Enter', isComposing: false, keyCode: 229 }))).toBe(true);
	});

	it('is false for an ordinary Enter', () => {
		expect(isImeComposing(key({ key: 'Enter' }))).toBe(false);
	});
});
