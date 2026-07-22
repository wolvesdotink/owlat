import { describe, expect, it } from 'vitest';
import { isMtaWebhookEvent } from '../mtaWebhookEvent.js';

describe('MTA webhook event runtime contract', () => {
	it('accepts event-specific protected payloads', () => {
		expect(isMtaWebhookEvent({ event: 'sent', messageId: 'message-1', timestamp: 1 })).toBe(true);
		expect(
			isMtaWebhookEvent({
				event: 'campaign.complaint_rate',
				eventId: `effect:v1:${'a'.repeat(64)}`,
				campaignId: 'a'.repeat(32),
				complaintRate: 0.004,
				message: 'Campaign complaint rate crossed the threshold',
				timestamp: 1,
			})
		).toBe(true);
	});

	it.each([
		{ event: 'sent', timestamp: 1 },
		{ event: 'bounced', timestamp: 1 },
		{ event: 'campaign.complaint_rate', eventId: 'short', timestamp: 1 },
		{
			event: 'campaign.complaint_rate',
			eventId: `effect:v1:${'a'.repeat(64)}`,
			campaignId: ['a'.repeat(32)],
			complaintRate: 2,
			message: 42,
			timestamp: 1,
		},
		{ event: 'postmaster.stats', domain: 'example.com', date: 'today', timestamp: 1 },
		{ event: 'routing.reentry', messageId: 'message-1', timestamp: 1 },
	])('rejects incomplete or valid-discriminator/wrong-shape payload %#', (event) => {
		expect(isMtaWebhookEvent(event)).toBe(false);
	});

	it('rejects non-finite timestamps and ratios', () => {
		expect(isMtaWebhookEvent({ event: 'sent', messageId: 'message-1', timestamp: NaN })).toBe(
			false
		);
		expect(
			isMtaWebhookEvent({
				event: 'postmaster.stats',
				domain: 'example.com',
				date: '2026-07-22',
				userReportedSpamRatio: Infinity,
				timestamp: 1,
			})
		).toBe(false);
	});
});
