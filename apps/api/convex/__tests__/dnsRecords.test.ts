/**
 * Tests for the operator's own TLS-RPT (`_smtp._tls`) record generation and the
 * TLSA extension of the DNS-record model. See audit item PR-65.
 *
 * Three concerns:
 *  1. `buildTlsRptRecordValue` (pure) — emits `v=TLSRPTv1; rua=…` only when a
 *     reporting destination is configured (RFC 8460 §3).
 *  2. `mtaProvider.registerDomain` — adds a `_smtp._tls` TXT record when
 *     `MTA_TLSRPT_RUA` is set, and omits it otherwise.
 *  3. `dnsRecordValidator` (via the `domains` schema) — accepts a `TLSA` record
 *     (RFC 6698) with `usage`/`selector`/`matchingType` parameters.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { buildTlsRptRecordValue, TLSRPT_HOST } from '../domains/tlsRpt';

// Mock the MTA identity manager so `registerDomain` does not hit the network —
// it returns a fixed DKIM selector + record, the same shape the real MTA emits.
vi.mock('../lib/emailProviders/mtaIdentity', () => ({
	createMtaIdentityManager: () => ({
		registerDomain: vi.fn().mockResolvedValue({
			selector: 'owlat',
			dnsRecord: 'v=DKIM1; k=rsa; p=MIGfMA0',
		}),
		deleteDomain: vi.fn().mockResolvedValue(undefined),
	}),
}));

// Import after the mock is registered.
import { mtaProvider } from '../domains/providers/mta';

const modules = import.meta.glob('../**/*.*s');

describe('buildTlsRptRecordValue', () => {
	it('returns undefined when no reporting destination is configured', () => {
		expect(buildTlsRptRecordValue()).toBeUndefined();
		expect(buildTlsRptRecordValue(undefined)).toBeUndefined();
	});

	it('returns undefined for an empty or whitespace-only destination', () => {
		expect(buildTlsRptRecordValue('')).toBeUndefined();
		expect(buildTlsRptRecordValue('   ')).toBeUndefined();
	});

	it('emits v=TLSRPTv1; rua=<uri> when a destination is configured', () => {
		const value = buildTlsRptRecordValue('mailto:tls-reports@owlat.example');
		expect(value).toBe('v=TLSRPTv1; rua=mailto:tls-reports@owlat.example');
		expect(value).toMatch(/^v=TLSRPTv1;\s*rua=/);
	});

	it('trims surrounding whitespace from the destination', () => {
		expect(buildTlsRptRecordValue('  https://owlat.example/tlsrpt  ')).toBe(
			'v=TLSRPTv1; rua=https://owlat.example/tlsrpt',
		);
	});
});

describe('mtaProvider.registerDomain — TLS-RPT (_smtp._tls)', () => {
	beforeEach(() => {
		// Ensure unrelated optional records do not interfere with the assertions.
		vi.stubEnv('MTA_SPF_INCLUDE', '');
		vi.stubEnv('MTA_DMARC_RUA', '');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('emits a _smtp._tls TXT record when MTA_TLSRPT_RUA is set', async () => {
		vi.stubEnv('MTA_TLSRPT_RUA', 'mailto:tls-reports@owlat.example');

		const { dnsRecords } = await mtaProvider.registerDomain('example.com');

		expect(dnsRecords.tlsRpt).toBeDefined();
		expect(dnsRecords.tlsRpt!.type).toBe('TXT');
		expect(dnsRecords.tlsRpt!.host).toBe('_smtp._tls');
		expect(dnsRecords.tlsRpt!.host).toBe(TLSRPT_HOST);
		expect(dnsRecords.tlsRpt!.value).toMatch(/^v=TLSRPTv1;\s*rua=/);
		expect(dnsRecords.tlsRpt!.value).toBe('v=TLSRPTv1; rua=mailto:tls-reports@owlat.example');
	});

	it('omits the _smtp._tls record when MTA_TLSRPT_RUA is unset', async () => {
		vi.stubEnv('MTA_TLSRPT_RUA', '');

		const { dnsRecords } = await mtaProvider.registerDomain('example.com');

		expect(dnsRecords.tlsRpt).toBeUndefined();
		// DKIM + DMARC are still emitted regardless.
		expect(dnsRecords.dkim).toBeDefined();
		expect(dnsRecords.dmarc).toBeDefined();
	});
});

describe('dnsRecordValidator — TLSA (DANE, RFC 6698)', () => {
	it('accepts a TLSA record with usage/selector/matching-type', async () => {
		const t = convexTest(schema, modules);

		// Drive the schema's `dnsRecordsValidator` → `dnsRecordValidator` through a
		// real insert; convex-test validates the document against the schema.
		const domainId = await t.run(async (ctx) =>
			ctx.db.insert('domains', {
				domain: 'example.com',
				status: 'pending',
				dnsRecords: {
					tlsRpt: {
						type: 'TLSA',
						host: '_25._tcp',
						value: '3 1 1 0123456789abcdef',
						usage: 3,
						selector: 1,
						matchingType: 1,
					},
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		const stored = await t.run(async (ctx) => ctx.db.get(domainId));
		expect(stored!.dnsRecords.tlsRpt!.type).toBe('TLSA');
		expect(stored!.dnsRecords.tlsRpt!.host).toBe('_25._tcp');
		expect(stored!.dnsRecords.tlsRpt!.value).toBe('3 1 1 0123456789abcdef');
	});

	it('accepts a minimal TLSA record where the value carries the full payload', async () => {
		const t = convexTest(schema, modules);

		const domainId = await t.run(async (ctx) =>
			ctx.db.insert('domains', {
				domain: 'tlsa-minimal.example',
				status: 'pending',
				dnsRecords: {
					tlsRpt: {
						type: 'TLSA',
						host: '_25._tcp',
						value: '3 1 1 abcdef',
					},
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		const stored = await t.run(async (ctx) => ctx.db.get(domainId));
		expect(stored!.dnsRecords.tlsRpt!.type).toBe('TLSA');
	});
});
