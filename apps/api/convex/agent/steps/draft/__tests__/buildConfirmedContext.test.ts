/**
 * Tests for `buildConfirmedContext` — the pure helper that turns the ANSWERED
 * questions on a message's `pendingClarification` into the trusted
 * `[CONFIRMED BY OWNER]` block the draft step renders OUTSIDE the untrusted
 * tags. No live model — the function is pure.
 */

import { describe, it, expect } from 'vitest';
import { buildConfirmedContext } from '../index';

describe('buildConfirmedContext', () => {
	it('returns empty string when there is no pending clarification', () => {
		expect(buildConfirmedContext(undefined)).toBe('');
		expect(buildConfirmedContext(null)).toBe('');
	});

	it('returns empty string when NO question is answered (abandoned best-guess)', () => {
		const out = buildConfirmedContext({
			questions: [
				{ text: 'What is your order number?' },
				{ text: 'Which product?' },
			],
		});
		expect(out).toBe('');
	});

	it('includes only answered questions, pairing text with confirmed value', () => {
		const out = buildConfirmedContext({
			questions: [
				{ text: 'What is your order number?', answer: { value: 'A-123' } },
				{ text: 'Which product?' },
				{ text: 'Preferred date?', answer: { value: 'Friday' } },
			],
		});
		expect(out).toContain('What is your order number? A-123');
		expect(out).toContain('Preferred date? Friday');
		expect(out).not.toContain('Which product?');
	});

	it('ignores blank answer values', () => {
		const out = buildConfirmedContext({
			questions: [{ text: 'Order number?', answer: { value: '   ' } }],
		});
		expect(out).toBe('');
	});
});
