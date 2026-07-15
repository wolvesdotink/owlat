/**
 * TLS-RPT symmetric round-trip (RFC 8460).
 *
 * The MTA *generates* aggregate TLS reports for domains we send to
 * (`smtp/tlsRpt.ts`); the shared parser (`@owlat/shared`) *ingests* the same
 * shape when other servers report to us. This test proves the two agree with
 * full fidelity: feed the real output of our own generator through gzip and
 * back out of the shared gunzip + parser, then assert nothing was lost.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { gzipSync } from 'zlib';
import { recordTlsResult, generateReport, buildStsPolicyString } from '../tlsRpt.js';
import { decodeTlsReport, parseTlsReport, digestTlsReport } from '@owlat/shared';

vi.mock('prom-client', () => {
	const metric = vi.fn(function () {
		return {
			inc: vi.fn(),
			set: vi.fn(),
			observe: vi.fn(),
			dec: vi.fn(),
			labels: vi.fn(() => ({ inc: vi.fn(), set: vi.fn(), observe: vi.fn() })),
		};
	});
	return {
		Counter: metric,
		Gauge: metric,
		Histogram: metric,
		Summary: metric,
		Registry: vi.fn(function () {
			return { registerMetric: vi.fn(), metrics: vi.fn() };
		}),
		register: { registerMetric: vi.fn() },
	};
});
vi.mock('../../monitoring/collector.js', () => ({
	registry: { registerMetric: vi.fn() },
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('TLS-RPT symmetric round-trip', () => {
	let redis: RealRedis;
	const today = new Date().toISOString().slice(0, 10);
	const domain = 'partner.example';

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});
	afterEach(async () => {
		await redis.flushall();
	});

	it('generator output gunzips + parses back with full fidelity', async () => {
		const stsPolicy = {
			policyType: 'sts' as const,
			policyString: buildStsPolicyString('enforce', ['mx.partner.example']),
			mxHostPatterns: ['mx.partner.example'],
		};
		// Record a mix of success + failures, exactly as the outbound sender does.
		for (let i = 0; i < 100; i++) {
			await recordTlsResult(redis, domain, 'success', 'mx.partner.example', '10.0.0.1', stsPolicy);
		}
		await recordTlsResult(
			redis,
			domain,
			'starttls-not-supported',
			'mx.partner.example',
			'10.0.0.1',
			stsPolicy
		);
		await recordTlsResult(
			redis,
			domain,
			'certificate-host-mismatch',
			'mx.partner.example',
			'10.0.0.1',
			stsPolicy
		);

		const report = await generateReport(redis, domain, today, 'owlat.example', 'tls@owlat.example');
		expect(report).not.toBeNull();
		if (!report) return;

		// The wire form the sender emits: gzip-compressed JSON.
		const gzipped = gzipSync(Buffer.from(JSON.stringify(report), 'utf8'));

		// Ingest via the shared parser — the reciprocal of the generator.
		const decoded = await decodeTlsReport(new Uint8Array(gzipped));
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;

		// Full-fidelity: every field survives the round-trip.
		expect(decoded.report['report-id']).toBe(report['report-id']);
		expect(decoded.report['organization-name']).toBe(report['organization-name']);
		expect(decoded.report.policies[0]?.policy['policy-type']).toBe('sts');
		expect(decoded.report.policies[0]?.policy['policy-string']).toEqual(
			report.policies[0]?.policy['policy-string']
		);
		expect(decoded.report.policies[0]?.summary).toEqual(report.policies[0]?.summary);

		// Digest matches the generator's own summary counts.
		const digest = digestTlsReport(decoded.report);
		expect(digest.successCount).toBe(100);
		expect(digest.failureCount).toBe(2);
		expect(digest.policyDomain).toBe(domain);
		expect(digest.failureTypeCounts).toContainEqual({
			type: 'starttls-not-supported',
			count: 1,
		});
		expect(digest.failureTypeCounts).toContainEqual({
			type: 'certificate-host-mismatch',
			count: 1,
		});
	});

	it('parses the uncompressed generator JSON identically', async () => {
		await recordTlsResult(redis, domain, 'success', 'mx.partner.example', '10.0.0.1');
		const report = await generateReport(redis, domain, today, 'owlat.example', 'tls@owlat.example');
		expect(report).not.toBeNull();
		if (!report) return;
		const parsed = parseTlsReport(JSON.stringify(report));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.report['report-id']).toBe(report['report-id']);
		expect(parsed.report.policies[0]?.policy['policy-type']).toBe('no-policy-found');
	});
});
