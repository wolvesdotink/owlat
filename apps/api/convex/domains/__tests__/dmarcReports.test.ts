/**
 * DMARC aggregate reports: intake (decode → parse → ingest, dedupe, drops),
 * reverse DNS enrichment, the per-domain dashboard and reporting setup, the
 * record refresh through `setDmarcPolicy`, and retention.
 */

import { readFileSync } from 'fs';
import { gzipSync } from 'node:zlib';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import type { OrganizationRole } from '../../lib/sessionOrganization';
import { createTestDomain } from '../../__tests__/factories';
import { DAY_MS } from '../../lib/constants';

let mockRole: OrganizationRole = 'admin';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../../lib/sessionOrganization');
	const ctx = () => ({ userId: 'test-user', role: mockRole, activeOrganizationId: 'org-1' });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') {
				const err = new Error('forbidden') as Error & { data?: { category: string } };
				err.data = { category: 'forbidden' };
				throw err;
			}
			return ctx();
		}),
	};
});

// Reverse DNS: 209.85.220.41 confirms as a Google host, 198.51.100.77 claims
// one but does not resolve back (a spoofed PTR must not be believed).
vi.mock('node:dns/promises', () => {
	const reverse = vi.fn(async (ip: string) => {
		if (ip === '209.85.220.41') return ['mail-sor-f41.google.com.'];
		if (ip === '198.51.100.77') return ['mail.google.com'];
		throw new Error('ENOTFOUND');
	});
	const resolve4 = vi.fn(async (name: string) =>
		name === 'mail-sor-f41.google.com' ? ['209.85.220.41'] : ['192.0.2.1']
	);
	const resolve6 = vi.fn(async () => []);
	return { default: { reverse, resolve4, resolve6 }, reverse, resolve4, resolve6 };
});

const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = { ...rootGlob, ...domainsGlob };

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

const fixture = readFileSync(
	new URL('../../../fixtures/dmarc/google-aggregate.xml', import.meta.url),
	'utf8'
);

/** The fixture re-dated to a day `daysAgo` before now, with its own report id. */
function report(daysAgo = 1, reportId = '15739436270285651457'): string {
	const begin = Math.floor((Date.now() - daysAgo * DAY_MS) / 1000);
	return fixture
		.replace('1790726400', String(begin))
		.replace('1790812799', String(begin + 86_399))
		.replace('15739436270285651457', reportId);
}

/** The fixture's one failing row: mail from an IP that is neither ours nor known. */
const SPOOFED_RECORD =
	/<record>(?:(?!<\/record>)[\s\S])*198\.51\.100\.77(?:(?!<\/record>)[\s\S])*<\/record>/;

function gz(xml: string): string {
	return gzipSync(Buffer.from(xml)).toString('base64');
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	mockRole = 'admin';
	process.env['MTA_WEBHOOK_SECRET'] = 'secret';
	process.env['MTA_RETURN_PATH_DOMAIN'] = 'bounces.example.com';
	process.env['MTA_IP_POOLS'] = '203.0.113.10';
	delete process.env['MTA_DMARC_RUA'];
	delete process.env['MTA_DMARC_REPORT_ADDRESS'];
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
	vi.useRealTimers();
});

async function seedDomain(
	t: ReturnType<typeof convexTest>,
	domain = 'example.com'
): Promise<Id<'domains'>> {
	return t.run(async (ctx) => ctx.db.insert('domains', createTestDomain({ domain })));
}

describe('decodeAndIngest', () => {
	it('stores a gzipped report once and drops the re-delivery', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);
		const first = await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, {
			contentBase64: gz(report()),
		});
		expect(first).toEqual({ ok: true });
		const again = await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, {
			contentBase64: gz(report()),
		});
		expect(again).toEqual({ ok: false, reason: 'duplicate' });

		const { reports, rows } = await t.run(async (ctx) => ({
			reports: await ctx.db.query('dmarcReports').collect(),
			rows: await ctx.db.query('dmarcReportRecords').collect(),
		}));
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			reporterOrgName: 'google.com',
			policyDomain: 'example.com',
			messageCount: 458,
			alignedCount: 449,
			recordCount: 3,
		});
		expect(rows).toHaveLength(3);
	});

	it('reads plain XML and drops reports for domains this deployment does not send for', async () => {
		const t = convexTest(schema, modules);
		const xml = Buffer.from(report()).toString('base64');
		expect(
			await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, { contentBase64: xml })
		).toEqual({ ok: false, reason: 'unknown-domain' });
	});

	it('drops reports outside the retention window', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);
		expect(
			await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, {
				contentBase64: gz(report(120)),
			})
		).toEqual({ ok: false, reason: 'out-of-window' });
	});

	it('stops a decompression bomb at the output cap and refuses non-reports', async () => {
		const t = convexTest(schema, modules);
		const bomb = gzipSync(Buffer.alloc(9 * 1024 * 1024, 0x20)).toString('base64');
		expect(
			await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, { contentBase64: bomb })
		).toEqual({ ok: false, reason: 'report-too-large' });
		const junk = Buffer.from('hello world').toString('base64');
		expect(
			await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, { contentBase64: junk })
		).toEqual({ ok: false, reason: 'not-a-report' });
		const corrupt = Buffer.from([0x1f, 0x8b, 1, 2, 3]).toString('base64');
		expect(
			await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, {
				contentBase64: corrupt,
			})
		).toEqual({ ok: false, reason: 'corrupt-archive' });
	});

	it('names source IPs only when their reverse DNS is forward-confirmed', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		await seedDomain(t);
		await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, {
			contentBase64: gz(report()),
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const rows = await t.run(async (ctx) => ctx.db.query('dmarcReportRecords').collect());
		const hostOf = (ip: string) => rows.find((row) => row.sourceIp === ip)?.sourceHost;
		expect(hostOf('209.85.220.41')).toBe('mail-sor-f41.google.com');
		expect(hostOf('198.51.100.77')).toBeUndefined();
		expect(hostOf('203.0.113.10')).toBeUndefined();
	});
});

describe('getDomainSummary', () => {
	it('rolls up volume, flags own and known sources and lists failing sources first', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, {
			contentBase64: gz(report()),
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const summary = await t
			.withIdentity(identity)
			.query(api.domains.dmarcReports.getDomainSummary, { domainId, windowDays: 30 });
		expect(summary).toMatchObject({
			reportCount: 1,
			reporterCount: 1,
			messageCount: 458,
			alignedCount: 449,
			isTruncated: false,
		});
		expect(summary.trend).toHaveLength(30);
		expect(summary.sources.map((source) => [source.kind, source.label])).toEqual([
			['unknown', '198.51.100.77'],
			['owlat', 'Owlat'],
			['known', 'Google'],
		]);
		expect(summary.sources[2]?.overrideReasons).toEqual(['forwarded']);
		expect(summary.readiness).toMatchObject({
			streakDays: 0,
			isReady: false,
			currentPolicy: 'none',
			nextPolicy: 'quarantine',
		});
	});

	it('is ready after fourteen clean days and hands over the next record', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		for (let day = 1; day <= 14; day++) {
			await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, {
				contentBase64: gz(report(day, `r-${day}`).replace(SPOOFED_RECORD, '')),
			});
		}
		const summary = await t
			.withIdentity(identity)
			.query(api.domains.dmarcReports.getDomainSummary, { domainId, windowDays: 7 });
		expect(summary.readiness.streakDays).toBe(14);
		expect(summary.readiness.isReady).toBe(true);
		expect(summary.readiness.recommendedRecord).toEqual({
			type: 'TXT',
			host: '_dmarc',
			value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@bounces.example.com',
		});
	});

	it('is admin-only', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		mockRole = 'editor';
		await expect(
			t
				.withIdentity(identity)
				.query(api.domains.dmarcReports.getDomainSummary, { domainId, windowDays: 30 })
		).rejects.toThrow();
		await expect(
			t.withIdentity(identity).query(api.domains.dmarcReports.getDomainReporting, { domainId })
		).rejects.toThrow();
	});
});

describe('getDomainReporting', () => {
	it('reports the Owlat address and whether the published record asks for it', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		const setup = await t
			.withIdentity(identity)
			.query(api.domains.dmarcReports.getDomainReporting, { domainId });
		expect(setup).toMatchObject({
			mode: 'owlat',
			reportAddress: 'dmarc-reports@bounces.example.com',
			rua: 'mailto:dmarc-reports@bounces.example.com',
			hasDmarcRecord: true,
			isRecordRequestingReports: false,
			isRecordCurrent: false,
			authorizationRecord: null,
			lastReportAt: null,
		});
	});

	it('names the authorization record for a domain outside the report domain', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, 'customer.org');
		const setup = await t
			.withIdentity(identity)
			.query(api.domains.dmarcReports.getDomainReporting, { domainId });
		expect(setup.authorizationRecord).toEqual({
			type: 'TXT',
			hostname: 'customer.org._report._dmarc.bounces.example.com',
			value: 'v=DMARC1',
		});
	});

	it('falls back to MTA_DMARC_RUA when Owlat cannot read reports', async () => {
		delete process.env['MTA_RETURN_PATH_DOMAIN'];
		process.env['MTA_DMARC_RUA'] = 'mailto:reports@elsewhere.example';
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		const setup = await t
			.withIdentity(identity)
			.query(api.domains.dmarcReports.getDomainReporting, { domainId });
		expect(setup).toMatchObject({
			mode: 'external',
			reportAddress: null,
			rua: 'mailto:reports@elsewhere.example',
		});
	});

	it('refreshes the record at the same policy, then has nothing left to change', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		const outcome = await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
			domainId,
			policy: 'none',
			userId: 'test-user',
		});
		expect(outcome).toEqual({ ok: true, policy: 'none', changed: true });
		const setup = await t
			.withIdentity(identity)
			.query(api.domains.dmarcReports.getDomainReporting, { domainId });
		expect(setup.isRecordRequestingReports).toBe(true);
		expect(setup.isRecordCurrent).toBe(true);
		expect(
			await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
				domainId,
				policy: 'none',
				userId: 'test-user',
			})
		).toEqual({ ok: true, policy: 'none', changed: false });
	});
});

describe('sweepExpiredReports', () => {
	it('deletes reports and rows past the retention window', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);
		await t.action(internal.domains.dmarcReportsNode.decodeAndIngest, {
			contentBase64: gz(report()),
		});
		await t.run(async (ctx) => {
			const stored = await ctx.db.query('dmarcReports').first();
			if (stored) await ctx.db.patch(stored._id, { receivedAt: Date.now() - 91 * DAY_MS });
		});
		vi.useFakeTimers();
		await t.mutation(internal.domains.dmarcReports.sweepExpiredReports, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const left = await t.run(async (ctx) => ({
			reports: (await ctx.db.query('dmarcReports').collect()).length,
			rows: (await ctx.db.query('dmarcReportRecords').collect()).length,
		}));
		expect(left).toEqual({ reports: 0, rows: 0 });
	});
});
