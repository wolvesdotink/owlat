/**
 * THE OTHER HALF OF THE BLOCK-MESSAGE CONTRACT.
 *
 * The ramp controller's standalone gate 2 halts a cell when receivers return
 * BLOCK messages (`apps/api/convex/delivery/ramp/trailingBaselineGates.ts`). It
 * never sees the response text — it counts categories that THIS classifier
 * assigned. Two deployables, one contract, and no import between them.
 *
 * Both sides read the category names and the block set from
 * `@owlat/shared/smtpBlockCategories`: this suite proves the classifier still
 * maps each real 4xx/5xx shape below to the category it is pinned to, and the
 * Convex suite proves the gate still halts on the block subset. A regex change
 * here that reclassifies a policy rejection as rate pressure fails HERE, before
 * it can silently disable a hard stop over there.
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import {
	SMTP_BLOCK_CATEGORIES,
	SMTP_FAILURE_CATEGORIES,
	isSmtpFailureCategory,
	type SmtpFailureCategory,
} from '@owlat/shared/smtpBlockCategories';
import { describe, expect, it } from 'vitest';
import { classifySmtpResponse } from '../smtpClassifier.js';

/** Is `category` a refusal (a ramp hard stop) rather than rate pressure? */
const isBlockCategory = (category: string) =>
	(SMTP_BLOCK_CATEGORIES as ReadonlySet<string>).has(category);

/**
 * Real 4xx/5xx response shapes and the category each must be assigned. The text
 * is taken from what receivers return; nothing is invented to make a regex pass.
 */
const SMTP_BLOCK_MESSAGE_SAMPLES: readonly {
	readonly smtpCode: number;
	readonly response: string;
	readonly enhancedCode?: string;
	readonly provider: DestinationProviderKey;
	readonly category: SmtpFailureCategory;
	/** Whether this sample is a BLOCK (a ramp hard stop) or mere rate pressure. */
	readonly isBlock: boolean;
}[] = [
	{
		smtpCode: 550,
		response:
			'550-5.7.1 [203.0.113.10] Our system has detected that this message is likely unsolicited mail. To reduce the amount of spam sent to Gmail, this message has been blocked.',
		enhancedCode: '5.7.1',
		provider: 'gmail',
		category: 'content_rejected',
		isBlock: true,
	},
	{
		smtpCode: 550,
		response:
			'550 5.7.1 Service unavailable, Client host [203.0.113.10] blocked using Spamhaus; To request removal from this list see https://www.spamhaus.org/query/ip/203.0.113.10',
		enhancedCode: '5.7.1',
		provider: 'microsoft',
		category: 'content_rejected',
		isBlock: true,
	},
	{
		smtpCode: 550,
		response: '550 5.7.23 Sender address rejected: SPF fail for sender domain example.com',
		enhancedCode: '5.7.23',
		provider: 'microsoft',
		category: 'policy_rejected',
		isBlock: true,
	},
	{
		smtpCode: 550,
		response:
			'550 5.7.25 [203.0.113.10] The IP address sending this message does not have a PTR record setup, or the corresponding forward DNS entry does not point to the sending IP.',
		enhancedCode: '5.7.25',
		provider: 'microsoft',
		category: 'policy_rejected',
		isBlock: true,
	},
	{
		smtpCode: 421,
		response:
			'421-4.7.23 The IP address sending this message does not have a PTR record setup, or the 421-4.7.23 corresponding forward DNS entry does not point to the sending IP.',
		enhancedCode: '4.7.23',
		provider: 'gmail',
		category: 'gmail_ip_identity',
		isBlock: true,
	},
	// ---- rate pressure, deliberately NOT blocks ----
	{
		smtpCode: 421,
		response:
			'421-4.7.28 Our system has detected an unusual rate of unsolicited mail originating from your IP address.',
		enhancedCode: '4.7.28',
		provider: 'gmail',
		category: 'gmail_rate_limited',
		isBlock: false,
	},
	{
		smtpCode: 421,
		response: '421 4.7.0 [TS03] All messages from 203.0.113.10 will be permanently deferred',
		provider: 'yahoo',
		category: 'yahoo_ts03',
		isBlock: false,
	},
	{
		smtpCode: 451,
		response: '451 4.3.2 The maximum number of concurrent connections has exceeded a limit',
		enhancedCode: '4.3.2',
		provider: 'microsoft',
		category: 'microsoft_resource_throttle',
		isBlock: false,
	},
	{
		smtpCode: 451,
		response: '451 4.7.1 Greylisting in effect, please try again later',
		provider: 'other',
		category: 'greylisted',
		isBlock: false,
	},
	{
		smtpCode: 452,
		response: '452 4.2.2 The email account that you tried to reach is over quota',
		enhancedCode: '4.2.2',
		provider: 'other',
		category: 'mailbox_full',
		isBlock: false,
	},
];

describe.each(SMTP_BLOCK_MESSAGE_SAMPLES)('$provider $smtpCode -> $category', (sample) => {
	it('is classified as the sample states', () => {
		const classification = classifySmtpResponse(
			sample.smtpCode,
			sample.response,
			sample.enhancedCode,
			sample.provider
		);
		expect(classification.category).toBe(sample.category);
	});

	it('agrees with the sample about whether it is a BLOCK or mere rate pressure', () => {
		const classification = classifySmtpResponse(
			sample.smtpCode,
			sample.response,
			sample.enhancedCode,
			sample.provider
		);
		expect(isBlockCategory(classification.category)).toBe(sample.isBlock);
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
		expect(isBlockCategory('rate_limited')).toBe(false);
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
