import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * GET /profile-state — the read-only half of the profile control plane (plan
 * FU4). The banner that says "Services out of sync — Apply & restart" used to
 * live in per-tab memory, so a reload lost it while services were still
 * drifted; this endpoint reports the APPLIED state (COMPOSE_PROFILES from .env
 * plus `compose ps`) so the drift can be recomputed server-side at any time.
 *
 * The invariants under test: same auth + rate-limit shape as its write
 * siblings, no docker writes ever, and a parse that matches what
 * /apply-profiles wrote.
 */

const { execSyncMock, rateLimitedMock } = vi.hoisted(() => ({
	execSyncMock: vi.fn(),
	rateLimitedMock: vi.fn((_endpoint: string) => false),
}));
vi.mock('node:child_process', () => ({ execSync: execSyncMock }));
vi.mock('../security.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../security.js')>();
	return { ...actual, isRateLimited: rateLimitedMock };
});

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-profile-state-test-'));
process.env['INSTANCE_SECRET'] = 'test-instance-secret-0123456789';
process.env['OWLAT_DIR'] = OWLAT_DIR;
process.env['PORT'] = '0';

// Dynamic import AFTER env is staged — http.ts reads env at module load.
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
const INITIAL_ENV =
	'# managed by owlat\nEMAIL_PROVIDER=resend\nCOMPOSE_PROFILES=clamav,external-mail\nFOO=bar\n';

beforeEach(() => {
	rateLimitedMock.mockReturnValue(false);
	execSyncMock.mockReset().mockReturnValue('');
	writeFileSync(ENV_FILE, INITIAL_ENV);
});

const AUTH = { 'x-instance-secret': 'test-instance-secret-0123456789' };

function get(headers: Record<string, string> = AUTH) {
	return fetch(`${base}/profile-state`, { method: 'GET', headers });
}

interface ProfileState {
	profiles: string[];
	deliveryProvider?: string;
	services: Array<Record<string, unknown>> | string;
}

describe('auth + rate limit', () => {
	it('rejects a missing instance secret with 401', async () => {
		const res = await get({});
		expect(res.status).toBe(401);
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('rejects a wrong instance secret with 401', async () => {
		const res = await get({ 'x-instance-secret': 'wrong-but-long-enough-000000' });
		expect(res.status).toBe(401);
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('returns 429 when rate limited, before running docker', async () => {
		rateLimitedMock.mockImplementation((endpoint: string) => endpoint === 'profile-state');
		const res = await get();
		expect(res.status).toBe(429);
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('does not share a rate-limit bucket with the write endpoints', async () => {
		rateLimitedMock.mockImplementation((endpoint: string) => endpoint === 'apply-profiles');
		expect((await get()).status).toBe(200);
	});
});

describe('.env parsing', () => {
	it('reports the applied COMPOSE_PROFILES and delivery provider', async () => {
		const body = (await (await get()).json()) as ProfileState;
		expect(body.profiles).toEqual(['clamav', 'external-mail']);
		expect(body.deliveryProvider).toBe('resend');
	});

	it('reports an empty profile list for a pre-profiles install', async () => {
		writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=resend\n');
		const body = (await (await get()).json()) as ProfileState;
		expect(body.profiles).toEqual([]);
		expect(body.deliveryProvider).toBe('resend');
	});

	it('normalizes a hand-edited line (spacing, quotes, duplicates, junk)', async () => {
		writeFileSync(ENV_FILE, 'COMPOSE_PROFILES=" mta, clamav ,mta,Bad Name"\n');
		const body = (await (await get()).json()) as ProfileState;
		expect(body.profiles).toEqual(['clamav', 'mta']);
		expect(body.deliveryProvider).toBeUndefined();
	});

	it('round-trips what /apply-profiles writes', async () => {
		execSyncMock.mockReturnValue('');
		const applied = await fetch(`${base}/apply-profiles`, {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({ flags: { postbox: true } }),
		});
		const { profiles } = (await applied.json()) as { profiles: string[] };
		const body = (await (await get()).json()) as ProfileState;
		expect(body.profiles).toEqual(profiles);
	});

	it('fails with 500 when .env cannot be read', async () => {
		rmSync(ENV_FILE);
		const res = await get();
		expect(res.status).toBe(500);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining('Cannot read .env'),
		});
	});
});

describe('compose ps mapping', () => {
	it('maps each service row through the shared parser', async () => {
		execSyncMock.mockReturnValue(
			'{"Service":"mail-sync","State":"running","Status":"Up 5 seconds","Image":"ghcr.io/wolvesdotink/mail-sync:0.4.3","Health":"healthy"}\n' +
				'{"Service":"mta","State":"exited","Status":"Exited (0)","Image":"ghcr.io/wolvesdotink/mta:0.4.3","Health":""}\n'
		);
		const body = (await (await get()).json()) as ProfileState;
		expect(body.services).toEqual([
			{
				service: 'mail-sync',
				state: 'running',
				status: 'Up 5 seconds',
				image: 'ghcr.io/wolvesdotink/mail-sync:0.4.3',
				imageTag: '0.4.3',
				health: 'healthy',
			},
			{
				service: 'mta',
				state: 'exited',
				status: 'Exited (0)',
				image: 'ghcr.io/wolvesdotink/mta:0.4.3',
				imageTag: '0.4.3',
				health: '',
			},
		]);
	});

	it('falls back to raw stdout when compose ps is not JSON', async () => {
		execSyncMock.mockReturnValue('NAME   STATE\nweb    running\n');
		const body = (await (await get()).json()) as ProfileState;
		expect(body.services).toBe('NAME   STATE\nweb    running\n');
	});

	it('is read-only: only `compose ps` runs, and .env is untouched', async () => {
		await get();
		expect(execSyncMock.mock.calls.map((c) => String(c[0]))).toEqual([
			'docker compose ps --format json',
		]);
		expect(readFileSync(ENV_FILE, 'utf-8')).toBe(INITIAL_ENV);
	});

	it('still answers when the docker daemon is down', async () => {
		execSyncMock.mockImplementation(() => {
			throw Object.assign(new Error('boom'), { stderr: 'daemon down' });
		});
		const res = await get();
		expect(res.status).toBe(200);
		const body = (await res.json()) as ProfileState;
		expect(body.profiles).toEqual(['clamav', 'external-mail']);
		expect(body.services).toBe('');
	});
});

describe('routing', () => {
	it('is GET-only — POST falls through to 404', async () => {
		const res = await fetch(`${base}/profile-state`, { method: 'POST', headers: AUTH });
		expect(res.status).toBe(404);
	});
});
