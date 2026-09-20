import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShutdown } from '@owlat/shared/nodeShutdown';

const { execSyncMock, rateLimitedMock } = vi.hoisted(() => ({
	execSyncMock: vi.fn(),
	rateLimitedMock: vi.fn(() => false),
}));
vi.mock('node:child_process', () => ({ execSync: execSyncMock }));
vi.mock('../security.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../security.js')>();
	return { ...actual, isRateLimited: rateLimitedMock };
});

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-updater-lifecycle-'));
process.env['INSTANCE_SECRET'] = 'test-instance-secret-0123456789';
process.env['OWLAT_DIR'] = OWLAT_DIR;
process.env['PORT'] = '0';

const { buildRequestListener } = await import('../server.js');
const { critical, setShutdownHandle } = await import('../lifecycle.js');

const AUTH = { 'x-instance-secret': 'test-instance-secret-0123456789' };

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
	writeFileSync(join(OWLAT_DIR, '.env'), 'FOO=bar\nCOMPOSE_PROFILES=\n');
});

afterEach(() => setShutdownHandle(undefined));

function post(path: string, body: unknown) {
	return fetch(`${base}${path}`, {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify(body),
	});
}

describe('critical', () => {
	it('is a transparent pass-through with no handle installed', async () => {
		await expect(critical(async () => 'value')).resolves.toBe('value');
		await expect(critical(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
	});

	/**
	 * Every endpoint that writes host state must be inside a critical section —
	 * a new one added outside it would be exactly the regression this guards, and
	 * the read-only routes must stay outside so a `/health` poll cannot hold a
	 * shutdown open.
	 */
	it('routes each state-changing endpoint through the installed handle', async () => {
		const seen: string[] = [];
		const handle = installShutdown({
			timeoutMs: 1_000,
			log: () => {},
			signals: [],
			exit: () => {},
		});
		let current = '';
		setShutdownHandle({
			...handle,
			critical: (fn) => {
				seen.push(current);
				return handle.critical(fn);
			},
		});

		const bodies: [string, unknown][] = [
			['/update', {}],
			['/configure-ip', { ip: '2.2.2.2', action: 'add' }],
			[
				'/rotate-env',
				{
					instanceSecret: 'new-instance-secret-0123456789',
					convexAdminKey: 'new-admin-key-0123456789abcdef',
					mtaApiKey: 'new-mta-api-key-0123456789abcd',
					mtaWebhookSecret: 'new-webhook-secret-0123456789a',
					redisPassword: 'new-redis-password-0123456789a',
				},
			],
			['/apply-profiles', { flags: {} }],
		];
		for (const [path, body] of bodies) {
			current = path;
			const res = await post(path, body);
			expect([path, res.status]).toEqual([path, 200]);
		}

		expect(seen).toEqual(['/update', '/configure-ip', '/rotate-env', '/apply-profiles']);
	});

	it('leaves the read-only endpoints outside the critical section', async () => {
		const handle = installShutdown({
			timeoutMs: 1_000,
			log: () => {},
			signals: [],
			exit: () => {},
		});
		let calls = 0;
		setShutdownHandle({
			...handle,
			critical: (fn) => {
				calls += 1;
				return handle.critical(fn);
			},
		});

		await fetch(`${base}/health`, { headers: AUTH });
		await fetch(`${base}/profile-state`, { headers: AUTH });

		expect(calls).toBe(0);
	});

	it('an apply already running holds the shutdown open until its last step', async () => {
		const exit = vi.fn();
		const handle = installShutdown({
			timeoutMs: 5_000,
			log: () => {},
			signals: [],
			exit,
		});
		setShutdownHandle(handle);

		// A signal arriving between /apply-profiles' file writes and its
		// `docker compose up -d` is the case that used to leave the host's
		// configuration describing a stack that is not running.
		let releaseCompose!: () => void;
		const composeRan = new Promise<void>((resolve) => {
			releaseCompose = resolve;
		});
		const applied = critical(async () => {
			await composeRan;
			return 'applied';
		});

		const shutting = handle.shutdown('SIGTERM');
		await Promise.resolve();
		expect(exit).not.toHaveBeenCalled();

		releaseCompose();
		await expect(applied).resolves.toBe('applied');
		await shutting;
		expect(exit).toHaveBeenCalledWith(0);
	});
});
