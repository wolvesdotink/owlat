import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { execSyncMock, rateLimitedMock } = vi.hoisted(() => ({
	execSyncMock: vi.fn(),
	rateLimitedMock: vi.fn(() => false),
}));
vi.mock('node:child_process', () => ({ execSync: execSyncMock }));
vi.mock('../security.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../security.js')>();
	return { ...actual, isRateLimited: rateLimitedMock };
});

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-updater-test-'));
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

beforeEach(() => {
	rateLimitedMock.mockReturnValue(false);
	execSyncMock.mockReset().mockReturnValue('');
	writeFileSync(join(OWLAT_DIR, '.env'), 'FOO=bar\nIP_POOLS_CAMPAIGN=1.1.1.1\nINSTANCE_SECRET=old\n');
});

const AUTH = { 'x-instance-secret': 'test-instance-secret-0123456789' };

function post(path: string, body?: unknown, headers: Record<string, string> = AUTH) {
	return fetch(`${base}${path}`, {
		method: 'POST',
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe('auth + routing', () => {
	it('rejects a missing instance secret with 401', async () => {
		const res = await post('/update', {}, {});
		expect(res.status).toBe(401);
	});

	it('rejects a wrong instance secret with 401', async () => {
		const res = await post('/update', {}, { 'x-instance-secret': 'wrong-but-long-enough-000000' });
		expect(res.status).toBe(401);
	});

	it('404s unknown routes', async () => {
		const res = await fetch(`${base}/nope`);
		expect(res.status).toBe(404);
	});
});

describe('POST /update', () => {
	it('runs pull → convex-deploy → up and reports the steps', async () => {
		const res = await post('/update');
		expect(res.status).toBe(200);
		const json = (await res.json()) as { success: boolean };
		expect(json.success).toBe(true);
		const cmds = execSyncMock.mock.calls.map((c) => String(c[0]));
		expect(cmds[0]).toMatch(/^docker compose -f .*docker-compose\.yml pull$/);
		expect(cmds[1]).toMatch(/--profile deploy run --rm convex-deploy$/);
		expect(cmds[2]).toBe('docker compose up -d --remove-orphans');
	});

	it('rejects a compose template with a disallowed image, before any docker call', async () => {
		const res = await post('/update', {
			composeTemplate: 'services:\n  evil:\n    image: attacker.example/pwn:latest\n',
		});
		expect(res.status).toBe(400);
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('rejects a compose template mounting a dangerous host path', async () => {
		const res = await post('/update', {
			composeTemplate:
				'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:1.0.0\n    volumes:\n      - /etc/shadow:/x\n',
		});
		expect(res.status).toBe(400);
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('stages the template, promotes it only after pull + deploy succeed', async () => {
		const template = ['services:', '  web:', "    image: ghcr.io/wolvesdotink/web:1.0.0", ''].join('\n');
		const res = await post('/update', { composeTemplate: template });
		const json = (await res.json()) as { steps?: Array<{ step: string }> };
		expect(json.steps?.map((s) => s.step)).toEqual([
			'stage-compose',
			'pull',
			'convex-deploy',
			'write-compose',
			'up',
		]);
		// pull/deploy ran against the STAGED file, not the live one
		const cmds = execSyncMock.mock.calls.map((c) => String(c[0]));
		expect(cmds[0]).toContain('docker-compose.next.yml');
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(template);
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
		expect(res.status).toBe(200);
	});

	it('leaves the live compose file untouched when the pull fails', async () => {
		writeFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'services: {} # original\n');
		execSyncMock.mockImplementation((cmd: string) => {
			if (String(cmd).includes('pull')) {
				const err = new Error('boom') as Error & { stdout: string; stderr: string };
				err.stdout = '';
				err.stderr = 'Error response from daemon: manifest unknown';
				throw err;
			}
			return '';
		});
		const template = ['services:', '  web:', "    image: ghcr.io/wolvesdotink/web:9.9.9", ''].join('\n');
		const res = await post('/update', { composeTemplate: template });
		expect(res.status).toBe(500);
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe('services: {} # original\n');
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
	});

	it('stops before docker compose up when convex-deploy fails', async () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (String(cmd).includes('convex-deploy')) {
				const err = new Error('boom') as Error & { stdout: string; stderr: string };
				err.stdout = '';
				err.stderr = 'Error: schema validation failed';
				throw err;
			}
			return '';
		});
		const res = await post('/update');
		expect(res.status).toBe(500);
		const cmds = execSyncMock.mock.calls.map((c) => c[0]);
		expect(cmds).not.toContain('docker compose up -d --remove-orphans');
	});

	it('rate-limits update requests', async () => {
		rateLimitedMock.mockReturnValue(true);
		const res = await post('/update');
		expect(res.status).toBe(429);
	});
});

describe('POST /configure-ip', () => {
	it('rejects an invalid IPv4 address', async () => {
		const res = await post('/configure-ip', { ip: '999.1.1.1', action: 'add' });
		expect(res.status).toBe(400);
	});

	it('rejects a shell-metacharacter payload via strict validation', async () => {
		const res = await post('/configure-ip', { ip: '1.1.1.1; rm -rf /', action: 'add' });
		expect(res.status).toBe(400);
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it('adds the IP to IP_POOLS_CAMPAIGN and restarts the MTA', async () => {
		const res = await post('/configure-ip', { ip: '2.2.2.2', action: 'add' });
		expect(res.status).toBe(200);
		const env = readFileSync(join(OWLAT_DIR, '.env'), 'utf-8');
		expect(env).toContain('IP_POOLS_CAMPAIGN=1.1.1.1,2.2.2.2');
		const cmds = execSyncMock.mock.calls.map((c) => c[0]);
		expect(cmds).toContain('ip addr add 2.2.2.2/32 dev eth0');
		expect(cmds).toContain('docker compose restart mta');
	});

	it('removes the IP from IP_POOLS_CAMPAIGN', async () => {
		const res = await post('/configure-ip', { ip: '1.1.1.1', action: 'remove' });
		expect(res.status).toBe(200);
		const env = readFileSync(join(OWLAT_DIR, '.env'), 'utf-8');
		expect(env).toContain('IP_POOLS_CAMPAIGN=\n');
	});
});

describe('POST /rotate-env', () => {
	const valid = {
		instanceSecret: 'new-instance-secret-0123456789',
		convexAdminKey: 'new-admin-key-0123456789abcdef',
		mtaApiKey: 'new-mta-api-key-0123456789abcd',
		mtaWebhookSecret: 'new-webhook-secret-0123456789a',
		redisPassword: 'new-redis-password-0123456789a',
	};

	it('requires every field (partial rotation is refused)', async () => {
		const { redisPassword: _omitted, ...partial } = valid;
		const res = await post('/rotate-env', partial);
		expect(res.status).toBe(400);
	});

	it('rejects CR/LF injection into the env file', async () => {
		const res = await post('/rotate-env', { ...valid, mtaApiKey: 'evil\nINJECTED=1-padme-16chars' });
		expect(res.status).toBe(400);
	});

	it('rewrites the env keys in place and force-recreates containers', async () => {
		const res = await post('/rotate-env', valid);
		expect(res.status).toBe(200);
		const env = readFileSync(join(OWLAT_DIR, '.env'), 'utf-8');
		expect(env).toContain(`INSTANCE_SECRET=${valid.instanceSecret}`);
		expect(env).toContain('FOO=bar'); // untouched lines preserved
		const cmds = execSyncMock.mock.calls.map((c) => c[0]);
		expect(cmds).toContain('docker compose up -d --force-recreate');
	});
});

describe('GET /health', () => {
	it('requires auth (no container enumeration)', async () => {
		const res = await fetch(`${base}/health`);
		expect(res.status).toBe(401);
	});

	it('reports parsed container rows with image tags', async () => {
		execSyncMock.mockReturnValue(
			'{"Service":"web","State":"running","Status":"Up 2 hours","Image":"ghcr.io/wolvesdotink/web:1.2.3","Health":"healthy"}\n',
		);
		const res = await fetch(`${base}/health`, { headers: AUTH });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { containers: Array<Record<string, unknown>> };
		expect(json.containers[0]).toMatchObject({ service: 'web', imageTag: '1.2.3' });
	});
});
