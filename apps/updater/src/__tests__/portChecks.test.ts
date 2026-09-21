import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * POST /port-checks — the probe behind the admin card that tells an operator
 * which of the ports their features need are actually open.
 *
 * The invariants under test: the same auth + rate-limit shape as its siblings
 * (a probe that opens ten connections to third parties must never be
 * reachable unauthenticated), the relevance derived from the host `.env`
 * rather than from the caller, and the mapping every verdict depends on —
 * dropped traffic reads as `blocked`, a refusal as `refused`, and an inbound
 * service that is not deployed as `skipped` rather than as a failure.
 */

const { probeTcpMock, probeDnsMock, rateLimitedMock } = vi.hoisted(() => ({
	probeTcpMock: vi.fn(),
	probeDnsMock: vi.fn(),
	rateLimitedMock: vi.fn((_endpoint: string) => false),
}));
vi.mock('../portProbe.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../portProbe.js')>();
	return { ...actual, probeTcp: probeTcpMock, probeDns: probeDnsMock };
});
vi.mock('../security.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../security.js')>();
	return { ...actual, isRateLimited: rateLimitedMock };
});

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-port-checks-test-'));
process.env['INSTANCE_SECRET'] = 'test-instance-secret-0123456789';
process.env['OWLAT_DIR'] = OWLAT_DIR;
process.env['PORT'] = '0';

const { buildRequestListener } = await import('../server.js');

let server: Server;
let base: string;

beforeAll(async () => {
	server = createServer(buildRequestListener());
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const addr = server.address();
	if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

const ENV_FILE = join(OWLAT_DIR, '.env');
const AUTH = { 'x-instance-secret': 'test-instance-secret-0123456789' };

beforeEach(() => {
	rateLimitedMock.mockReturnValue(false);
	probeTcpMock.mockReset().mockResolvedValue({ status: 'open', durationMs: 4 });
	probeDnsMock.mockReset().mockResolvedValue({ status: 'open', durationMs: 7 });
	writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=mta\nCOMPOSE_PROFILES=mta,tls\n');
});

interface CheckRow {
	id: string;
	direction: 'inbound' | 'outbound';
	port: number;
	relevance: 'required' | 'optional';
	status: string;
	durationMs: number;
}
interface Body {
	verdict: string;
	checkedAt: number;
	checks: CheckRow[];
}

function post(headers: Record<string, string> = AUTH) {
	return fetch(`${base}/port-checks`, { method: 'POST', headers });
}

async function checks(): Promise<Body> {
	const res = await post();
	expect(res.status).toBe(200);
	return (await res.json()) as Body;
}

function row(body: Body, id: string): CheckRow {
	const found = body.checks.find((check) => check.id === id);
	if (!found) throw new Error(`no check ${id}`);
	return found;
}

describe('auth + rate limit', () => {
	it('rejects a missing instance secret with 401 and probes nothing', async () => {
		const res = await post({});
		expect(res.status).toBe(401);
		expect(probeTcpMock).not.toHaveBeenCalled();
	});

	it('rejects a wrong instance secret with 401', async () => {
		const res = await post({ 'x-instance-secret': 'wrong-but-long-enough-000000' });
		expect(res.status).toBe(401);
		expect(probeTcpMock).not.toHaveBeenCalled();
	});

	it('returns 429 when rate limited, before opening a socket', async () => {
		rateLimitedMock.mockImplementation((endpoint: string) => endpoint === 'port-checks');
		const res = await post();
		expect(res.status).toBe(429);
		expect(probeTcpMock).not.toHaveBeenCalled();
	});

	it('is not reachable over GET', async () => {
		const res = await fetch(`${base}/port-checks`, { method: 'GET', headers: AUTH });
		expect(res.status).toBe(404);
		expect(probeTcpMock).not.toHaveBeenCalled();
	});
});

describe('relevance comes from the host .env', () => {
	it('requires the direct-delivery ports for a built-in-MTA instance', async () => {
		const body = await checks();
		expect(row(body, 'outbound-smtp').relevance).toBe('required');
		expect(row(body, 'inbound-smtp').relevance).toBe('required');
		expect(row(body, 'inbound-http').relevance).toBe('required');
		// No external mailboxes configured here.
		expect(row(body, 'outbound-imaps').relevance).toBe('optional');
	});

	it('requires the mailbox ports once external-mail is applied', async () => {
		writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=resend\nCOMPOSE_PROFILES=external-mail\n');
		const body = await checks();
		expect(row(body, 'outbound-imaps').relevance).toBe('required');
		expect(row(body, 'outbound-smtps').relevance).toBe('required');
		expect(row(body, 'outbound-smtp').relevance).toBe('optional');
	});

	it('treats a profile-less .env as the minimum contract, not as everything required', async () => {
		writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=resend\n');
		const body = await checks();
		const required = body.checks.filter((check) => check.relevance === 'required').map((c) => c.id);
		expect(required.sort()).toEqual(['outbound-dns', 'outbound-https']);
	});
});

describe('verdicts', () => {
	it('reports ok when every required port answers', async () => {
		const body = await checks();
		expect(body.verdict).toBe('ok');
		// Every row answered, so none may have been re-read as "not deployed".
		expect(body.checks.filter((check) => check.status !== 'open')).toEqual([]);
		expect(body.checkedAt).toBeGreaterThan(0);
	});

	it('degrades when a required outbound port is blocked', async () => {
		probeTcpMock.mockImplementation(({ port }: { port: number }) =>
			Promise.resolve(
				port === 25
					? { status: 'blocked', durationMs: 5000, code: 'ETIMEDOUT' }
					: { status: 'open', durationMs: 3 }
			)
		);
		const body = await checks();
		expect(body.verdict).toBe('degraded');
		expect(row(body, 'outbound-smtp').status).toBe('blocked');
	});

	it('stays ok when only an optional port is blocked', async () => {
		writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=resend\nCOMPOSE_PROFILES=tls\n');
		probeTcpMock.mockImplementation(({ port }: { port: number }) =>
			Promise.resolve(
				port === 465 ? { status: 'blocked', durationMs: 5000 } : { status: 'open', durationMs: 3 }
			)
		);
		const body = await checks();
		expect(row(body, 'outbound-smtps').status).toBe('blocked');
		expect(body.verdict).toBe('ok');
	});

	it('reports a service that is not deployed as skipped, not as a failure', async () => {
		writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=resend\nCOMPOSE_PROFILES=tls\n');
		probeTcpMock.mockImplementation(({ host }: { host: string }) =>
			Promise.resolve(
				host === 'imap'
					? { status: 'error', durationMs: 2, code: 'ENOTFOUND' }
					: { status: 'open', durationMs: 3 }
			)
		);
		const body = await checks();
		expect(row(body, 'inbound-imaps').status).toBe('skipped');
		expect(body.verdict).toBe('ok');
	});

	it('resolves DNS instead of dialling port 53', async () => {
		await checks();
		expect(probeDnsMock).toHaveBeenCalledWith({ domain: 'gmail.com' });
		expect(probeTcpMock).not.toHaveBeenCalledWith(expect.objectContaining({ port: 53 }));
	});
});
