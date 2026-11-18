/**
 * Where a campaign opens: the report once it is sending or sent, the editor
 * before that. The editor refuses a campaign that has gone out.
 */
import { describe, it, expect } from 'vitest';
import { campaignHref, campaignOpensReport } from '../campaignDestination';

describe('campaignOpensReport', () => {
	it('opens the report for a campaign that is sending or sent', () => {
		expect(campaignOpensReport('sending')).toBe(true);
		expect(campaignOpensReport('sent')).toBe(true);
	});

	it('opens the editor for a campaign that has not gone out', () => {
		for (const status of ['draft', 'scheduled', 'pending_review', 'paused', 'cancelled']) {
			expect(campaignOpensReport(status)).toBe(false);
		}
	});
});

describe('campaignHref', () => {
	it('links a sent campaign to its report whenever it was sent', () => {
		expect(campaignHref({ _id: 'c1', status: 'sent' })).toBe('/dashboard/campaigns/c1/report');
		expect(campaignHref({ _id: 'c2', status: 'sending' })).toBe('/dashboard/campaigns/c2/report');
	});

	it('links an unsent campaign to its editor', () => {
		expect(campaignHref({ _id: 'c3', status: 'draft' })).toBe('/dashboard/campaigns/c3/edit');
	});
});
