import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActiveProfiles, type FeatureFlagState } from '@owlat/shared/featureFlags';
import { applyEnvUpdates, validateFlagSnapshot } from '../security.js';

/**
 * POST /apply-profiles — the updater as the SINGLE writer converging
 * COMPOSE_PROFILES in .env, the compose override and the CLI flag mirror from
 * one resolved flag snapshot (plan D3/G2). Exercises the trust boundary (the
 * caller sends flags, never profiles), the hardened .env rewrite, and the
 * per-service health report.
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

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-apply-profiles-test-'));
process.env['INSTANCE_SECRET'] = 'test-instance-secret-0123456789';
process.env['OWLAT_DIR'] = OWLAT_DIR;
process.env['PORT'] = '0';

// Dynamic import AFTER env is staged — server.ts reads env at module load.
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
const OVERRIDE_FILE = join(OWLAT_DIR, 'docker-compose.override.yml');
const MIRROR_FILE = join(OWLAT_DIR, '.owlat-flags.json');
const INITIAL_ENV = '# managed by owlat\nEMAIL_PROVIDER=resend\nCOMPOSE_PROFILES=stale\nFOO=bar\n';

beforeEach(() => {
	rateLimitedMock.mockReturnValue(false);
	execSyncMock.mockReset().mockReturnValue('');
	writeFileSync(ENV_FILE, INITIAL_ENV);
});

const AUTH = { 'x-instance-secret': 'test-instance-secret-0123456789' };

function post(body?: unknown, headers: Record<string, string> = AUTH) {
	return fetch(`${base}/apply-profiles`, {
		method: 'POST',
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

function envProfiles(): string {
	const match = readFileSync(ENV_FILE, 'utf-8').match(/^COMPOSE_PROFILES=(.*)$/m);
	return match?.[1] ?? '';
}

describe('auth + rate limit', () => {
	it('rejects a missing instance secret with 401', async () => {
		const res = await post({ flags: {} }, {});
		expect(res.status).toBe(401);
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('rejects a wrong instance secret with 401', async () => {
		const res = await post({ flags: {} }, { 'x-instance-secret': 'wrong-but-long-enough-000000' });
		expect(res.status).toBe(401);
	});

	it('returns 429 when rate limited, before touching any file', async () => {
		rateLimitedMock.mockImplementation((endpoint: string) => endpoint === 'apply-profiles');
		const res = await post({ flags: {} });
		expect(res.status).toBe(429);
		expect(readFileSync(ENV_FILE, 'utf-8')).toBe(INITIAL_ENV);
	});
});

describe('flag snapshot validation', () => {
	it('rejects a non-JSON body', async () => {
		const res = await fetch(`${base}/apply-profiles`, {
			method: 'POST',
			headers: AUTH,
			body: 'nope{',
		});
		expect(res.status).toBe(400);
	});

	it('rejects a missing / non-object flags field', async () => {
		for (const flags of [undefined, null, [], 'campaigns', 7]) {
			const res = await post({ flags });
			expect(res.status).toBe(400);
		}
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('rejects a non-boolean flag value', async () => {
		const res = await post({ flags: { campaigns: 'yes' } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('campaigns');
	});

	it('rejects keys the registry does not know', async () => {
		const res = await post({ flags: { 'not.a.flag': true } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('not.a.flag');
		// Nothing was applied.
		expect(readFileSync(ENV_FILE, 'utf-8')).toBe(INITIAL_ENV);
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('accepts plugin-shaped keys and mirrors them (profiles unaffected)', async () => {
		const res = await post({ flags: { 'plugin.crm-sync': true } });
		expect(res.status).toBe(200);
		const mirror = JSON.parse(readFileSync(MIRROR_FILE, 'utf-8')) as FeatureFlagState;
		expect(mirror['plugin.crm-sync']).toBe(true);
	});
});

describe('profile derivation (server-side, from flags — never caller profiles)', () => {
	it.each<[string, FeatureFlagState, string[]]>([
		['postbox needs personal-mail + mta', { postbox: true }, ['clamav', 'mta', 'personal-mail']],
		['mail.external needs external-mail', { 'mail.external': true }, ['clamav', 'external-mail']],
		['inbox needs the mta', { inbox: true }, ['clamav', 'mta']],
		['everything off empties the list', { 'scan.files': false }, []],
	])('%s', async (_name, flags, expected) => {
		const res = await post({ flags });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { profiles: string[] };
		expect(body.profiles).toEqual(expected);
		expect(envProfiles()).toBe(expected.join(','));
		// The endpoint's derivation IS the shared registry's — no updater-local table.
		expect(body.profiles).toEqual(getActiveProfiles(flags, { deliveryProvider: 'resend' }));
	});

	it('applies the deliveryProvider→mta rule from the co-located .env', async () => {
		writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=mta\nCOMPOSE_PROFILES=\n');
		const res = await post({ flags: { 'scan.files': false } });
		const body = (await res.json()) as { profiles: string[] };
		expect(body.profiles).toEqual(['mta']);
	});

	it('a caller-supplied profile list is ignored — flags are the only input', async () => {
		const res = await post({ flags: { 'scan.files': false }, profiles: ['mta', 'personal-mail'] });
		expect(res.status).toBe(200);
		expect(envProfiles()).toBe('');
	});
});

describe('.env rewrite', () => {
	it('rewrites COMPOSE_PROFILES in place, preserving comments and ordering', async () => {
		await post({ flags: { 'mail.external': true } });
		expect(readFileSync(ENV_FILE, 'utf-8')).toBe(
			'# managed by owlat\nEMAIL_PROVIDER=resend\nCOMPOSE_PROFILES=clamav,external-mail\nFOO=bar\n'
		);
	});

	it('appends COMPOSE_PROFILES when a pre-profiles install lacks the line', async () => {
		writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=resend\n');
		await post({ flags: {} });
		expect(readFileSync(ENV_FILE, 'utf-8')).toBe(
			'EMAIL_PROVIDER=resend\nCOMPOSE_PROFILES=clamav\n'
		);
	});

	it('is idempotent — applying the same snapshot twice leaves .env byte-identical', async () => {
		writeFileSync(ENV_FILE, 'EMAIL_PROVIDER=resend\n');
		await post({ flags: { inbox: true } });
		const once = readFileSync(ENV_FILE, 'utf-8');
		await post({ flags: { inbox: true } });
		expect(readFileSync(ENV_FILE, 'utf-8')).toBe(once);
	});
});

describe('override regeneration + flag mirror', () => {
	it('regenerates docker-compose.override.yml via the shared writer', async () => {
		await post({ flags: { 'mail.external': true } });
		const override = readFileSync(OVERRIDE_FILE, 'utf-8');
		expect(override).toContain('x-owlat-profiles:');
		expect(override).toContain('  - external-mail');
		expect(override).toContain('__external-mail_marker:');
		expect(override).toContain('image: busybox:stable');
	});

	it('mirrors the exact snapshot to .owlat-flags.json with owner-only mode', async () => {
		const flags = { inbox: true, 'scan.files': false, 'plugin.crm-sync': false };
		await post({ flags });
		expect(JSON.parse(readFileSync(MIRROR_FILE, 'utf-8'))).toEqual(flags);
		expect(statSync(MIRROR_FILE).mode & 0o777).toBe(0o600);
	});
});

describe('compose invocation + per-service health', () => {
	it('runs `docker compose up -d --remove-orphans` in OWLAT_DIR, then reports compose ps', async () => {
		execSyncMock.mockImplementation((cmd: string) =>
			cmd.includes('ps')
				? '{"Service":"mail-sync","State":"running","Status":"Up 5 seconds","Image":"ghcr.io/wolvesdotink/mail-sync:0.4.3","Health":"healthy"}\n'
				: ''
		);
		const res = await post({ flags: { 'mail.external': true } });
		expect(res.status).toBe(200);

		const calls = execSyncMock.mock.calls.map((c) => [String(c[0]), (c[1] as { cwd: string }).cwd]);
		expect(calls).toEqual([
			['docker compose up -d --remove-orphans', OWLAT_DIR],
			['docker compose ps --format json', OWLAT_DIR],
		]);

		const body = (await res.json()) as {
			success: boolean;
			services: Array<Record<string, unknown>>;
			steps: Array<{ step: string }>;
		};
		expect(body.success).toBe(true);
		expect(body.services[0]).toMatchObject({
			service: 'mail-sync',
			state: 'running',
			imageTag: '0.4.3',
			health: 'healthy',
		});
		expect(body.steps.map((s) => s.step)).toEqual([
			'write-env',
			'write-override',
			'write-flag-mirror',
			'up',
		]);
	});

	it('fails with 500 (files already converged) when compose up fails', async () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes('up')) throw Object.assign(new Error('boom'), { stderr: 'daemon down' });
			return '';
		});
		const res = await post({ flags: {} });
		expect(res.status).toBe(500);
		// The declarative state was still written — a manual `docker compose up` completes it.
		expect(envProfiles()).toBe('clamav');
	});
});

describe('applyEnvUpdates — the extracted hardened line-rewriter', () => {
	it('refuses keys outside the caller allowlist', () => {
		const result = applyEnvUpdates('A=1\n', { INSTANCE_SECRET: 'x' }, ['COMPOSE_PROFILES']);
		expect(result).toEqual({ ok: false, reason: 'Env key not in allowlist: INSTANCE_SECRET' });
	});

	it.each([
		['CR', 'a\rb'],
		['LF', 'a\nINJECTED=1'],
		['NUL', 'a\x00b'],
	])('rejects %s injection into the value', (_name, value) => {
		const result = applyEnvUpdates('COMPOSE_PROFILES=\n', { COMPOSE_PROFILES: value }, [
			'COMPOSE_PROFILES',
		]);
		expect(result.ok).toBe(false);
	});

	it('leaves missing keys absent unless appendMissing is set (rotation semantics)', () => {
		const withoutAppend = applyEnvUpdates('FOO=bar\n', { COMPOSE_PROFILES: 'mta' }, [
			'COMPOSE_PROFILES',
		]);
		expect(withoutAppend).toEqual({ ok: true, content: 'FOO=bar\n' });
		const withAppend = applyEnvUpdates(
			'FOO=bar\n',
			{ COMPOSE_PROFILES: 'mta' },
			['COMPOSE_PROFILES'],
			{
				appendMissing: true,
			}
		);
		expect(withAppend).toEqual({ ok: true, content: 'FOO=bar\nCOMPOSE_PROFILES=mta\n' });
	});

	it('appends with a final newline even when the file lacked one', () => {
		const result = applyEnvUpdates('FOO=bar', { COMPOSE_PROFILES: 'mta' }, ['COMPOSE_PROFILES'], {
			appendMissing: true,
		});
		expect(result).toEqual({ ok: true, content: 'FOO=bar\nCOMPOSE_PROFILES=mta\n' });
	});
});

describe('validateFlagSnapshot — registry gate', () => {
	it('caps the number of keys', () => {
		const flags = Object.fromEntries(
			Array.from({ length: 300 }, (_, i) => [`plugin.flag-${i}`, true])
		);
		expect(validateFlagSnapshot(flags).ok).toBe(false);
	});
});
