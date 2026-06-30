/**
 * Pure-function tests for `securityScanStep.route` — covers the 4
 * branches per ADR-0014's drift bug #2.
 */

import { describe, it, expect } from 'vitest';
import { securityScanStep } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const runCtx = { inboundMessageId: messageId, agentConfig: null };
const input = { inboundMessageId: messageId };

function makeFlags(over: Partial<{ injectionDetected: boolean; confidence: number; spamScore: number; phishingDetected: boolean }> = {}) {
	return {
		injectionDetected: over.injectionDetected ?? false,
		confidence: over.confidence ?? 0,
		spamScore: over.spamScore ?? 0,
		phishingDetected: over.phishingDetected ?? false,
		scanTimestamp: Date.now(),
	};
}

describe('securityScanStep.route', () => {
	it('quarantines on high-confidence injection', () => {
		const route = securityScanStep.route(
			{
				securityFlags: makeFlags({ injectionDetected: true, confidence: 0.9 }),
				isInjection: true,
				maxConfidence: 0.9,
				spamScore: 0,
				phishingDetected: false,
				agentEnabled: true,
			},
			input,
			runCtx,
		);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('quarantined');
	});

	it('quarantines when a malicious/phishing URL is detected (even with no injection)', () => {
		const route = securityScanStep.route(
			{
				securityFlags: makeFlags({ phishingDetected: true }),
				isInjection: false,
				maxConfidence: 0,
				spamScore: 0,
				phishingDetected: true,
				agentEnabled: true,
			},
			input,
			runCtx,
		);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('quarantined');
	});

	it('does not quarantine when injection confidence is below 0.7', () => {
		const route = securityScanStep.route(
			{
				securityFlags: makeFlags({ injectionDetected: true, confidence: 0.5 }),
				isInjection: true,
				maxConfidence: 0.5,
				spamScore: 0,
				phishingDetected: false,
				agentEnabled: true,
			},
			input,
			runCtx,
		);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('classifying');
	});

	it('archives high-spam-score messages', () => {
		const route = securityScanStep.route(
			{
				securityFlags: makeFlags({ spamScore: 85 }),
				isInjection: false,
				maxConfidence: 0,
				spamScore: 85,
				phishingDetected: false,
				agentEnabled: true,
			},
			input,
			runCtx,
		);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('archived');
		if (route.transition.to !== 'archived') return;
		expect(route.transition.reason).toBe('spam');
	});

	it('returns done when the agent feature flag is disabled', () => {
		const route = securityScanStep.route(
			{
				securityFlags: makeFlags(),
				isInjection: false,
				maxConfidence: 0,
				spamScore: 0,
				phishingDetected: false,
				agentEnabled: false,
			},
			input,
			runCtx,
		);
		expect(route.kind).toBe('done');
	});

	it('advances to classifying + schedules context_retrieval when clean', () => {
		const route = securityScanStep.route(
			{
				securityFlags: makeFlags(),
				isInjection: false,
				maxConfidence: 0,
				spamScore: 0,
				phishingDetected: false,
				agentEnabled: true,
			},
			input,
			runCtx,
		);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('classifying');
		expect(route.nextStep).toEqual({
			kind: 'context_retrieval',
			input: { inboundMessageId: messageId },
		});
	});
});
