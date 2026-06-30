/**
 * Unit tests for the timing-safe compare helper used by every
 * `INSTANCE_SECRET`-protected HTTP action.
 *
 * Correctness — not timing — is what's verifiable here; the timing property
 * is a structural argument about the loop body executing in constant time
 * regardless of equality.
 */

import { describe, expect, it } from 'vitest';
import { safeCompare } from '../safeCompare';

describe('safeCompare', () => {
	it('returns true for identical strings', () => {
		expect(safeCompare('hello-world', 'hello-world')).toBe(true);
	});

	it('returns false when content differs (same length)', () => {
		expect(safeCompare('hello-world', 'hello-WORLD')).toBe(false);
	});

	it('returns false for different lengths', () => {
		expect(safeCompare('short', 'much-longer-string')).toBe(false);
	});

	it('returns true for two empty strings', () => {
		expect(safeCompare('', '')).toBe(true);
	});

	it('returns false when one side is empty', () => {
		expect(safeCompare('', 'x')).toBe(false);
		expect(safeCompare('x', '')).toBe(false);
	});

	it('handles unicode safely (per-code-unit compare)', () => {
		expect(safeCompare('café', 'café')).toBe(true);
		expect(safeCompare('café', 'cafe')).toBe(false);
	});
});
