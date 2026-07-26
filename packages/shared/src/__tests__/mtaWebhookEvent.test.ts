import { describe, expect, it } from 'vitest';
import { isMtaWebhookEvent } from '../mtaWebhookEvent.js';
import { createDeliverabilityProbeToken } from '../deliverabilityProbeToken';

describe('MTA webhook event runtime contract', () => {
	it('accepts only confirmed canonical IPv6 readiness regressions', () => {
		const event = {
			event: 'ip.readiness_regressed',
			eventId: 'ipv6-readiness-v1:spf:2001:db8::10:7',
			ip: '2001:db8::10',
			readinessCheck: 'spf',
			readinessReason: 'missing-ip6-mechanism',
			eligibilityGeneration: 7,
			message: 'IPv6 SPF regressed',
			timestamp: 1,
		};
		expect(isMtaWebhookEvent(event)).toBe(true);
		expect(isMtaWebhookEvent({ ...event, readinessReason: 'lookup-error' })).toBe(false);
		expect(isMtaWebhookEvent({ ...event, ip: '2001:0DB8:0:0:0:0:0:10' })).toBe(false);
	});

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

	it('accepts only precisely formatted deliverability probe evidence and bounded verdicts', () => {
		const event = {
			event: 'deliverability.probe_observed',
			eventId:
				'deliverability-probe:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			probeToken: createDeliverabilityProbeToken('secret', 1_800_000_900_000, Buffer.alloc(9, 7)),
			spfResult: 'softfail',
			dkimResult: 'temperror',
			dmarcResult: 'none',
			ip: '203.0.113.10',
			tlsVersion: 'TLSv1.3',
			ptr: 'mail.example',
			timestamp: 1_800_000_000_000,
		};
		expect(isMtaWebhookEvent(event)).toBe(true);
		expect(isMtaWebhookEvent({ ...event, probeToken: 'a'.repeat(32) })).toBe(false);
		expect(isMtaWebhookEvent({ ...event, dmarcResult: 'neutral' })).toBe(false);
		expect(isMtaWebhookEvent({ ...event, spfResult: 'mystery' })).toBe(false);
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
