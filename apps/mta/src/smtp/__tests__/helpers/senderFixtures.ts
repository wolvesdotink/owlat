/**
 * Shared fixtures and per-test defaults for the `sendToMx` suites.
 *
 * Unlike {@link file://./senderHarness.ts} this module runs AFTER the mocks are
 * registered, so it may import the mocked modules and program their defaults.
 */

import { expect, vi, type Mock } from 'vitest';
import { SmtpError, type SmtpErrorInit } from '@owlat/smtp-client';
import type { EmailJob } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';
import type { TLSSocket } from 'node:tls';
import { getStsTlsOptions } from '../../mtaSts.js';
import { generateReport } from '../../tlsRpt.js';
import { resolveMxDestination } from '../../mxResolver.js';
import { resolveDaneMxDestinations } from '../../daneMxResolver.js';
import { lookupTlsaRecords } from '../../daneResolver.js';
import { createOwlatHostConfig, createOwlatJob } from '../../../__tests__/helpers/fixtures.js';
import { DEFAULT_MX_HOSTS, type SenderHarness } from './senderHarness.js';

export const createJob = (overrides: Partial<EmailJob> = {}): EmailJob =>
	createOwlatJob({ messageId: 'msg-001', ...overrides });

export const createConfig = (overrides: Partial<MtaConfig> = {}): MtaConfig =>
	createOwlatHostConfig({ mtaSecret: 'test-mta-secret-at-least-32-bytes-long!!', ...overrides });

/** A fresh live-connection stub whose `secured` flag the test controls. */
export function liveConn(secured = true): { secured: boolean; close: ReturnType<typeof vi.fn> } {
	return { secured, close: vi.fn() };
}

/** A real SmtpReply-shaped final response for a successful send. */
export function okReply(text = '2.0.0 OK'): { code: number; text: string; lines: string[] } {
	return { code: 250, text, lines: [text] };
}

/** A structured SmtpError, exactly as the client throws. */
export function smtpError(init: SmtpErrorInit): SmtpError {
	return new SmtpError(init);
}

/**
 * The happy path every suite starts each test from: two deliverable MX hosts,
 * DNSSEC-secure DANE discovery with no TLSA record, no MTA-STS policy, a valid
 * IP lease, a secured connection and an accepted send.
 */
export function installSenderDefaults(harness: SenderHarness): void {
	vi.mocked(resolveMxDestination).mockResolvedValue({
		status: 'deliverable',
		source: 'mx',
		hosts: [...DEFAULT_MX_HOSTS],
	});
	vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
		status: 'destinations',
		destinations: [
			{
				mxHostname: 'mx1.example.com',
				preference: 10,
				mxSecurity: 'secure',
				addressSecurity: 'secure',
				addresses: ['192.0.2.1'],
			},
			{
				mxHostname: 'mx2.example.com',
				preference: 20,
				mxSecurity: 'secure',
				addressSecurity: 'secure',
				addresses: ['192.0.2.2'],
			},
		],
	});
	vi.mocked(lookupTlsaRecords).mockResolvedValue({ status: 'no-tlsa' });
	// Default acquire echoes the resolved connect config so assertions can read
	// it back; no live socket is ever opened.
	harness.acquireMock.mockImplementation(
		(
			mxHost: string,
			bindIp: string,
			options: { name?: string; requireTLS?: boolean; tls?: unknown }
		) => ({
			key: `${mxHost}:${bindIp}`,
			config: {
				host: mxHost,
				port: 25,
				ehloName: options.name,
				tlsMode: 'starttls',
				requireTls: options.requireTLS ?? false,
				localAddress: bindIp,
				tls: options.tls,
			},
		})
	);
	// Default happy path: secured connection, accepted send, clean quit.
	harness.connectMock.mockResolvedValue(liveConn(true));
	harness.sendEnvelopeMock.mockResolvedValue({ accepted: [], rejected: [], response: okReply() });
	harness.quitMock.mockResolvedValue(undefined);
	harness.leaseValidMock.mockResolvedValue(true);
	vi.mocked(getStsTlsOptions).mockResolvedValue({
		requireTLS: false,
		rejectUnauthorized: false,
		allowedMxHosts: [],
		policyMode: 'none',
	});
}

/** The acquire options (3rd arg) the sender passed on a given acquire call. */
export interface AcquireOptionsSnapshot {
	name?: string;
	requireTLS?: boolean;
	connectionLimits?: {
		scope: string;
		maxConnections: number;
		maxDeliveriesPerConnection: number;
	};
	tls?: {
		rejectUnauthorized?: boolean;
		minVersion?: string;
		verifyPeerCertificate?: (s: TLSSocket) => Error | undefined;
		danePolicyFingerprint?: string;
		checkServerIdentity?: unknown;
	};
}

export function acquireCallOptions(acquireMock: Mock, call = 0): AcquireOptionsSnapshot {
	return acquireMock.mock.calls[call]![2] as AcquireOptionsSnapshot;
}

/**
 * recordTlsResult is fire-and-forget in the sender, so flush the microtask
 * queue before reading what landed in the (mock) Redis, then read the day's
 * aggregate back through the real generateReport (RFC 8460 §3/§4.3/§4.4).
 */
export async function tlsRptReportFor(
	redis: unknown
): Promise<NonNullable<Awaited<ReturnType<typeof generateReport>>>> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	const today = new Date().toISOString().split('T')[0]!;
	const report = await generateReport(
		redis as Parameters<typeof generateReport>[0],
		'example.com',
		today,
		'Owlat MTA',
		'postmaster@owlat.com'
	);
	expect(report).not.toBeNull();
	return report!;
}
