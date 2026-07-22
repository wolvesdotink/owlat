import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { gunzipSync } from 'zlib';
import {
	recordTlsResult,
	generateReport,
	generateAndSendReports,
	buildStsPolicyString,
} from '../tlsRpt.js';
import type { TlsRptQueue, TlsResultType } from '../tlsRpt.js';
import type { EmailJob } from '../../types.js';
import type { SmtpTlsCause } from '@owlat/smtp-client';
import { classifyTlsFailure, stsAttributedResultType } from '../tlsFailureClassification.js';
import { promoteIntakeReceipt } from '../../routes/sendReceipt.js';

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('dns/promises', () => ({ resolve: resolveMock }));

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

describe('tlsRpt', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		resolveMock.mockReset();
	});

	afterEach(async () => {
		await redis.flushall();
	});

	describe('recordTlsResult', () => {
		it('records successful TLS connections', async () => {
			await recordTlsResult(redis, 'example.com', 'success', 'mx.example.com', '10.0.0.1');

			const today = new Date().toISOString().split('T')[0]!;
			const key = `mta:tls-rpt:example.com:${today}`;
			const successes = await redis.hget(key, 'successes');
			expect(successes).toBe('1');
		});

		it('records TLS failures with details', async () => {
			await recordTlsResult(
				redis,
				'example.com',
				'certificate-expired',
				'mx.example.com',
				'10.0.0.1'
			);

			const today = new Date().toISOString().split('T')[0]!;
			const key = `mta:tls-rpt:example.com:${today}`;
			const failures = await redis.hget(key, 'failures');
			expect(failures).toBe('1');

			const typeFailures = await redis.hget(key, 'fail:certificate-expired');
			expect(typeFailures).toBe('1');
		});

		it('accumulates multiple results', async () => {
			await recordTlsResult(redis, 'example.com', 'success', 'mx.example.com', '10.0.0.1');
			await recordTlsResult(redis, 'example.com', 'success', 'mx.example.com', '10.0.0.1');
			await recordTlsResult(
				redis,
				'example.com',
				'starttls-not-supported',
				'mx2.example.com',
				'10.0.0.1'
			);

			const today = new Date().toISOString().split('T')[0]!;
			const key = `mta:tls-rpt:example.com:${today}`;
			const successes = await redis.hget(key, 'successes');
			const failures = await redis.hget(key, 'failures');
			expect(successes).toBe('2');
			expect(failures).toBe('1');
		});
	});

	describe('generateReport', () => {
		it('generates a valid TLS-RPT report', async () => {
			const today = new Date().toISOString().split('T')[0]!;

			// Record some results
			await recordTlsResult(redis, 'example.com', 'success', 'mx.example.com', '10.0.0.1');
			await recordTlsResult(redis, 'example.com', 'success', 'mx.example.com', '10.0.0.1');
			await recordTlsResult(
				redis,
				'example.com',
				'certificate-expired',
				'mx2.example.com',
				'10.0.0.2'
			);

			const report = await generateReport(
				redis,
				'example.com',
				today,
				'Owlat MTA',
				'postmaster@owlat.com'
			);

			expect(report).not.toBeNull();
			expect(report!['organization-name']).toBe('Owlat MTA');
			expect(report!.policies).toHaveLength(1);
			expect(report!.policies[0]!.summary['total-successful-session-count']).toBe(2);
			expect(report!.policies[0]!.summary['total-failure-session-count']).toBe(1);
		});

		it('returns null for domains with no data', async () => {
			const report = await generateReport(
				redis,
				'nodomain.com',
				'2024-01-01',
				'Owlat MTA',
				'postmaster@owlat.com'
			);

			expect(report).toBeNull();
		});

		// ── Regression lock: per-domain-per-day aggregation (RFC 8460 §4) ──
		// 2 successes + 1 certificate-expired (mx2) + 2 starttls-not-supported (mx3)
		// must aggregate to: total-successful = 2, total-failure = 3, with two
		// distinct failure-detail entries carrying the right result-type/mx/count.
		it('aggregates successes and per-type/per-mx failures correctly', async () => {
			const today = new Date().toISOString().split('T')[0]!;

			await recordTlsResult(redis, 'example.com', 'success', 'mx1.example.com', '10.0.0.1');
			await recordTlsResult(redis, 'example.com', 'success', 'mx1.example.com', '10.0.0.1');
			await recordTlsResult(
				redis,
				'example.com',
				'certificate-expired',
				'mx2.example.com',
				'10.0.0.2'
			);
			await recordTlsResult(
				redis,
				'example.com',
				'starttls-not-supported',
				'mx3.example.com',
				'10.0.0.3'
			);
			await recordTlsResult(
				redis,
				'example.com',
				'starttls-not-supported',
				'mx3.example.com',
				'10.0.0.3'
			);

			const report = await generateReport(
				redis,
				'example.com',
				today,
				'Owlat MTA',
				'postmaster@owlat.com'
			);

			expect(report).not.toBeNull();

			const policy = report!.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(2);
			expect(policy.summary['total-failure-session-count']).toBe(3);

			const details = policy['failure-details']!;
			expect(details).toHaveLength(2);

			const expired = details.find((d) => d['result-type'] === 'certificate-expired');
			expect(expired).toBeDefined();
			expect(expired!['receiving-mx-hostname']).toBe('mx2.example.com');
			expect(expired!['sending-mta-ip']).toBe('10.0.0.2');
			expect(expired!['failed-session-count']).toBe(1);

			const starttls = details.find((d) => d['result-type'] === 'starttls-not-supported');
			expect(starttls).toBeDefined();
			expect(starttls!['receiving-mx-hostname']).toBe('mx3.example.com');
			expect(starttls!['sending-mta-ip']).toBe('10.0.0.3');
			expect(starttls!['failed-session-count']).toBe(2);
		});

		it('uses UTC day bounds for the date-range and a non-empty report-id', async () => {
			const today = new Date().toISOString().split('T')[0]!;
			await recordTlsResult(redis, 'example.com', 'success', 'mx1.example.com', '10.0.0.1');

			const r = await generateReport(
				redis,
				'example.com',
				today,
				'Owlat MTA',
				'postmaster@owlat.com'
			);
			expect(r).not.toBeNull();
			expect(r!['date-range']['start-datetime']).toBe(`${today}T00:00:00.000Z`);
			expect(r!['date-range']['end-datetime']).toBe(`${today}T23:59:59.000Z`);
			expect(r!['report-id']).toBeTruthy();
			expect(r!['report-id'].length).toBeGreaterThan(0);
		});
	});

	// ── PR-31 fix: real policy-type 'sts' + STS-specific result types ──
	// RFC 8460 §3/§4.4. Before the fix recordTlsResult ignored policy context and
	// generateReport hardcoded 'no-policy-found', so STS enforcement was invisible
	// in our own reports and the declared sts-* result types were never produced.
	describe('MTA-STS policy context (RFC 8460 §3/§4.4)', () => {
		const stsContext = {
			policyType: 'sts' as const,
			policyString: ['version: STSv1', 'mode: enforce', 'mx: *.example.com'],
			mxHostPatterns: ['*.example.com'],
		};

		it('persists the STS policy context so generateReport emits policy-type "sts" with the policy-string and mx-host', async () => {
			const today = new Date().toISOString().split('T')[0]!;

			await recordTlsResult(
				redis,
				'example.com',
				'success',
				'mx.example.com',
				'10.0.0.1',
				stsContext
			);
			await recordTlsResult(
				redis,
				'example.com',
				'sts-webpki-invalid',
				'mx2.example.com',
				'10.0.0.2',
				stsContext
			);

			const report = await generateReport(
				redis,
				'example.com',
				today,
				'Owlat MTA',
				'postmaster@owlat.com'
			);
			expect(report).not.toBeNull();

			const policy = report!.policies[0]!.policy;
			expect(policy['policy-type']).toBe('sts');
			expect(policy['policy-string']).toEqual(stsContext.policyString);
			expect(policy['mx-host']).toEqual(['*.example.com']);
			expect(policy['policy-domain']).toBe('example.com');

			// The STS-specific failure result-type is carried through to the report.
			const details = report!.policies[0]!['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'sts-webpki-invalid')).toBeDefined();
		});

		it('falls back to "no-policy-found" with an empty policy-string when no STS context was recorded', async () => {
			const today = new Date().toISOString().split('T')[0]!;
			await recordTlsResult(redis, 'plain.com', 'success', 'mx.plain.com', '10.0.0.1');

			const report = await generateReport(
				redis,
				'plain.com',
				today,
				'Owlat MTA',
				'postmaster@owlat.com'
			);
			const policy = report!.policies[0]!.policy;
			expect(policy['policy-type']).toBe('no-policy-found');
			expect(policy['policy-string']).toEqual([]);
			expect(policy['mx-host']).toBeUndefined();
		});

		it('records the sts-policy-invalid result type (enforce MX not in policy)', async () => {
			const today = new Date().toISOString().split('T')[0]!;
			await recordTlsResult(
				redis,
				'example.com',
				'sts-policy-invalid',
				'rogue.example.net',
				'10.0.0.1',
				stsContext
			);

			const key = `mta:tls-rpt:example.com:${today}`;
			expect(await redis.hget(key, 'fail:sts-policy-invalid')).toBe('1');

			const report = await generateReport(
				redis,
				'example.com',
				today,
				'Owlat MTA',
				'postmaster@owlat.com'
			);
			const details = report!.policies[0]!['failure-details']!;
			const invalid = details.find((d) => d['result-type'] === 'sts-policy-invalid');
			expect(invalid).toBeDefined();
			expect(invalid!['receiving-mx-hostname']).toBe('rogue.example.net');
			expect(report!.policies[0]!.policy['policy-type']).toBe('sts');
		});

		it('buildStsPolicyString reconstructs the RFC 8461 §3.2 policy body', () => {
			expect(buildStsPolicyString('enforce', ['*.google.com', 'mail.google.com'])).toEqual([
				'version: STSv1',
				'mode: enforce',
				'mx: *.google.com',
				'mx: mail.google.com',
			]);
			expect(buildStsPolicyString('testing', [])).toEqual(['version: STSv1', 'mode: testing']);
		});
	});

	// ── PR-31: STS result-type escalation (RFC 8460 §4.4) ──
	describe('stsAttributedResultType', () => {
		it('keeps the generic result type when no STS policy is in force', () => {
			expect(stsAttributedResultType('certificate-host-mismatch', 'none')).toBe(
				'certificate-host-mismatch'
			);
			expect(stsAttributedResultType('starttls-not-supported', 'none')).toBe(
				'starttls-not-supported'
			);
		});

		it('escalates a cert/WebPKI failure to sts-webpki-invalid under enforce', () => {
			expect(stsAttributedResultType('certificate-host-mismatch', 'enforce')).toBe(
				'sts-webpki-invalid'
			);
			expect(stsAttributedResultType('certificate-expired', 'enforce')).toBe('sts-webpki-invalid');
			expect(stsAttributedResultType('certificate-not-trusted', 'enforce')).toBe(
				'sts-webpki-invalid'
			);
			expect(stsAttributedResultType('validation-failure', 'enforce')).toBe('sts-webpki-invalid');
		});

		it('escalates a STARTTLS-stripping / other TLS failure to sts-policy-invalid under enforce', () => {
			expect(stsAttributedResultType('starttls-not-supported', 'enforce')).toBe(
				'sts-policy-invalid'
			);
		});

		it('escalates under testing mode too (report-only days surface the same failures)', () => {
			expect(stsAttributedResultType('starttls-not-supported', 'testing')).toBe(
				'sts-policy-invalid'
			);
			expect(stsAttributedResultType('certificate-host-mismatch', 'testing')).toBe(
				'sts-webpki-invalid'
			);
		});
	});

	// ── Regression lock + fix: continuous reporting (RFC 8460 §4.1) ──
	describe('generateAndSendReports', () => {
		const yesterday = new Date(Date.now() - 86400_000).toISOString().split('T')[0]!;

		// recordTlsResult always writes to *today*; the cron reads *yesterday*.
		// Seed yesterday's hash + failure list directly, mirroring recordTlsResult.
		async function recordTlsResultYesterday(
			domain: string,
			type: string,
			mxHost: string,
			sendingIp: string
		) {
			const key = `mta:tls-rpt:${domain}:${yesterday}`;
			await redis.hincrby(key, 'failures', 1);
			await redis.hincrby(key, `fail:${type}`, 1);
			await redis.rpush(
				`${key}:failures`,
				JSON.stringify({ type, mxHost, sendingIp, timestamp: Date.now() })
			);
		}

		function dnsWithRua(ruaByDomain: Record<string, string>) {
			resolveMock.mockImplementation(async (name: string, type: string) => {
				if (type === 'TXT') {
					const m = name.match(/^_smtp\._tls\.(.+)$/);
					const domain = m?.[1];
					const rua = domain ? ruaByDomain[domain] : undefined;
					if (!rua) {
						const err = new Error('ENOTFOUND') as Error & { code: string };
						err.code = 'ENOTFOUND';
						throw err;
					}
					return [[`v=TLSRPTv1; rua=${rua}`]];
				}
				return [];
			});
		}

		it('sends a report on a success-only day (no failures) — RFC 8460 §4.1', async () => {
			// Seed yesterday with successes only, no failures.
			const key = `mta:tls-rpt:example.com:${yesterday}`;
			await redis.hincrby(key, 'successes', 3);

			dnsWithRua({ 'example.com': 'https://tls-reports.example.com/ingest' });

			const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
			vi.stubGlobal('fetch', fetchMock);

			const stats = await generateAndSendReports(redis, 'Owlat MTA', 'postmaster@owlat.com');

			expect(stats.sent).toBe(1);
			expect(stats.skipped).toBe(0);
			expect(stats.errors).toBe(0);
			expect(fetchMock).toHaveBeenCalledTimes(1);

			// RFC 8460 §3: the HTTPS body is gzip-compressed JSON, not raw JSON.
			const init = fetchMock.mock.calls[0]![1] as RequestInit;
			const body = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8'));
			expect(body.policies[0].summary['total-successful-session-count']).toBe(3);
			expect(body.policies[0].summary['total-failure-session-count']).toBe(0);

			vi.unstubAllGlobals();
		});

		// ── Fix (PR-32): RFC 8460 §3 — HTTPS body MUST be gzip-compressed JSON ──
		it('gzip-compresses the HTTPS POST body with application/tlsrpt+gzip', async () => {
			const key = `mta:tls-rpt:example.com:${yesterday}`;
			await redis.hincrby(key, 'successes', 2);
			await recordTlsResultYesterday(
				'example.com',
				'certificate-expired',
				'mx2.example.com',
				'10.0.0.2'
			);

			dnsWithRua({ 'example.com': 'https://tls-reports.example.com/ingest' });

			const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
			vi.stubGlobal('fetch', fetchMock);

			const stats = await generateAndSendReports(redis, 'Owlat MTA', 'postmaster@owlat.com');
			expect(stats.sent).toBe(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);

			const init = fetchMock.mock.calls[0]![1] as RequestInit;
			// Content-Type advertises gzip…
			expect((init.headers as Record<string, string>)['Content-Type']).toBe(
				'application/tlsrpt+gzip'
			);

			// …and the body actually IS gzip — raw JSON.parse would throw, but
			// gunzip then parse must yield the same report generateReport produced.
			const decoded = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8'));
			const expected = await generateReport(
				redis,
				'example.com',
				yesterday,
				'Owlat MTA',
				'postmaster@owlat.com'
			);
			expect(decoded).toEqual(expected);

			vi.unstubAllGlobals();
		});

		// ── Fix (PR-32): RFC 8460 §5.3 — mailto: delivery enqueues an MTA message ──
		it('enqueues exactly one MTA message for a mailto: rua with a gzip attachment', async () => {
			const key = `mta:tls-rpt:example.com:${yesterday}`;
			await redis.hincrby(key, 'successes', 5);
			await recordTlsResultYesterday(
				'example.com',
				'starttls-not-supported',
				'mx.example.com',
				'10.0.0.9'
			);

			dnsWithRua({ 'example.com': 'mailto:tls-reports@example.com' });

			const added: Array<{ groupId: string; data: EmailJob; jobId?: string }> = [];
			const queue: TlsRptQueue = {
				add: vi.fn(async (opts) => {
					added.push(opts);
					return { id: opts.jobId ?? 'generated-id' };
				}),
				getJob: vi.fn(async () => null),
			};

			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);

			const stats = await generateAndSendReports(redis, 'Owlat MTA', 'postmaster@owlat.com', queue);

			// Counted as sent (not skipped), no HTTPS POST.
			expect(stats.sent).toBe(1);
			expect(stats.skipped).toBe(0);
			expect(stats.errors).toBe(0);
			expect(fetchMock).not.toHaveBeenCalled();

			// Exactly one MTA message enqueued.
			expect(added).toHaveLength(1);
			const job = added[0]!.data;
			expect(added[0]!.jobId).toBe(job.intakeReceiptId);
			await promoteIntakeReceipt(redis as never, job);
			expect(await redis.get(`mta:work-attempts:${job.intakeReceiptId}`)).toContain(
				'"state":"accepted"'
			);

			expect(job.to).toBe('tls-reports@example.com');
			expect(job.subject).toMatch(/^Report Domain: example.com Submitter: /);

			// An application/tlsrpt+gzip part whose gunzipped JSON equals the report.
			expect(job.attachments).toHaveLength(1);
			const part = job.attachments![0]!;
			expect(part.contentType).toBe('application/tlsrpt+gzip');
			const decoded = JSON.parse(
				gunzipSync(Buffer.from(part.contentBase64, 'base64')).toString('utf8')
			);
			const expected = await generateReport(
				redis,
				'example.com',
				yesterday,
				'Owlat MTA',
				'postmaster@owlat.com'
			);
			expect(decoded).toEqual(expected);

			vi.unstubAllGlobals();
		});

		it('reconciles a lost mailto enqueue response under one semantic report id', async () => {
			const key = `mta:tls-rpt:example.com:${yesterday}`;
			await redis.hincrby(key, 'successes', 1);
			dnsWithRua({ 'example.com': 'mailto:tls-reports@example.com' });
			const committed = new Map<string, unknown>();
			const queue: TlsRptQueue = {
				add: vi.fn(async (opts) => {
					committed.set(opts.jobId!, opts);
					throw new Error('queue response lost');
				}),
				getJob: vi.fn(async (jobId) => committed.get(jobId) ?? null),
			};

			const first = await generateAndSendReports(redis, 'Owlat MTA', 'postmaster@owlat.com', queue);
			const second = await generateAndSendReports(
				redis,
				'Owlat MTA',
				'postmaster@owlat.com',
				queue
			);

			expect(first.sent).toBe(1);
			expect(second.sent).toBe(1);
			expect(queue.add).toHaveBeenCalledOnce();
			expect(queue.add.mock.calls[0]![0].jobId).toMatch(/^tlsrpt-[0-9a-f]{64}$/);
		});

		it('skips a mailto: rua when no send queue is available', async () => {
			const key = `mta:tls-rpt:example.com:${yesterday}`;
			await redis.hincrby(key, 'successes', 1);

			dnsWithRua({ 'example.com': 'mailto:tls-reports@example.com' });

			const stats = await generateAndSendReports(redis, 'Owlat MTA', 'postmaster@owlat.com');
			expect(stats.sent).toBe(0);
			expect(stats.skipped).toBe(1);
			expect(stats.errors).toBe(0);
		});

		it('skips domains with no session activity at all', async () => {
			// A stray empty hash should not produce a report.
			const key = `mta:tls-rpt:empty.com:${yesterday}`;
			await redis.hset(key, 'placeholder', 'x');

			dnsWithRua({ 'empty.com': 'https://tls-reports.empty.com/ingest' });

			const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
			vi.stubGlobal('fetch', fetchMock);

			const stats = await generateAndSendReports(redis, 'Owlat MTA', 'postmaster@owlat.com');

			expect(stats.sent).toBe(0);
			expect(stats.skipped).toBe(1);
			expect(fetchMock).not.toHaveBeenCalled();

			vi.unstubAllGlobals();
		});
	});

	// ── Regression lock: the thin SmtpTlsCause -> TLS-RPT result-type map (RFC 8460 §4) ──
	// The @owlat/smtp-client engine classifies every TLS/handshake failure at the
	// source into a structured SmtpTlsCause; classifyTlsFailure is the total map
	// from that discriminant onto the TLS-RPT result type — no string sniffing.
	describe('classifyTlsFailure', () => {
		const cases: Array<[SmtpTlsCause, TlsResultType]> = [
			['starttls-unavailable', 'starttls-not-supported'],
			['cert-expired', 'certificate-expired'],
			['cert-host-mismatch', 'certificate-host-mismatch'],
			['cert-untrusted', 'certificate-not-trusted'],
			['handshake', 'validation-failure'],
		];

		for (const [cause, expected] of cases) {
			it(`${cause} -> ${expected}`, () => {
				expect(classifyTlsFailure(cause)).toBe(expected);
			});
		}
	});
});
