/**
 * THE OTHER HALF OF THE BLOCK-MESSAGE CONTRACT.
 *
 * The ramp controller's standalone gate 2 halts a cell when receivers return
 * BLOCK messages (`apps/api/convex/delivery/ramp/trailingBaselineGates.ts`). It
 * never sees the response text — it counts categories that THIS classifier
 * assigned. Two deployables, one contract, and no import between them.
 *
 * So both sides pin themselves to the same shared fixture: this suite proves the
 * classifier still maps each real 4xx/5xx shape to the category the fixture
 * claims, and the Convex suite proves the gate still halts on the block subset. A
 * regex change here that reclassifies a policy rejection as rate pressure fails
 * HERE, before it can silently disable a hard stop over there.
 */

import {
	SMTP_BLOCK_CATEGORIES,
	SMTP_BLOCK_MESSAGE_SAMPLES,
	SMTP_FAILURE_CATEGORIES,
	isSmtpBlockCategory,
	isSmtpFailureCategory,
} from '@owlat/shared/smtpBlockCategories';
import { describe, expect, it } from 'vitest';
import { classifySmtpResponse } from '../smtpClassifier.js';

describe.each(SMTP_BLOCK_MESSAGE_SAMPLES)('$provider $smtpCode -> $category', (sample) => {
	it('is classified as the shared fixture states', () => {
		const classification = classifySmtpResponse(
			sample.smtpCode,
			sample.response,
			sample.enhancedCode,
			sample.provider
		);
		expect(classification.category).toBe(sample.category);
	});

	it('agrees with the fixture about whether it is a BLOCK or mere rate pressure', () => {
		const classification = classifySmtpResponse(
			sample.smtpCode,
			sample.response,
			sample.enhancedCode,
			sample.provider
		);
		expect(isSmtpBlockCategory(classification.category)).toBe(sample.isBlock);
	});
});

describe('the block set', () => {
	it('contains only categories this classifier can actually produce', () => {
		const produced = new Set(
			SMTP_BLOCK_MESSAGE_SAMPLES.map(
				(sample) =>
					classifySmtpResponse(
						sample.smtpCode,
						sample.response,
						sample.enhancedCode,
						sample.provider
					).category
			)
		);
		for (const category of SMTP_BLOCK_CATEGORIES) {
			expect(produced.has(category)).toBe(true);
		}
	});

	it('is a STRICT subset of the whole vocabulary — the two guards answer two questions', () => {
		for (const category of SMTP_BLOCK_CATEGORIES) {
			expect(SMTP_FAILURE_CATEGORIES.has(category)).toBe(true);
		}
		expect(SMTP_BLOCK_CATEGORIES.size).toBeLessThan(SMTP_FAILURE_CATEGORIES.size);
		// The row-read narrowing must ADMIT rate pressure: the gate is designed to
		// receive and audit it, and narrowing with the block guard would drop it.
		expect(isSmtpFailureCategory('rate_limited')).toBe(true);
		expect(isSmtpBlockCategory('rate_limited')).toBe(false);
		expect(isSmtpFailureCategory('not_a_category')).toBe(false);
	});

	it('never contains a retryable throttle: a block does not get better by sending', () => {
		for (const sample of SMTP_BLOCK_MESSAGE_SAMPLES) {
			if (!sample.isBlock) continue;
			const classification = classifySmtpResponse(
				sample.smtpCode,
				sample.response,
				sample.enhancedCode,
				sample.provider
			);
			// A permanent refusal, or Gmail's 4.7.23 IP-identity rejection — which is
			// retryable at the SMTP layer but is a reputation problem, not a queue
			// one, and must not be read as "slow down".
			expect(
				classification.retryable === false || classification.category === 'gmail_ip_identity'
			).toBe(true);
		}
	});
});
