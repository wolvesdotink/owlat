import { describe, it, expect } from 'vitest';
import { domainAuthState, toReputationDto } from '../reputationQueries';
import type { ReputationSummary } from '../sendingReputation';

const ZERO: ReputationSummary = {
	totalSent: 0,
	totalDelivered: 0,
	totalBounced: 0,
	totalHardBounced: 0,
	totalComplaints: 0,
	bounceRate: 0,
	complaintRate: 0,
	riskLevel: 'low',
};

describe('toReputationDto', () => {
	it('returns null when the window has no sending activity', () => {
		expect(toReputationDto(ZERO)).toBeNull();
	});

	it('treats a single delivered (no sent) as activity', () => {
		expect(toReputationDto({ ...ZERO, totalDelivered: 1 })).not.toBeNull();
	});

	it('treats a single bounce as activity', () => {
		expect(toReputationDto({ ...ZERO, totalBounced: 1 })).not.toBeNull();
	});

	it('treats a single complaint as activity', () => {
		expect(toReputationDto({ ...ZERO, totalComplaints: 1 })).not.toBeNull();
	});

	it('projects exactly the UI fields, dropping totalHardBounced', () => {
		const summary: ReputationSummary = {
			totalSent: 1000,
			totalDelivered: 980,
			totalBounced: 15,
			totalHardBounced: 9,
			totalComplaints: 2,
			bounceRate: 1.5,
			complaintRate: 0.2,
			riskLevel: 'medium',
		};

		const dto = toReputationDto(summary);

		expect(dto).toEqual({
			bounceRate: 1.5,
			complaintRate: 0.2,
			riskLevel: 'medium',
			totalSent: 1000,
			totalDelivered: 980,
			totalBounced: 15,
			totalComplaints: 2,
		});
		// The internal hard-bounce tally is not part of the card DTO.
		expect(dto).not.toHaveProperty('totalHardBounced');
	});
});

describe('domainAuthState', () => {
	const dkim = [{ verified: true }];
	const dmarc = { verified: true };

	it('counts SPF as verified for an own-MTA domain via its verified MAIL FROM record', () => {
		// Own-MTA domains publish no apex SPF; SPF passes on the bounce host.
		const auth = domainAuthState(
			{ mailFrom: [{ hostname: 'bounce.example.com' }] },
			{ dkim, dmarc, mailFrom: [{ verified: true }] }
		);
		expect(auth).toEqual({ spf: true, dkim: true, dmarc: true });
	});

	it('reports SPF missing while the MAIL FROM record is unverified', () => {
		const auth = domainAuthState(
			{ mailFrom: [{ hostname: 'bounce.example.com' }] },
			{ dkim, dmarc, mailFrom: [{ verified: false }] }
		);
		expect(auth.spf).toBe(false);
	});

	it('uses the apex SPF result when an apex SPF record is configured', () => {
		const dnsRecords = { spf: { host: '@' }, mailFrom: [{ hostname: 'bounce.example.com' }] };
		expect(
			domainAuthState(dnsRecords, { spf: { verified: false }, mailFrom: [{ verified: true }] }).spf
		).toBe(false);
		expect(domainAuthState(dnsRecords, { spf: { verified: true } }).spf).toBe(true);
	});

	it('reports SPF missing when neither an apex SPF nor a MAIL FROM record exists', () => {
		expect(domainAuthState({}, { dkim, dmarc }).spf).toBe(false);
	});
});
