/**
 * TLS-RPT (RFC 8460) ingestion + dashboard aggregation.
 *
 * Covers the hard test gate for the TLS-RPT dashboard piece:
 *   1. Fixture ingest — the checked-in real-world sample gunzips + parses +
 *      digests + persists a row (full pipeline, shared parser → ingest).
 *   2. Malformed / oversized reports are rejected WITHOUT throwing (the shared
 *      parser returns a discriminated failure; ingest is never reached).
 *   3. Duplicate report-id is idempotent (one row, patched not duplicated).
 *   4. `getTlsReportSummary` rolls reporters / failure types / trend up correctly.
 */

import { readFileSync } from 'fs';
import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	decodeTlsReport,
	parseTlsReport,
	digestTlsReport,
	gunzipTlsReport,
	TLS_RPT_MAX_COMPRESSED_BYTES,
	type TlsReportDigest,
} from '@owlat/shared';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { OrganizationRole } from '../../lib/sessionOrganization';

// Mutable role each test selects — `getTlsReportSummary` is `adminQuery`
// (→ `requireOrgPermission('organization:manage')`), so the role distinction is
// what the wrapper's gate decides.
let mockRole: OrganizationRole = 'admin';

function throwForbidden(): never {
	const err = new Error("You don't have permission to perform this action") as Error & {
		data?: { category: string };
	};
	err.data = { category: 'forbidden' };
	throw err;
}

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const ctx = () => ({ userId: 'test-user', role: mockRole });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		// Role-aware gate: owner/admin pass `organization:manage`, editor does not.
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') {
				throwForbidden();
			}
			return ctx();
		}),
	};
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

const fixtureGz = readFileSync(
	new URL('../../../../../fixtures/sealed-mail/tls-report-sample.json.gz', import.meta.url)
);

beforeEach(() => {
	mockRole = 'admin';
});

describe('TLS-RPT parsing (shared parser, never throws)', () => {
	it('gunzips + parses the checked-in real-world fixture with full fidelity', async () => {
		const result = await decodeTlsReport(new Uint8Array(fixtureGz));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report['report-id']).toBe('2026-07-11T00:00:00Z_owlat.example');
		expect(result.report.policies[0]?.policy['policy-type']).toBe('sts');
		const digest = digestTlsReport(result.report);
		expect(digest.successCount).toBe(4123);
		expect(digest.failureCount).toBe(7);
		expect(digest.policyDomain).toBe('owlat.example');
		expect(digest.failureTypeCounts).toContainEqual({
			type: 'starttls-not-supported',
			count: 5,
		});
	});

	it('rejects malformed JSON without throwing', () => {
		expect(parseTlsReport('not json {').ok).toBe(false);
		expect(parseTlsReport('{}').ok).toBe(false);
		expect(parseTlsReport(JSON.stringify({ 'report-id': 'x' })).ok).toBe(false);
	});

	it('rejects an oversized compressed payload without throwing', async () => {
		const tooBig = new Uint8Array(TLS_RPT_MAX_COMPRESSED_BYTES + 1);
		const result = await decodeTlsReport(tooBig);
		expect(result.ok).toBe(false);
	});

	it('rejects corrupt gzip bytes without throwing', async () => {
		const result = await decodeTlsReport(new Uint8Array([1, 2, 3, 4, 5]));
		expect(result.ok).toBe(false);
	});
});

describe('domains.tlsReports.ingest (idempotent)', () => {
	async function digestFixture(): Promise<TlsReportDigest> {
		const json = await gunzipTlsReport(new Uint8Array(fixtureGz));
		const parsed = parseTlsReport(json);
		if (!parsed.ok) throw new Error('fixture should parse');
		return digestTlsReport(parsed.report);
	}

	it('persists the fixture digest as a single row', async () => {
		const t = convexTest(schema, modules);
		const digest = await digestFixture();
		// `TlsReportDigest` is exactly the ingest args shape — pass it straight
		// through, as the HTTP handler does.
		const res = await t.mutation(internal.domains.tlsReports.ingest, digest);
		expect(res.deduped).toBe(false);
	});

	it('is idempotent on duplicate report-id (patched, not duplicated)', async () => {
		const t = convexTest(schema, modules);
		const digest = await digestFixture();
		const first = await t.mutation(internal.domains.tlsReports.ingest, digest);
		const second = await t.mutation(internal.domains.tlsReports.ingest, digest);
		expect(first.deduped).toBe(false);
		expect(second.deduped).toBe(true);
		expect(second.id).toBe(first.id);
	});

	it('does not conflate the same report-id from different organizations', async () => {
		const t = convexTest(schema, modules);
		const digest = await digestFixture();
		const first = await t.mutation(internal.domains.tlsReports.ingest, digest);
		const second = await t.mutation(internal.domains.tlsReports.ingest, {
			...digest,
			organizationName: 'Another Reporter',
		});
		expect(second.deduped).toBe(false);
		expect(second.id).not.toBe(first.id);
	});

	it('rejects invalid counters even when the internal mutation is called directly', async () => {
		const t = convexTest(schema, modules);
		const digest = await digestFixture();
		await expect(
			t.mutation(internal.domains.tlsReports.ingest, { ...digest, successCount: -1 })
		).rejects.toThrow('invalid counters');
	});
});

describe('domains.tlsReports.getTlsReportSummary (aggregation)', () => {
	const now = Date.now();

	it('rejects a non-admin member (editor) with forbidden', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'editor';
		const category = await t
			.withIdentity(identity)
			.query(api.domains.tlsReports.getTlsReportSummary, {})
			.then(() => undefined)
			.catch((e: { data?: { category?: string } }) => e?.data?.category);
		expect(category).toBe('forbidden');
	});

	it('allows an admin (empty summary when nothing ingested)', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		const summary = await t
			.withIdentity(identity)
			.query(api.domains.tlsReports.getTlsReportSummary, {});
		expect(summary.reportCount).toBe(0);
	});

	it('rolls up reporting organizations, failure types, and the daily trend', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.domains.tlsReports.ingest, {
			reportId: 'r-google',
			organizationName: 'Google',
			contactInfo: 'mailto:tls@google.com',
			policyDomain: 'owlat.example',
			rangeStartMs: now - 2 * 24 * 60 * 60 * 1000,
			rangeEndMs: now - 2 * 24 * 60 * 60 * 1000 + 1000,
			successCount: 90,
			failureCount: 10,
			failureTypeCounts: [{ type: 'starttls-not-supported', count: 10 }],
		});
		await t.mutation(internal.domains.tlsReports.ingest, {
			reportId: 'r-microsoft',
			organizationName: 'Microsoft',
			contactInfo: 'mailto:tls@microsoft.com',
			policyDomain: 'owlat.example',
			rangeStartMs: now - 1 * 24 * 60 * 60 * 1000,
			rangeEndMs: now - 1 * 24 * 60 * 60 * 1000 + 1000,
			successCount: 50,
			failureCount: 0,
			failureTypeCounts: [],
		});

		const summary = await t
			.withIdentity(identity)
			.query(api.domains.tlsReports.getTlsReportSummary, {});

		expect(summary.reportCount).toBe(2);
		expect(summary.totalSuccessCount).toBe(140);
		expect(summary.totalFailureCount).toBe(10);
		expect(summary.overallSuccessRate).toBeCloseTo(140 / 150, 5);

		const google = summary.reportingOrganizations.find(
			(reporter) => reporter.organizationName === 'Google'
		);
		expect(google?.successRate).toBeCloseTo(0.9, 5);
		const microsoft = summary.reportingOrganizations.find(
			(reporter) => reporter.organizationName === 'Microsoft'
		);
		expect(microsoft?.successRate).toBe(1);

		expect(summary.failureTypeCounts).toContainEqual({
			type: 'starttls-not-supported',
			count: 10,
		});
		expect(summary.trend.length).toBe(2);
	});

	it('excludes reports older than the 30-day window', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.domains.tlsReports.ingest, {
			reportId: 'r-old',
			organizationName: 'Old',
			contactInfo: '',
			policyDomain: 'stale.example',
			rangeStartMs: now - 40 * 24 * 60 * 60 * 1000,
			rangeEndMs: now - 40 * 24 * 60 * 60 * 1000 + 1000,
			successCount: 5,
			failureCount: 5,
			failureTypeCounts: [{ type: 'validation-failure', count: 5 }],
		});
		const summary = await t
			.withIdentity(identity)
			.query(api.domains.tlsReports.getTlsReportSummary, {});
		expect(summary.reportCount).toBe(0);
		expect(summary.overallSuccessRate).toBeNull();
	});
});
