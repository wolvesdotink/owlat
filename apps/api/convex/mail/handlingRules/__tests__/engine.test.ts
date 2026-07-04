/**
 * Pure-function tests for the natural-language handling-rule engine. No network,
 * no model — the matcher is deterministic JS.
 */

import { describe, it, expect } from 'vitest';
import {
	matchHandlingRule,
	evaluateHandlingRules,
	restrictAutonomy,
	type HandlingRuleLike,
	type HandlingRuleTarget,
} from '../engine';

function rule(over: Partial<HandlingRuleLike> = {}): HandlingRuleLike {
	return {
		isEnabled: over.isEnabled ?? true,
		instruction: over.instruction ?? 'test rule',
		matcher: over.matcher ?? { senders: ['acme.com'] },
		action: over.action ?? { type: 'never_auto_send' },
	};
}

function target(over: Partial<HandlingRuleTarget> = {}): HandlingRuleTarget {
	return {
		from: over.from ?? 'Jane <jane@acme.com>',
		subject: over.subject ?? 'Hello there',
		body: over.body ?? 'Please advise on the contract.',
		category: over.category,
	};
}

describe('matchHandlingRule', () => {
	it('matches a sender substring (domain) case-insensitively', () => {
		expect(matchHandlingRule(rule({ matcher: { senders: ['ACME.com'] } }), target())).toBe(true);
	});

	it('does not match a different sender', () => {
		expect(
			matchHandlingRule(rule({ matcher: { senders: ['other.com'] } }), target())
		).toBe(false);
	});

	it('OR-s entries within a facet', () => {
		const r = rule({ matcher: { senders: ['nope.com', 'acme.com'] } });
		expect(matchHandlingRule(r, target())).toBe(true);
	});

	it('AND-s across facets — both must hold', () => {
		const r = rule({ matcher: { senders: ['acme.com'], subjectContains: ['invoice'] } });
		expect(matchHandlingRule(r, target({ subject: 'Your invoice' }))).toBe(true);
		expect(matchHandlingRule(r, target({ subject: 'Hi' }))).toBe(false);
	});

	it('matches a category exactly (case-insensitive)', () => {
		const r = rule({ matcher: { categories: ['sales'] } });
		expect(matchHandlingRule(r, target({ category: 'SALES' }))).toBe(true);
		expect(matchHandlingRule(r, target({ category: 'support' }))).toBe(false);
	});

	it('an empty matcher is inert (never a catch-all)', () => {
		expect(matchHandlingRule(rule({ matcher: {} }), target())).toBe(false);
	});

	it('a disabled rule never matches', () => {
		expect(matchHandlingRule(rule({ isEnabled: false }), target())).toBe(false);
	});
});

describe('evaluateHandlingRules', () => {
	it('applies a categorize action from the first matching rule', () => {
		const rules = [
			rule({
				matcher: { senders: ['acme.com'] },
				action: { type: 'categorize', category: 'sales' },
			}),
		];
		const out = evaluateHandlingRules(rules, target());
		expect(out.categoryOverride).toBe('sales');
		expect(out.matchedInstructions).toHaveLength(1);
	});

	it('flags auto_archive when an archive rule matches', () => {
		const rules = [
			rule({ matcher: { subjectContains: ['newsletter'] }, action: { type: 'auto_archive' } }),
		];
		const out = evaluateHandlingRules(rules, target({ subject: 'Weekly newsletter' }));
		expect(out.autoArchive).toBe(true);
		expect(out.restrictsAutoSend).toBe(true);
	});

	it('collects draft_with_stance stances and restricts auto-send (draft-only)', () => {
		const rules = [
			rule({
				matcher: { senders: ['acme.com'] },
				action: { type: 'draft_with_stance', stance: 'a polite decline' },
			}),
		];
		const out = evaluateHandlingRules(rules, target());
		expect(out.stances).toEqual(['a polite decline']);
		expect(out.restrictsAutoSend).toBe(true);
	});

	it('a never_auto_send rule sets restrictsAutoSend with a reason', () => {
		const out = evaluateHandlingRules([rule()], target());
		expect(out.restrictsAutoSend).toBe(true);
		expect(out.reasons[0]).toContain('human review');
	});

	it('a categorize-only match does NOT restrict auto-send', () => {
		const rules = [
			rule({
				matcher: { senders: ['acme.com'] },
				action: { type: 'categorize', category: 'sales' },
			}),
		];
		expect(evaluateHandlingRules(rules, target()).restrictsAutoSend).toBe(false);
	});

	it('non-matching rules contribute nothing', () => {
		const out = evaluateHandlingRules(
			[rule({ matcher: { senders: ['other.com'] } })],
			target()
		);
		expect(out.restrictsAutoSend).toBe(false);
		expect(out.matchedInstructions).toHaveLength(0);
	});
});

describe('restrictAutonomy', () => {
	it('downgrades a permitted auto-send to human review when a rule restricts', () => {
		const out = evaluateHandlingRules([rule()], target());
		const decision = restrictAutonomy(true, out);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain('human review');
	});

	it('CANNOT widen — a denied auto-send stays denied even with no restricting rule', () => {
		const out = evaluateHandlingRules(
			[rule({ action: { type: 'categorize', category: 'sales' } })],
			target()
		);
		expect(out.restrictsAutoSend).toBe(false);
		expect(restrictAutonomy(false, out).allowed).toBe(false);
	});

	it('CANNOT widen — a denied auto-send stays denied even when a rule matches', () => {
		const out = evaluateHandlingRules([rule()], target());
		expect(restrictAutonomy(false, out).allowed).toBe(false);
	});

	it('leaves a permitted auto-send permitted when nothing restricts', () => {
		const out = evaluateHandlingRules(
			[rule({ matcher: { senders: ['other.com'] } })],
			target()
		);
		expect(restrictAutonomy(true, out).allowed).toBe(true);
	});
});
