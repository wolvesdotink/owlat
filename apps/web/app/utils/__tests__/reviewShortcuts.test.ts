import { describe, it, expect } from 'vitest';
import { resolveReviewShortcut, REVIEW_SHORTCUT_GROUPS } from '../reviewShortcuts';

describe('resolveReviewShortcut', () => {
	it('maps the review-gate keys to their actions', () => {
		expect(resolveReviewShortcut('a')).toBe('approve');
		expect(resolveReviewShortcut('e')).toBe('edit');
		expect(resolveReviewShortcut('x')).toBe('reject');
		expect(resolveReviewShortcut('#')).toBe('reject');
		expect(resolveReviewShortcut('s')).toBe('skip');
	});

	it('returns null for unmapped keys (so they never trigger a destructive action)', () => {
		expect(resolveReviewShortcut('z')).toBeNull();
		expect(resolveReviewShortcut('Enter')).toBeNull();
		expect(resolveReviewShortcut('Escape')).toBeNull();
		// Shift changes meaning: capitalized variants are not mapped.
		expect(resolveReviewShortcut('A')).toBeNull();
		expect(resolveReviewShortcut('E')).toBeNull();
		expect(resolveReviewShortcut('X')).toBeNull();
	});

	it('exposes a keyboard-hint legend covering every action', () => {
		const labels = REVIEW_SHORTCUT_GROUPS.map((g) => g.label);
		expect(labels).toContain('Approve & send');
		expect(labels).toContain('Edit');
		expect(labels).toContain('Reject');
		expect(labels).toContain('Skip');
		expect(labels).toContain('Pick option');
	});
});
