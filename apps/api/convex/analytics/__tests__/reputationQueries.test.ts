import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { domainAuthState, toReputationDto } from '../reputationQueries';
import type { ReputationSummary } from '../sendingReputation';

// getSendingOverview runs behind authedQuery; stub the membership reads so the
// handler runs (same stubs as delivery/__tests__/healthRollup.test.ts).
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user-1', role: 'editor' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

// `'../../**'` from `analytics/__tests__` omits the sibling `analytics/*`
// modules; merge them back under the same `../../` prefix.
const rootGlob = import.meta.glob('../../**/*.*s');
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../analytics/'),
		mod,
	])
);
const modules = { ...rootGlob, ...analyticsGlob };

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

describe('getSendingOverview', () => {
	it('returns the stored reason and change date next to the abuse status', async () => {
		const t = convexTest(schema, modules);
		const changedAt = Date.UTC(2026, 10, 20, 9, 0, 0);
		const reason =
			'Auto-suspended: Gmail reports a spam rate of 0.42% for mail.example.com on 2026-11-19';
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				abuseStatus: 'suspended',
				abuseStatusReason: reason,
				abuseStatusChangedAt: changedAt,
				abuseStatusChangedBy: 'system',
				createdAt: changedAt,
			});
		});

		const overview = await t.query(api.analytics.reputationQueries.getSendingOverview, {});
		expect(overview).toMatchObject({
			abuseStatus: 'suspended',
			abuseStatusReason: reason,
			abuseStatusChangedAt: changedAt,
		});
	});

	it('returns null for the reason and date when the status was never changed', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { createdAt: Date.now() });
		});

		const overview = await t.query(api.analytics.reputationQueries.getSendingOverview, {});
		expect(overview).toMatchObject({
			abuseStatus: null,
			abuseStatusReason: null,
			abuseStatusChangedAt: null,
		});
	});
});
