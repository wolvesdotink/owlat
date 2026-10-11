/**
 * The security scan's pure decisions (ADR-0073, Phase 1c): the outcome
 * precedence, the D13 skip reasons, L5's switch, and the walker's "guard
 * required" refusal.
 */

import { describe, expect, it } from 'vitest';
import { resolveRoutingPolicy } from '@owlat/shared/aiRouting';
import {
	guardBlocksStep,
	guardSkipReason,
	isDeterministicQuarantine,
	isMtaVerdictTerminal,
	scanDisposition,
} from '../disposition';

const clean = {
	isInjection: false,
	maxConfidence: 0,
	phishingDetected: false,
	spamScore: 0,
	agentEnabled: true,
};

describe('scanDisposition', () => {
	it('keeps today’s order when no switch is on', () => {
		expect(scanDisposition(clean)).toBe('continue');
		expect(scanDisposition({ ...clean, agentEnabled: false })).toBe('agent_off');
		expect(scanDisposition({ ...clean, spamScore: 80, agentEnabled: false })).toBe('archive_spam');
		expect(
			scanDisposition({ ...clean, spamScore: 95, isInjection: true, maxConfidence: 0.9 })
		).toBe('quarantine');
		expect(scanDisposition({ ...clean, phishingDetected: true, agentEnabled: false })).toBe(
			'quarantine'
		);
		expect(scanDisposition({ ...clean, isInjection: true, maxConfidence: 0.5 })).toBe('continue');
	});

	it('puts the MTA verdict beside the spam score, after quarantine', () => {
		expect(scanDisposition({ ...clean, isMtaVerdictTerminal: true })).toBe('archive_spam');
		expect(scanDisposition({ ...clean, isMtaVerdictTerminal: true, phishingDetected: true })).toBe(
			'quarantine'
		);
	});

	it('puts the early rule archive after every safety outcome and agent-off', () => {
		const rule = { ...clean, isEarlyRuleArchive: true };
		expect(scanDisposition(rule)).toBe('archive_handling_rule');
		expect(scanDisposition({ ...rule, agentEnabled: false })).toBe('agent_off');
		expect(scanDisposition({ ...rule, spamScore: 85 })).toBe('archive_spam');
		expect(scanDisposition({ ...rule, phishingDetected: true })).toBe('quarantine');
	});
});

describe('isDeterministicQuarantine', () => {
	it('is a confirmed pattern hit or a malicious URL, never a weak pattern alone', () => {
		const none = { patternInjection: false, patternConfidence: 0, phishingDetected: false };
		expect(isDeterministicQuarantine(none)).toBe(false);
		expect(isDeterministicQuarantine({ ...none, phishingDetected: true })).toBe(true);
		expect(
			isDeterministicQuarantine({ ...none, patternInjection: true, patternConfidence: 0.85 })
		).toBe(true);
		// Below the threshold the guard's verdict could still decide it.
		expect(
			isDeterministicQuarantine({ ...none, patternInjection: true, patternConfidence: 0.5 })
		).toBe(false);
	});
});

describe('guardSkipReason', () => {
	it('skips only for spam archive and agent-off, spam first', () => {
		const base = { spamScore: 0, isMtaVerdictTerminal: false, agentEnabled: true };
		expect(guardSkipReason(base)).toBeNull();
		expect(guardSkipReason({ ...base, spamScore: 79 })).toBeNull();
		expect(guardSkipReason({ ...base, spamScore: 80 })).toBe('spam_archived');
		expect(guardSkipReason({ ...base, isMtaVerdictTerminal: true })).toBe('spam_archived');
		expect(guardSkipReason({ ...base, agentEnabled: false })).toBe('agent_disabled');
		expect(guardSkipReason({ ...base, spamScore: 90, agentEnabled: false })).toBe('spam_archived');
	});
});

describe('isMtaVerdictTerminal', () => {
	it('is off by default and never fires on ham', () => {
		const defaults = resolveRoutingPolicy(null);
		expect(defaults.mtaVerdictTerminal).toBe('off');
		expect(isMtaVerdictTerminal(defaults, 'spam')).toBe(false);
		const on = resolveRoutingPolicy({ mtaVerdictTerminal: 'enforce' });
		expect(isMtaVerdictTerminal(on, 'spam')).toBe(true);
		expect(isMtaVerdictTerminal(on, 'quarantine')).toBe(true);
		expect(isMtaVerdictTerminal(on, 'ham')).toBe(false);
		expect(isMtaVerdictTerminal(on, undefined)).toBe(false);
	});
});

describe('guardBlocksStep', () => {
	const skipped = {
		securityFlags: {
			injectionDetected: false,
			confidence: 0,
			guardNotRun: { reason: 'agent_disabled' as const, at: 1 },
			scanTimestamp: 1,
		},
	};

	it('refuses every step after the scan while the guard has not run', () => {
		for (const kind of ['context_retrieval', 'classify', 'clarify', 'draft', 'route', 'plugin:x']) {
			expect(guardBlocksStep(skipped, kind)).toBe(true);
		}
		// The scan itself is how the guard runs.
		expect(guardBlocksStep(skipped, 'security_scan')).toBe(false);
	});

	it('lets a guarded message and an unscanned one through', () => {
		const { guardNotRun: _done, ...ran } = skipped.securityFlags;
		expect(guardBlocksStep({ securityFlags: ran }, 'draft')).toBe(false);
		expect(guardBlocksStep({}, 'draft')).toBe(false);
		expect(guardBlocksStep(null, 'draft')).toBe(false);
	});
});
