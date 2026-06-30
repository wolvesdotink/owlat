import { describe, it, expect, afterEach } from 'vitest';
import {
	scanContent,
	contentRules,
	registerContentRule,
	unregisterContentRule,
	type ContentScanRule,
	type ScanInput,
} from '../content/index.js';
import type { ContentFlag } from '../types.js';

// All built-in rules register themselves at module load via the side-effect
// imports in content/index.ts. The registry is shared across tests, so any
// stub a test installs MUST be removed in afterEach to keep test isolation.

// =============================================================================
// Bucket 1 — Unit: registry/provider lifecycle for contentRules
// =============================================================================
describe('contentRules — registry lifecycle', () => {
	const installedIds: string[] = [];
	afterEach(() => {
		while (installedIds.length > 0) unregisterContentRule(installedIds.pop()!);
	});

	it('exposes all built-in rule ids in stable kebab-case', () => {
		const ids = contentRules.keys().sort();
		expect(ids).toEqual([
			'caps-abuse',
			'excessive-punctuation',
			'homoglyphs',
			'phishing-urls',
			'prohibited-content',
			'spam-keywords',
		]);
	});

	it('register stores a new rule by id', () => {
		const rule: ContentScanRule = { id: 'stub-1', scan: () => [] };
		registerContentRule(rule);
		installedIds.push('stub-1');
		expect(contentRules.get('stub-1')).toBe(rule);
	});

	it('registering an id twice overrides the prior rule (last write wins)', () => {
		const first: ContentScanRule = { id: 'stub-override', scan: () => [] };
		const second: ContentScanRule = { id: 'stub-override', scan: () => [] };
		registerContentRule(first);
		registerContentRule(second);
		installedIds.push('stub-override');
		expect(contentRules.get('stub-override')).toBe(second);
	});

	it('unregisterContentRule reports whether anything was removed', () => {
		registerContentRule({ id: 'stub-removable', scan: () => [] });
		expect(unregisterContentRule('stub-removable')).toBe(true);
		expect(unregisterContentRule('stub-removable')).toBe(false);
	});
});

// =============================================================================
// Bucket 2 — Contract: every ContentScanRule honours the same shape
// =============================================================================
describe('contentRules — every installed rule satisfies the ContentScanRule contract', () => {
	const emptyInput: ScanInput = { subject: '', html: '', text: '', urls: [] };

	for (const rule of contentRules.values()) {
		describe(`rule "${rule.id}"`, () => {
			it('returns an array of ContentFlag objects', () => {
				const result = rule.scan(emptyInput);
				expect(Array.isArray(result)).toBe(true);
				for (const flag of result) {
					expect(flag).toHaveProperty('type');
					expect(flag).toHaveProperty('severity');
					expect(flag).toHaveProperty('description');
				}
			});

			it('is pure: same input → same output', () => {
				const first = rule.scan(emptyInput);
				const second = rule.scan(emptyInput);
				expect(first).toEqual(second);
			});
		});
	}
});

// =============================================================================
// Bucket 3 — Behavior-parity / regression
//
// The existing __tests__/scanContent.test.ts captures the historical behavior
// of scanContent() for spam, phishing, shortener, mismatch, homoglyph, caps,
// punctuation, and prohibited-content fixtures. It runs alongside this file;
// any regression there is a parity failure for this task.
//
// We add one parity-only assertion here: every built-in flag type can still
// appear via the registry path so no rule was accidentally orphaned.
// =============================================================================
describe('contentRules — registry-driven scanContent matches legacy flag coverage', () => {
	it('still emits spam_keywords flags through the registry', () => {
		const result = scanContent(
			'FREE MONEY - Get Rich Quick!!!',
			'<html><body>Make money fast! Double your investment guaranteed!</body></html>',
		);
		expect(result.flags.some((f) => f.type === 'spam_keywords')).toBe(true);
	});

	it('still emits caps_abuse and excessive_punctuation through the registry', () => {
		const result = scanContent(
			'WIN BIG NOW!!!!!',
			'<html><body>Click here.</body></html>',
		);
		expect(result.flags.some((f) => f.type === 'caps_abuse')).toBe(true);
		expect(result.flags.some((f) => f.type === 'excessive_punctuation')).toBe(true);
	});
});

// =============================================================================
// Bucket 4 — Extension proof: a third-party rule is dispatched identically
// =============================================================================
describe('contentRules — extension proof', () => {
	const installedIds: string[] = [];
	afterEach(() => {
		while (installedIds.length > 0) unregisterContentRule(installedIds.pop()!);
	});

	it('registers a custom rule and scanContent invokes it with the same ScanInput', () => {
		const seen: ScanInput[] = [];
		const customFlag: ContentFlag = {
			type: 'suspicious_pattern',
			severity: 'high',
			description: 'compliance-keyword "internal-only" leaked',
		};
		registerContentRule({
			id: 'compliance-keywords',
			scan: (input) => {
				seen.push(input);
				return input.text.includes('internal-only') ? [customFlag] : [];
			},
		});
		installedIds.push('compliance-keywords');

		const result = scanContent(
			'Hi team',
			'<html><body>This is internal-only — do not forward.</body></html>',
		);

		// The custom rule was invoked exactly once and with the standard input shape
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({
			subject: 'Hi team',
			html: '<html><body>This is internal-only — do not forward.</body></html>',
			text: 'This is internal-only — do not forward.',
			urls: [],
		});

		// The custom flag propagated and contributed to scoring exactly like a first-party flag
		expect(result.flags).toContainEqual(customFlag);
		expect(result.score).toBeGreaterThanOrEqual(20); // high severity adds 20
		expect(result.level).not.toBe('clean');
	});

	it('an unregistered custom rule no longer runs', () => {
		let calls = 0;
		registerContentRule({
			id: 'transient',
			scan: () => {
				calls += 1;
				return [];
			},
		});
		scanContent('s', '<p>x</p>');
		expect(calls).toBe(1);
		unregisterContentRule('transient');
		scanContent('s', '<p>x</p>');
		expect(calls).toBe(1);
	});
});

// =============================================================================
// Bucket 5 — Failure modes
// =============================================================================
describe('contentRules — failure modes', () => {
	const installedIds: string[] = [];
	afterEach(() => {
		while (installedIds.length > 0) unregisterContentRule(installedIds.pop()!);
	});

	it('a rule that throws does not abort the scan', () => {
		registerContentRule({
			id: 'broken',
			scan: () => {
				throw new Error('intentional rule failure');
			},
		});
		installedIds.push('broken');

		// Other built-in rules should still flag this
		const result = scanContent(
			'FREE MONEY',
			'<html><body>get rich quick today</body></html>',
		);
		expect(result.flags.some((f) => f.type === 'spam_keywords')).toBe(true);
	});

	it('surfaces the failing rule id and message in a low-severity flag', () => {
		registerContentRule({
			id: 'broken-named',
			scan: () => {
				throw new Error('boom');
			},
		});
		installedIds.push('broken-named');

		const result = scanContent('hi', '<p>clean body</p>');
		const surfaced = result.flags.find(
			(f) => f.type === 'suspicious_pattern' && f.description.includes('broken-named'),
		);
		expect(surfaced).toBeDefined();
		expect(surfaced!.description).toContain('boom');
		expect(surfaced!.severity).toBe('low');
	});
});
