/**
 * Pure-function tests for `buildStanceSection` — the standing-stance system
 * message the draft step injects when a `draft_with_stance` handling rule
 * matches. Proves the matched stance is actually surfaced to the drafter (the
 * "draft a polite decline for recruiters" wiring), framed as an authoritative
 * standing instruction, and that an empty match collapses to today's generic
 * draft (no stance section).
 */

import { describe, it, expect } from 'vitest';
import { buildStanceSection } from '../stanceSection';

describe('buildStanceSection', () => {
	it('returns empty string when there is no matched stance', () => {
		expect(buildStanceSection([])).toBe('');
	});

	it('ignores blank / whitespace-only stances', () => {
		expect(buildStanceSection(['', '   '])).toBe('');
	});

	it('surfaces a single stance as an authoritative standing instruction', () => {
		const out = buildStanceSection(['a polite decline for recruiters']);
		expect(out).toContain('authoritative');
		expect(out).toContain('- a polite decline for recruiters');
	});

	it('lists multiple stances, trimmed, one per line', () => {
		const out = buildStanceSection(['  decline the pitch  ', 'keep it warm']);
		expect(out).toContain('- decline the pitch');
		expect(out).toContain('- keep it warm');
	});
});
