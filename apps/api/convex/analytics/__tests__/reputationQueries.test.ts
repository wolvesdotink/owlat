import { describe, it, expect } from 'vitest';
import { toReputationDto } from '../reputationQueries';
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
