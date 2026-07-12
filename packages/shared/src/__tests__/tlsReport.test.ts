/**
 * TLS-RPT (RFC 8460) shared parser — the single source of truth for the report
 * schema, ingested identically by the MTA, the Convex backend and the web client.
 *
 * Asserts the never-throw contract: malformed, oversized, and corrupt inputs all
 * return a discriminated failure rather than raising; well-formed reports parse
 * and digest with full fidelity.
 */
import { gzipSync } from 'zlib';
import { describe, it, expect } from 'vitest';
import {
	parseTlsReport,
	decodeTlsReport,
	gunzipTlsReport,
	digestTlsReport,
	explainTlsFailureType,
	TLS_RPT_MAX_COMPRESSED_BYTES,
	type TlsRptReport,
} from '../tlsReport';

const report: TlsRptReport = {
	'organization-name': 'Example Reporter',
	'date-range': {
		'start-datetime': '2026-07-11T00:00:00Z',
		'end-datetime': '2026-07-11T23:59:59Z',
	},
	'contact-info': 'mailto:tls@example.com',
	'report-id': 'rpt-1',
	policies: [
		{
			policy: {
				'policy-type': 'sts',
				'policy-string': ['version: STSv1', 'mode: enforce'],
				'policy-domain': 'mx.owlat.example',
				'mx-host': ['mx.owlat.example'],
			},
			summary: { 'total-successful-session-count': 42, 'total-failure-session-count': 3 },
			'failure-details': [
				{
					'result-type': 'starttls-not-supported',
					'sending-mta-ip': '10.0.0.1',
					'receiving-mx-hostname': 'mx.owlat.example',
					'failed-session-count': 3,
				},
			],
		},
	],
};

describe('parseTlsReport', () => {
	it('parses a well-formed report with full fidelity', () => {
		const result = parseTlsReport(JSON.stringify(report));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report['report-id']).toBe('rpt-1');
		expect(result.report.policies[0]?.policy['mx-host']).toEqual(['mx.owlat.example']);
	});

	it('never throws on malformed input', () => {
		expect(parseTlsReport('{').ok).toBe(false);
		expect(parseTlsReport('[]').ok).toBe(false);
		expect(parseTlsReport('null').ok).toBe(false);
		expect(parseTlsReport(JSON.stringify({ 'report-id': 'x', policies: [] })).ok).toBe(false);
	});

	it('drops policy blocks with non-numeric session counts', () => {
		const bad = {
			...report,
			policies: [
				{ policy: report.policies[0]!.policy, summary: { 'total-successful-session-count': 'x' } },
			],
		};
		expect(parseTlsReport(JSON.stringify(bad)).ok).toBe(false);
	});
});

describe('gunzip + decode', () => {
	it('round-trips gzip → parse', async () => {
		const gz = gzipSync(Buffer.from(JSON.stringify(report)));
		const result = await decodeTlsReport(new Uint8Array(gz));
		expect(result.ok).toBe(true);
	});

	it('rejects oversized compressed payloads without throwing', async () => {
		const result = await decodeTlsReport(new Uint8Array(TLS_RPT_MAX_COMPRESSED_BYTES + 1));
		expect(result.ok).toBe(false);
	});

	it('gunzipTlsReport throws on oversized input (folded to failure by decode)', async () => {
		await expect(
			gunzipTlsReport(new Uint8Array(TLS_RPT_MAX_COMPRESSED_BYTES + 1))
		).rejects.toThrow();
	});
});

describe('digestTlsReport', () => {
	it('sums counts and failure types across policy blocks', () => {
		const digest = digestTlsReport(report);
		expect(digest.successCount).toBe(42);
		expect(digest.failureCount).toBe(3);
		expect(digest.policyDomain).toBe('mx.owlat.example');
		expect(digest.failureTypeCounts).toEqual([{ type: 'starttls-not-supported', count: 3 }]);
	});
});

describe('explainTlsFailureType', () => {
	it('maps known types to plain-language copy', () => {
		expect(explainTlsFailureType('starttls-not-supported')).toBe('STARTTLS stripped upstream');
		expect(explainTlsFailureType('certificate-host-mismatch')).toBe(
			"Certificate didn't match the server name"
		);
	});

	it('falls back to a readable form for unknown types', () => {
		expect(explainTlsFailureType('some-new-code')).toBe('some new code');
	});
});
