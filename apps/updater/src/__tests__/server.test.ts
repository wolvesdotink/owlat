import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { execFileSyncMock, rateLimitedMock, freeBytesMock } = vi.hoisted(() => ({
	execFileSyncMock: vi.fn(),
	rateLimitedMock: vi.fn(() => false),
	freeBytesMock: vi.fn((): number => 50 * 1024 ** 3),
}));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));
// Only statfs is faked: the tests stage real files in a temp OWLAT_DIR, but the
// free space of the disk they run on is not something a test may depend on.
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return { ...actual, statfsSync: () => ({ bavail: freeBytesMock(), bsize: 1 }) };
});
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
const { fastReadiness } = await import('./readinessStubs.js');

let server: Server;
let base: string;
let readiness: ReturnType<typeof fastReadiness>;

beforeAll(async () => {
	readiness = fastReadiness();
	server = createServer(buildRequestListener());
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const addr = server.address();
	if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
	server.close();
	readiness.restore();
});

beforeEach(() => {
	readiness.webStatus(200);
	rateLimitedMock.mockReturnValue(false);
	freeBytesMock.mockReset().mockReturnValue(50 * 1024 ** 3);
	execFileSyncMock.mockReset().mockImplementation(dockerFixture);
	writeFileSync(
		join(OWLAT_DIR, '.env'),
		'FOO=bar\nIP_POOLS_CAMPAIGN=1.1.1.1\nINSTANCE_SECRET=old\n'
	);
});

const AUTH = { 'x-instance-secret': 'test-instance-secret-0123456789' };

/**
 * What a healthy Docker answers. The update path now reads the daemon before it
 * writes to it — an API preflight, the service list it must recreate, and its
 * own container's plumbing — so a mock that returns '' for everything describes
 * a broken host, not a quiet one.
 */
function dockerFixture(file: unknown, args: unknown): string {
	const cmd = [String(file), ...((args as string[]) ?? [])].join(' ');
	if (cmd.includes('config --services')) {
		return 'web\nconvex\nmta\nupdater\ndocker-socket-proxy\n';
	}
	if (cmd.startsWith('docker inspect') && cmd.includes('org.opencontainers.image.source')) {
		return `${OWLAT_SOURCE}\n`;
	}
	if (cmd.startsWith('docker image prune'))
		return 'Deleted Images:\n…\nTotal reclaimed space: 15.91GB\n';
	if (cmd.startsWith('docker inspect')) {
		return [
			'ghcr.io/wolvesdotink/updater:0.5.0',
			`${HOST_INSTALL_DIR}:${OWLAT_DIR}:rw `,
			'owlat_default owlat_docker-proxy ',
		].join('\n');
	}
	if (cmd.startsWith('docker run')) return 'helper-container-id\n';
	// The readiness check after `up`: every recreated service is up.
	if (cmd.includes(' ps --all --format json')) return composePs(RUNNING);
	return '';
}

/** The OCI source label every published Owlat image carries. */
const OWLAT_SOURCE = 'https://github.com/wolvesdotink/owlat';

/** A docker that fails `match`, and behaves for everything else. */
function dockerFailing(match: (cmd: string) => boolean, stderr: string) {
	return (file: unknown, args: unknown): string => {
		if (match([String(file), ...((args as string[]) ?? [])].join(' '))) {
			const err = new Error('boom') as Error & { stdout: string; stderr: string };
			err.stdout = '';
			err.stderr = stderr;
			throw err;
		}
		return dockerFixture(file, args);
	};
}

/** `docker compose ps --format json` rows, in the NDJSON shape Compose emits. */
function composePs(
	rows: Array<{ Service: string; State: string; Health?: string; Status?: string }>
): string {
	return rows
		.map((row) => JSON.stringify({ Image: 'ghcr.io/wolvesdotink/x:1.0.0', Health: '', ...row }))
		.join('\n');
}

const RUNNING = [
	{ Service: 'web', State: 'running' },
	{ Service: 'convex', State: 'running' },
	{ Service: 'mta', State: 'running' },
];

/**
 * The argv of each child process, rendered as one line for assertions. `exec`
 * runs execFileSync — there is no shell command string to inspect, so the
 * arguments are joined here rather than in production code.
 */
function commandLines(): string[] {
	return execFileSyncMock.mock.calls.map((c) => [String(c[0]), ...(c[1] as string[])].join(' '));
}

/**
 * The host path the install dir is bind-mounted FROM. Compose has to be told
 * about it with --project-directory, or every relative bind in the compose file
 * resolves to a path that only exists inside the updater container.
 */
const HOST_INSTALL_DIR = '/srv/owlat';
const COMPOSE = `docker compose --project-directory ${HOST_INSTALL_DIR} --env-file ${join(OWLAT_DIR, '.env')} -f ${join(OWLAT_DIR, 'docker-compose.yml')}`;

const composeCommands = () => commandLines().filter((c) => c.startsWith('docker compose'));

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
		const cmds = composeCommands();
		expect(cmds[0]).toBe(`${COMPOSE} pull`);
		expect(cmds[1]).toBe(`${COMPOSE} --profile deploy run --rm convex-deploy`);
		expect(cmds[2]).toBe(`${COMPOSE} config --services`);
		// What was already failing before the release touched anything.
		expect(cmds[3]).toBe(`${COMPOSE} ps --all --format json`);
		expect(cmds[4]).toBe(`${COMPOSE} up -d --remove-orphans web convex mta`);
	});

	/**
	 * The proxy in front of the Docker socket is the feature list of in-app
	 * updates: with its NETWORKS/VOLUMES groups off, `compose up` and
	 * `compose run` 403. That used to surface five minutes in as
	 * "convex-deploy failed", with a compose file already staged.
	 */
	it('refuses — before touching anything — when the Docker API denies what the rollout needs', async () => {
		writeFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'services: {} # original\n');
		execFileSyncMock.mockImplementation(
			dockerFailing(
				(cmd) => cmd.startsWith('docker network ls'),
				'Error response from daemon: <html><body><h1>403 Forbidden</h1>\n</body></html>'
			)
		);

		const template = ['services:', '  web:', '    image: ghcr.io/wolvesdotink/web:9.9.9', ''].join(
			'\n'
		);
		const res = await post('/update', { composeTemplate: template });

		expect(res.status).toBe(500);
		const json = (await res.json()) as { error: string; steps: Array<{ step: string }> };
		expect(json.error).toContain('403 Forbidden');
		expect(json.error).toContain('docker compose up -d docker-socket-proxy');
		expect(json.steps.map((s) => s.step)).toEqual(['docker-api-preflight']);
		// Nothing staged, nothing pulled, live compose file untouched.
		expect(composeCommands()).toEqual([]);
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(
			'services: {} # original\n'
		);
	});

	/**
	 * Compose recreate stops the old container before starting the new one. For
	 * the updater that is the process issuing the command, and for the socket
	 * proxy it is that process's only transport — either one takes the rest of
	 * the rollout with it, leaving half the stack on the old release.
	 */
	it('never recreates the updater or the socket proxy as part of the rollout', async () => {
		const res = await post('/update');
		expect(res.status).toBe(200);
		const up = composeCommands().find((cmd) => cmd.includes(' up -d'));
		expect(up).toBe(`${COMPOSE} up -d --remove-orphans web convex mta`);
		const recreated = up?.split(' --remove-orphans ')[1]?.split(' ');
		expect(recreated).not.toContain('updater');
		expect(recreated).not.toContain('docker-socket-proxy');
	});

	it("hands the updater's own replacement to a helper that clones its plumbing", async () => {
		const res = await post('/update');
		expect(res.status).toBe(200);

		const cmds = commandLines();
		const run = cmds.find((cmd) => cmd.startsWith('docker run'));
		expect(run).toBeDefined();
		// Same image it is already running (nothing new is pulled), same bind
		// mounts (the promoted compose file), first network at create time.
		expect(run).toContain('ghcr.io/wolvesdotink/updater:0.5.0');
		expect(run).toContain(`-v ${HOST_INSTALL_DIR}:${OWLAT_DIR}:rw`);
		expect(run).toContain('--network owlat_default');
		expect(run).toContain(`${COMPOSE} up -d --no-deps updater`);
		// …and the remaining networks attached after create, or the helper
		// cannot reach the Docker API it was handed.
		expect(cmds).toContain('docker network connect owlat_docker-proxy helper-container-id');

		const json = (await res.json()) as { steps: Array<{ step: string; ok?: boolean }> };
		expect(json.steps.at(-1)).toMatchObject({ step: 'self-update', ok: true });
	});

	it('reports a failed hand-off without failing an update that already landed', async () => {
		execFileSyncMock.mockImplementation(
			dockerFailing((cmd) => cmd.startsWith('docker run'), 'no such image')
		);
		const res = await post('/update');
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			success: boolean;
			steps: Array<{ step: string; ok?: boolean; stderr: string }>;
		};
		expect(json.success).toBe(true);
		const selfUpdate = json.steps.find((s) => s.step === 'self-update');
		expect(selfUpdate?.ok).toBe(false);
		expect(selfUpdate?.stderr).toContain('docker compose up -d updater');
	});

	it('rejects a compose template with a disallowed image, before any docker call', async () => {
		const res = await post('/update', {
			composeTemplate: 'services:\n  evil:\n    image: attacker.example/pwn:latest\n',
		});
		expect(res.status).toBe(400);
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	it('rejects a compose template mounting a dangerous host path', async () => {
		const res = await post('/update', {
			composeTemplate:
				'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:1.0.0\n    volumes:\n      - /etc/shadow:/x\n',
		});
		expect(res.status).toBe(400);
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	it('stages the template, promotes it only after pull + deploy succeed', async () => {
		const template = ['services:', '  web:', '    image: ghcr.io/wolvesdotink/web:1.0.0', ''].join(
			'\n'
		);
		const res = await post('/update', { composeTemplate: template });
		const json = (await res.json()) as { steps?: Array<{ step: string }> };
		expect(json.steps?.map((s) => s.step)).toEqual([
			'docker-api-preflight',
			'reclaim-images',
			'disk-space-preflight',
			'stage-compose',
			'pull',
			'convex-deploy',
			'write-compose',
			'pin-version',
			'up',
			'readiness',
			'self-update',
		]);
		// pull/deploy ran against the STAGED file, not the live one
		expect(composeCommands()[0]).toContain('docker-compose.next.yml');
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(template);
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
		expect(res.status).toBe(200);
	});

	/**
	 * `.env` is the CONFIGURED version of the deployment — compose interpolates
	 * it into every container's OWLAT_VERSION, which is what the dashboard
	 * reports as installed and what /health diffs against the running images.
	 * Nothing else in the update path writes it, so a successful update used to
	 * leave the dashboard claiming the old version was still installed with the
	 * same update still available.
	 */
	it('pins .env OWLAT_VERSION to the applied release, before the containers are recreated', async () => {
		writeFileSync(join(OWLAT_DIR, '.env'), 'FOO=bar\nOWLAT_VERSION=0.4.16\n');
		const template = [
			'services:',
			'  web:',
			`    image: ghcr.io/wolvesdotink/web:0.4.17@sha256:${'a'.repeat(64)}`,
			'',
		].join('\n');

		const envAtUp: string[] = [];
		execFileSyncMock.mockImplementation((file: string, args: string[]) => {
			if ([file, ...args].join(' ').includes(' up -d --remove-orphans')) {
				envAtUp.push(readFileSync(join(OWLAT_DIR, '.env'), 'utf-8'));
			}
			return dockerFixture(file, args);
		});

		const res = await post('/update', { composeTemplate: template });
		expect(res.status).toBe(200);

		const json = (await res.json()) as { steps?: Array<{ step: string; ok?: boolean }> };
		expect(json.steps?.map((s) => s.step)).toEqual([
			'docker-api-preflight',
			'reclaim-images',
			'disk-space-preflight',
			'stage-compose',
			'pull',
			'convex-deploy',
			'write-compose',
			'pin-version',
			'up',
			'readiness',
			'self-update',
		]);
		expect(json.steps?.find((s) => s.step === 'pin-version')?.ok).toBe(true);

		const env = readFileSync(join(OWLAT_DIR, '.env'), 'utf-8');
		expect(env).toContain('OWLAT_VERSION=0.4.17');
		expect(env).toContain('FOO=bar'); // untouched lines preserved
		// The recreate must see the new pin, or the containers come back on the
		// old version and the bookkeeping is a lie.
		expect(envAtUp).toHaveLength(1);
		expect(envAtUp[0]).toContain('OWLAT_VERSION=0.4.17');
	});

	it('appends OWLAT_VERSION when .env has no pin yet', async () => {
		writeFileSync(join(OWLAT_DIR, '.env'), 'FOO=bar\n');
		const template = ['services:', '  web:', '    image: ghcr.io/wolvesdotink/web:1.2.3', ''].join(
			'\n'
		);
		const res = await post('/update', { composeTemplate: template });
		expect(res.status).toBe(200);
		expect(readFileSync(join(OWLAT_DIR, '.env'), 'utf-8')).toContain('OWLAT_VERSION=1.2.3');
	});

	it('leaves .env alone for a template that pins no concrete version', async () => {
		writeFileSync(join(OWLAT_DIR, '.env'), 'OWLAT_VERSION=0.4.16\n');
		const template = [
			'services:',
			'  web:',
			'    image: ghcr.io/wolvesdotink/web:${OWLAT_VERSION:-dev}',
			'',
		].join('\n');
		const res = await post('/update', { composeTemplate: template });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { steps?: Array<{ step: string }> };
		expect(json.steps?.map((s) => s.step)).not.toContain('pin-version');
		expect(readFileSync(join(OWLAT_DIR, '.env'), 'utf-8')).toBe('OWLAT_VERSION=0.4.16\n');
	});

	it('leaves the live compose file untouched when the pull fails', async () => {
		writeFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'services: {} # original\n');
		execFileSyncMock.mockImplementation(
			dockerFailing((cmd) => cmd.includes('pull'), 'Error response from daemon: manifest unknown')
		);
		const template = ['services:', '  web:', '    image: ghcr.io/wolvesdotink/web:9.9.9', ''].join(
			'\n'
		);
		const res = await post('/update', { composeTemplate: template });
		expect(res.status).toBe(500);
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(
			'services: {} # original\n'
		);
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
	});

	/**
	 * Nothing used to remove a superseded release's images, so an instance that
	 * updated often enough filled its disk and every pull after that died with
	 * `no space left on device`.
	 */
	describe('disk space', () => {
		it('removes unused Owlat images — and only those — before it pulls', async () => {
			const res = await post('/update');
			expect(res.status).toBe(200);
			const cmds = commandLines();
			const prune = cmds.findIndex((c) => c.startsWith('docker image prune'));
			const pull = cmds.findIndex((c) => c.endsWith(' pull'));
			expect(cmds[prune]).toBe(
				`docker image prune --all --force --filter label=org.opencontainers.image.source=${OWLAT_SOURCE}`
			);
			expect(prune).toBeLessThan(pull);
			const json = (await res.json()) as { steps: { step: string; stdout: string }[] };
			expect(json.steps.find((s) => s.step === 'reclaim-images')?.stdout).toContain('15.91GB');
		});

		it('prunes nothing when its own image carries no source label (a dev build)', async () => {
			execFileSyncMock.mockImplementation((file: unknown, args: unknown) => {
				const cmd = [String(file), ...((args as string[]) ?? [])].join(' ');
				if (cmd.includes('org.opencontainers.image.source')) return '\n';
				return dockerFixture(file, args);
			});
			const res = await post('/update');
			expect(res.status).toBe(200);
			expect(commandLines().some((c) => c.startsWith('docker image prune'))).toBe(false);
		});

		it('still updates when the prune fails — the free-space check decides', async () => {
			execFileSyncMock.mockImplementation(
				dockerFailing((cmd) => cmd.startsWith('docker image prune'), 'permission denied')
			);
			const res = await post('/update');
			expect(res.status).toBe(200);
		});

		it('refuses before staging or pulling when the disk has no room for a release', async () => {
			writeFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'services: {} # original\n');
			freeBytesMock.mockReturnValue(1.2 * 1024 ** 3);
			const template = [
				'services:',
				'  web:',
				'    image: ghcr.io/wolvesdotink/web:9.9.9',
				'',
			].join('\n');
			const res = await post('/update', { composeTemplate: template });
			expect(res.status).toBe(507);
			const json = (await res.json()) as { error: string };
			expect(json.error).toContain('Not enough disk space to update: 1.2 GB free');
			expect(json.error).toContain('docker image prune -a');
			expect(composeCommands()).toEqual([]);
			expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
			expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(
				'services: {} # original\n'
			);
		});

		it('names a full disk when the pull itself runs out of space', async () => {
			execFileSyncMock.mockImplementation(
				dockerFailing(
					(cmd) => cmd.endsWith(' pull'),
					' Image ghcr.io/wolvesdotink/web:0.5.5 Pulling \n 4c7692787e55 Pull complete 0B\n' +
						'failed to copy: failed to send write: write /var/lib/containerd/io.containerd.content.v1.content/ingest/x/data: no space left on device\n'
				)
			);
			const res = await post('/update');
			expect(res.status).toBe(500);
			const json = (await res.json()) as { error: string };
			expect(json.error).toMatch(/^Docker pull failed: the host disk is full/);
		});

		it("puts the pull's own last error line in the message, not its layer progress", async () => {
			execFileSyncMock.mockImplementation(
				dockerFailing(
					(cmd) => cmd.endsWith(' pull'),
					' 4c7692787e55 Pulling fs layer 0B\nError response from daemon: manifest unknown\n'
				)
			);
			const res = await post('/update');
			const json = (await res.json()) as { error: string };
			expect(json.error).toBe(
				'Docker pull failed (Error response from daemon: manifest unknown). ' +
					'The update was aborted and nothing changed.'
			);
		});
	});

	it('stops before docker compose up when convex-deploy fails', async () => {
		execFileSyncMock.mockImplementation(
			dockerFailing((cmd) => cmd.includes('convex-deploy'), 'Error: schema validation failed')
		);
		const res = await post('/update');
		expect(res.status).toBe(500);
		expect(composeCommands().some((cmd) => cmd.includes(' up -d'))).toBe(false);
	});

	/**
	 * `./Caddyfile:/etc/caddy/Caddyfile` is resolved by compose against the
	 * project directory and handed to the daemon as a HOST path. Run from inside
	 * the updater, `./` is the container's own mount point, so a recreate used to
	 * bind a path that exists on no host — Docker creates it, empty, and mounts
	 * it over the real config.
	 */
	it('runs compose against the install dir as the HOST sees it', async () => {
		const res = await post('/update');
		expect(res.status).toBe(200);
		for (const cmd of composeCommands()) {
			expect(cmd).toContain(`--project-directory ${HOST_INSTALL_DIR}`);
			// …while reading the files and the env from the paths THIS container has.
			expect(cmd).toContain(`--env-file ${join(OWLAT_DIR, '.env')}`);
		}
	});

	it('falls back to a bare compose command when the host path cannot be read', async () => {
		execFileSyncMock.mockImplementation(
			dockerFailing((cmd) => cmd.startsWith('docker inspect'), 'permission denied')
		);
		const res = await post('/update');
		expect(res.status).toBe(200);
		expect(composeCommands()).toContain('docker compose up -d --remove-orphans web convex mta');
	});

	/**
	 * `up` is the only step of a rollout with nothing left to roll back to, and
	 * the only one that can leave the instance dark: compose recreate stops the
	 * old container before starting the new one, so a command that dies in the
	 * middle leaves the whole plan stopped. A pre-0.5.1 updater did exactly that
	 * to itself on every release and answered with a bare "docker compose up
	 * failed" — the operator's next signal was a site that no longer loaded.
	 */
	it('restarts the stack when the recreate fails, and says the instance is serving', async () => {
		execFileSyncMock.mockImplementation((file: string, args: string[]) => {
			const cmd = [file, ...args].join(' ');
			if (cmd.includes(' up -d --remove-orphans')) {
				const err = new Error('boom') as Error & { stdout: string; stderr: string };
				err.stdout = '';
				err.stderr = 'error during connect: EOF';
				throw err;
			}
			if (cmd.includes(' ps --all --format json')) return composePs(RUNNING);
			return dockerFixture(file, args);
		});

		const res = await post('/update');
		expect(res.status).toBe(500);
		const json = (await res.json()) as {
			error: string;
			steps: Array<{ step: string; ok?: boolean; stdout: string }>;
		};

		const recovery = json.steps.at(-1);
		expect(recovery).toMatchObject({ step: 'up-recovery', ok: true });
		expect(recovery?.stdout).toContain('serving again');
		expect(json.error).toContain('serving again');

		// Recovery is deliberately SMALLER than the command that just failed:
		// the same services, and none of the extra teardown.
		const retry = composeCommands().findLast((cmd) => cmd.includes(' up -d'));
		expect(retry).toBe(`${COMPOSE} up -d web convex mta`);
		expect(retry).not.toContain('--remove-orphans');
		expect(retry).not.toContain('--force-recreate');
	});

	it('names the services still down, and the host command that starts them', async () => {
		execFileSyncMock.mockImplementation((file: string, args: string[]) => {
			const cmd = [file, ...args].join(' ');
			if (cmd.includes(' up -d')) {
				const err = new Error('boom') as Error & { stdout: string; stderr: string };
				err.stdout = '';
				err.stderr = 'error during connect: EOF';
				throw err;
			}
			if (cmd.includes(' ps --all --format json')) {
				return composePs([
					{ Service: 'web', State: 'exited' },
					{ Service: 'convex', State: 'running' },
					{ Service: 'mta', State: 'exited' },
				]);
			}
			return dockerFixture(file, args);
		});

		const res = await post('/update');
		expect(res.status).toBe(500);
		const json = (await res.json()) as {
			error: string;
			steps: Array<{ step: string; ok?: boolean; stderr: string }>;
		};

		const recovery = json.steps.at(-1);
		expect(recovery).toMatchObject({ step: 'up-recovery', ok: false });
		expect(recovery?.stderr).toContain('not healthy: web (exited), mta (exited)');
		expect(recovery?.stderr).toContain('docker compose up -d');
		expect(json.error).toContain('not fully running');
	});

	/**
	 * When the Docker API is what broke, `compose ps` returns nothing — which is
	 * not the same fact as "every service is stopped" and must not be reported
	 * as one.
	 */
	it('reports an unreadable container list as unknown, not as a dead stack', async () => {
		const failing = dockerFailing((cmd) => cmd.includes(' up -d'), 'error during connect: EOF');
		execFileSyncMock.mockImplementation((file: unknown, args: unknown) =>
			[String(file), ...((args as string[]) ?? [])].join(' ').includes(' ps ')
				? ''
				: failing(file, args)
		);

		const res = await post('/update');
		expect(res.status).toBe(500);
		const json = (await res.json()) as { steps: Array<{ step: string; stderr: string }> };
		const recovery = json.steps.at(-1);
		expect(recovery?.step).toBe('up-recovery');
		expect(recovery?.stderr).toContain('could not be read back');
		expect(recovery?.stderr).not.toContain('not healthy');
		expect(recovery?.stderr).not.toContain('not started');
	});

	it('rate-limits update requests', async () => {
		rateLimitedMock.mockReturnValue(true);
		const res = await post('/update');
		expect(res.status).toBe(429);
	});
});

/**
 * `docker compose up -d` returning 0 means the containers were started, not
 * that the release is serving. The answer is a success only once every started
 * service meets the readiness contract (readiness.ts), and from the recreate on
 * it says how far the release got: `healthy`, `started` or `partially-applied`.
 */
describe('POST /update — readiness after the recreate', () => {
	type UpdateAnswer = {
		success?: boolean;
		rollout?: string;
		error?: string;
		steps: Array<{ step: string; ok?: boolean; stdout: string; stderr: string }>;
	};

	/**
	 * Answer the readiness check's `ps` from `script`, repeating its last entry.
	 * The first `ps` is the snapshot taken before `up`, answered by `before`.
	 */
	function psSequence(script: string[], before = composePs(RUNNING)) {
		let call = -1;
		execFileSyncMock.mockImplementation((file: string, args: string[]) => {
			if ([file, ...args].join(' ').includes(' ps --all --format json')) {
				call++;
				return call === 0 ? before : script[Math.min(call - 1, script.length - 1)];
			}
			return dockerFixture(file, args);
		});
	}

	it('answers success with rollout healthy only after the readiness check passed', async () => {
		const res = await post('/update');
		expect(res.status).toBe(200);
		const json = (await res.json()) as UpdateAnswer;
		expect(json).toMatchObject({ success: true, rollout: 'healthy' });
		const readinessStep = json.steps.find((s) => s.step === 'readiness');
		expect(readinessStep?.ok).toBe(true);
		expect(readinessStep?.stdout).toContain('web answered HTTP 200');
		// Checked after the recreate, before the updater hands itself over.
		const order = json.steps.map((s) => s.step);
		expect(order.indexOf('readiness')).toBe(order.indexOf('up') + 1);
		expect(order.at(-1)).toBe('self-update');
	});

	it('does not report success while a running service fails its healthcheck', async () => {
		psSequence([
			composePs([
				{ Service: 'web', State: 'running' },
				{ Service: 'convex', State: 'running', Health: 'unhealthy' },
				{ Service: 'mta', State: 'running' },
			]),
		]);

		const res = await post('/update');
		expect(res.status).toBe(500);
		const json = (await res.json()) as UpdateAnswer;
		expect(json.success).toBeUndefined();
		expect(json.rollout).toBe('started');
		expect(json.error).toContain('convex (failing its healthcheck)');
		expect(json.steps.find((s) => s.step === 'readiness')).toMatchObject({ ok: false });
		// The release is promoted and running either way: the updater still follows it.
		expect(json.steps.at(-1)).toMatchObject({ step: 'self-update', ok: true });
	});

	it('waits for a healthcheck that passes after the recreate returned', async () => {
		const starting = composePs([
			{ Service: 'web', State: 'running' },
			{ Service: 'convex', State: 'running', Health: 'starting' },
			{ Service: 'mta', State: 'running' },
		]);
		psSequence([starting, starting, composePs(RUNNING)]);

		const res = await post('/update');
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, rollout: 'healthy' });
	});

	it('does not report success when a service crashes right after starting', async () => {
		psSequence([
			composePs(RUNNING),
			composePs([
				{ Service: 'web', State: 'running' },
				{ Service: 'convex', State: 'running' },
				{ Service: 'mta', State: 'restarting', Status: 'Restarting (1) 1 second ago' },
			]),
		]);

		const res = await post('/update');
		expect(res.status).toBe(500);
		const json = (await res.json()) as UpdateAnswer;
		expect(json.rollout).toBe('started');
		expect(json.error).toContain('mta (restarting after a crash)');
	});

	it('does not report success while the web app does not answer', async () => {
		readiness.webStatus(503);

		const res = await post('/update');
		expect(res.status).toBe(500);
		const json = (await res.json()) as UpdateAnswer;
		expect(json.rollout).toBe('started');
		expect(json.error).toContain('web answered HTTP 503');
	});

	it('reports a failed recreate as partially applied, and never as a rollback', async () => {
		execFileSyncMock.mockImplementation((file: string, args: string[]) => {
			if ([file, ...args].join(' ').includes(' up -d --remove-orphans')) {
				throw Object.assign(new Error('boom'), { stdout: '', stderr: 'error during connect: EOF' });
			}
			return dockerFixture(file, args);
		});

		const res = await post('/update');
		expect(res.status).toBe(500);
		const json = (await res.json()) as UpdateAnswer;
		expect(json.rollout).toBe('partially-applied');
		expect(json.steps.map((s) => s.step)).not.toContain('readiness');
		expect(`${json.error} ${JSON.stringify(json.steps)}`).not.toMatch(/roll(ed)?[ -]?back/i);
	});

	it('does not call a recovered stack serving while a service in it is unhealthy', async () => {
		execFileSyncMock.mockImplementation((file: string, args: string[]) => {
			const cmd = [file, ...args].join(' ');
			if (cmd.includes(' up -d --remove-orphans')) {
				throw Object.assign(new Error('boom'), { stdout: '', stderr: 'error during connect: EOF' });
			}
			if (cmd.includes(' ps --all --format json')) {
				return composePs([
					{ Service: 'web', State: 'running' },
					{ Service: 'convex', State: 'running', Health: 'unhealthy' },
					{ Service: 'mta', State: 'running' },
				]);
			}
			return dockerFixture(file, args);
		});

		const res = await post('/update');
		const json = (await res.json()) as UpdateAnswer;
		const recovery = json.steps.at(-1);
		expect(recovery).toMatchObject({ step: 'up-recovery', ok: false });
		expect(recovery?.stderr).toContain('convex (failing its healthcheck)');
		expect(json.error).not.toContain('serving again');
		expect(json.rollout).toBe('partially-applied');
	});
});

describe('POST /update — failures that were there before', () => {
	const convexUnhealthy = composePs([
		{ Service: 'web', State: 'running' },
		{ Service: 'convex', State: 'running', Health: 'unhealthy' },
		{ Service: 'mta', State: 'running' },
	]);

	it('reports a service already unhealthy before the update as a warning, not a failure', async () => {
		execFileSyncMock.mockImplementation((file: string, args: string[]) =>
			[file, ...args].join(' ').includes(' ps --all --format json')
				? convexUnhealthy
				: dockerFixture(file, args)
		);

		const res = await post('/update');
		expect(res.status).toBe(200);
		const json = (await res.json()) as { rollout?: string; warnings?: string[] };
		expect(json.rollout).toBe('healthy');
		expect(json.warnings).toEqual([
			'convex was already failing its healthcheck before the update and is still failing its healthcheck',
		]);
	});

	it('still fails a service the update broke', async () => {
		let calls = 0;
		execFileSyncMock.mockImplementation((file: string, args: string[]) =>
			[file, ...args].join(' ').includes(' ps --all --format json')
				? calls++ === 0
					? composePs(RUNNING)
					: convexUnhealthy
				: dockerFixture(file, args)
		);

		const res = await post('/update');
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ rollout: 'started', warnings: [] });
	});
});

describe('the last rollout, on /health', () => {
	const RECORD = join(OWLAT_DIR, '.owlat-last-rollout.json');
	const TEMPLATE = [
		'services:',
		'  web:',
		`    image: ghcr.io/wolvesdotink/web:0.4.17@sha256:${'a'.repeat(64)}`,
		'',
	].join('\n');

	async function health() {
		const res = await fetch(`${base}/health`, { headers: AUTH });
		return (await res.json()) as {
			lastRollout: Record<string, unknown> | null;
			rolloutInProgress: string | null;
		};
	}

	it('is written while the update waits for readiness, then carries the verdict', async () => {
		const phases: string[] = [];
		let calls = 0;
		execFileSyncMock.mockImplementation((file: string, args: string[]) => {
			if ([file, ...args].join(' ').includes(' ps --all --format json') && calls++ > 0) {
				phases.push(JSON.parse(readFileSync(RECORD, 'utf-8')).phase);
			}
			return dockerFixture(file, args);
		});

		const res = await post('/update', { composeTemplate: TEMPLATE });
		expect(res.status).toBe(200);

		expect(phases[0]).toBe('verifying');
		const { lastRollout } = await health();
		expect(lastRollout).toMatchObject({
			targetVersion: '0.4.17',
			phase: 'done',
			outcome: 'healthy',
			warnings: [],
		});
		expect(lastRollout?.['summary']).toContain('services are up');
	});

	it("echoes the caller's attempt id, and drops one that is not a plain token", async () => {
		await post('/update', {
			composeTemplate: TEMPLATE,
			attempt: 'a1b2c3d4-0000-4000-8000-000000000001',
		});
		expect((await health()).lastRollout).toMatchObject({
			attempt: 'a1b2c3d4-0000-4000-8000-000000000001',
		});

		await post('/update', { composeTemplate: TEMPLATE, attempt: '<script>alert(1)</script>' });
		expect((await health()).lastRollout).not.toHaveProperty('attempt');
	});

	it('records a rollout that started but did not become healthy as started', async () => {
		readiness.webStatus(503);

		await post('/update', { composeTemplate: TEMPLATE });

		const { lastRollout } = await health();
		expect(lastRollout).toMatchObject({ targetVersion: '0.4.17', outcome: 'started' });
		expect(lastRollout?.['summary']).toContain('web answered HTTP 503');
	});

	it('records an update that stopped before the recreate as failed', async () => {
		execFileSyncMock.mockImplementation(dockerFailing((c) => c.includes(' pull'), 'pull denied'));

		await post('/update', { composeTemplate: TEMPLATE });

		expect((await health()).lastRollout).toMatchObject({ phase: 'done', outcome: 'failed' });
	});

	it('reports a record left mid-rollout by an updater that stopped as interrupted', async () => {
		writeFileSync(
			RECORD,
			JSON.stringify({ targetVersion: '0.4.17', startedAt: 1, phase: 'verifying' })
		);

		const { lastRollout, rolloutInProgress } = await health();

		expect(rolloutInProgress).toBeNull();
		expect(lastRollout).toMatchObject({ phase: 'done', outcome: 'interrupted' });
	});
});

describe('one rollout at a time', () => {
	/**
	 * Holds an /update inside the rollout lock: its handler waits for a request
	 * body that only arrives when `release` is called.
	 */
	async function updateInFlight() {
		const { request } = await import('node:http');
		const req = request(`${base}/update`, {
			method: 'POST',
			headers: { ...AUTH, 'content-type': 'application/json' },
		});
		const answered = new Promise<number>((resolve) =>
			req.on('response', (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			})
		);
		req.flushHeaders();
		req.write('{"compose');
		// Until the server is inside the handler, the lock is not taken yet.
		for (let i = 0; i < 50; i++) {
			const res = await fetch(`${base}/health`, { headers: AUTH });
			if (((await res.json()) as { rolloutInProgress: string | null }).rolloutInProgress) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		return {
			release: () => {
				req.end('Template":null}');
				return answered;
			},
		};
	}

	it.each(['/update', '/apply-profiles', '/rotate-env'])(
		'answers 409 to %s while an update is in flight, and runs nothing',
		async (path) => {
			const inFlight = await updateInFlight();
			execFileSyncMock.mockClear();

			const res = await post(path, {});

			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: string }).error).toContain('still applying an update');
			expect(execFileSyncMock).not.toHaveBeenCalled();
			expect(await inFlight.release()).toBe(200);
		}
	);

	it('releases the lock once the rollout answered, even when it failed', async () => {
		execFileSyncMock.mockImplementation(dockerFailing((c) => c.includes(' pull'), 'pull denied'));
		expect((await post('/update')).status).toBe(500);

		execFileSyncMock.mockImplementation(dockerFixture);
		expect((await post('/update')).status).toBe(200);
	});

	it('does not tell an unauthenticated caller that a rollout is in flight', async () => {
		const inFlight = await updateInFlight();

		const res = await post('/apply-profiles', {}, {});

		expect(res.status).toBe(401);
		await inFlight.release();
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
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	it('adds the IP to IP_POOLS_CAMPAIGN and restarts the MTA', async () => {
		const res = await post('/configure-ip', { ip: '2.2.2.2', action: 'add' });
		expect(res.status).toBe(200);
		const env = readFileSync(join(OWLAT_DIR, '.env'), 'utf-8');
		expect(env).toContain('IP_POOLS_CAMPAIGN=1.1.1.1,2.2.2.2');
		// The IP was validated before it reached `exec`, so the old
		// `exec(`ip addr add ${ip}/32 …`)` was not exploitable — but it went
		// through a shell, so the next value interpolated into one of these
		// would have been. Pin the argv: the address is ONE argument, and
		// nothing here is a command line.
		expect(execFileSyncMock.mock.calls).toContainEqual([
			'ip',
			['addr', 'add', '2.2.2.2/32', 'dev', 'eth0'],
			expect.objectContaining({ cwd: '/' }),
		]);
		expect(commandLines()).toContain('docker compose restart mta');
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
		const res = await post('/rotate-env', {
			...valid,
			mtaApiKey: 'evil\nINJECTED=1-padme-16chars',
		});
		expect(res.status).toBe(400);
	});

	it('rewrites the env keys in place and force-recreates containers', async () => {
		const res = await post('/rotate-env', valid);
		expect(res.status).toBe(200);
		const env = readFileSync(join(OWLAT_DIR, '.env'), 'utf-8');
		expect(env).toContain(`INSTANCE_SECRET=${valid.instanceSecret}`);
		expect(env).toContain('FOO=bar'); // untouched lines preserved
		// Named services: force-recreating the updater would stop this very
		// process partway down the list, leaving the rest on the old secret.
		expect(composeCommands()).toContain(`${COMPOSE} up -d --force-recreate web convex mta`);
		expect(commandLines().some((c) => c.startsWith('docker run'))).toBe(true);
	});

	/**
	 * This used to decide the recreate's fate by grepping its stderr for
	 * "error" — the exact test `exec` was rewritten to make unnecessary. The
	 * failure that matters most here does not contain the word: the Docker API
	 * answers "Cannot connect to the Docker daemon at tcp://docker-socket-proxy".
	 * So a rotation that recreated NOTHING answered 200, and every container
	 * kept serving on the old secret while `.env` said otherwise.
	 */
	it('fails a recreate that exits non-zero, even when stderr never says "error"', async () => {
		execFileSyncMock.mockImplementation((file: string, args: string[]) => {
			const cmd = [file, ...args].join(' ');
			if (cmd.includes(' up -d --force-recreate')) {
				const err = new Error('boom') as Error & { stdout: string; stderr: string };
				err.stdout = '';
				err.stderr = 'Cannot connect to the Docker daemon at tcp://docker-socket-proxy:2375.';
				throw err;
			}
			if (cmd.includes(' ps --all --format json')) return composePs(RUNNING);
			return dockerFixture(file, args);
		});

		const res = await post('/rotate-env', valid);
		expect(res.status).toBe(500);
		const json = (await res.json()) as { error: string; recovery: { step: string; ok?: boolean } };
		expect(json.recovery).toMatchObject({ step: 'up-recovery', ok: true });
		expect(json.error).toContain('serving again');
		// …and the updater is NOT handed its own replacement on a failed rotation.
		expect(commandLines().some((c) => c.startsWith('docker run'))).toBe(false);
	});
});

describe('GET /health', () => {
	it('requires auth (no container enumeration)', async () => {
		const res = await fetch(`${base}/health`);
		expect(res.status).toBe(401);
	});

	it('reports parsed container rows with image tags', async () => {
		execFileSyncMock.mockReturnValue(
			'{"Service":"web","State":"running","Status":"Up 2 hours","Image":"ghcr.io/wolvesdotink/web:1.2.3","Health":"healthy"}\n'
		);
		const res = await fetch(`${base}/health`, { headers: AUTH });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { containers: Array<Record<string, unknown>> };
		expect(json.containers[0]).toMatchObject({ service: 'web', imageTag: '1.2.3' });
	});

	/**
	 * `version` is the updater container's baked-in OWLAT_VERSION — what is
	 * RUNNING. Without the CONFIGURED value from `.env` alongside it, no caller
	 * of /health can tell that the two have diverged.
	 */
	describe('version drift', () => {
		function health() {
			return fetch(`${base}/health`, { headers: AUTH }).then(
				(res) =>
					res.json() as Promise<{
						version: string;
						configuredVersion: string | null;
						versionDrift: boolean | null;
					}>
			);
		}

		it('reports drift when .env was advanced but containers were never recreated', async () => {
			// The observed production case: .env says 0.4.13, every container 0.4.12.
			writeFileSync(join(OWLAT_DIR, '.env'), 'OWLAT_VERSION=0.4.13\nFOO=bar\n');
			execFileSyncMock.mockReturnValue(
				['web', 'mta', 'imap']
					.map(
						(name) =>
							`{"Service":"${name}","State":"running","Status":"Up 2 hours","Image":"ghcr.io/wolvesdotink/${name}:0.4.12","Health":"healthy"}`
					)
					.join('\n')
			);
			const json = await health();
			expect(json.configuredVersion).toBe('0.4.13');
			expect(json.versionDrift).toBe(true);
		});

		it('reports no drift when every container runs the configured version', async () => {
			writeFileSync(join(OWLAT_DIR, '.env'), 'OWLAT_VERSION=0.4.13\n');
			execFileSyncMock.mockReturnValue(
				'{"Service":"web","State":"running","Status":"Up 2 hours","Image":"ghcr.io/wolvesdotink/web:0.4.13","Health":"healthy"}\n'
			);
			const json = await health();
			expect(json.configuredVersion).toBe('0.4.13');
			expect(json.versionDrift).toBe(false);
		});

		it('ignores third-party images pinned to their own versions', async () => {
			writeFileSync(join(OWLAT_DIR, '.env'), 'OWLAT_VERSION=0.4.13\n');
			execFileSyncMock.mockReturnValue(
				[
					'{"Service":"web","State":"running","Status":"Up","Image":"ghcr.io/wolvesdotink/web:0.4.13","Health":"healthy"}',
					'{"Service":"redis","State":"running","Status":"Up","Image":"redis:7.4-alpine","Health":"healthy"}',
					'{"Service":"caddy","State":"running","Status":"Up","Image":"caddy:2.8-alpine","Health":""}',
				].join('\n')
			);
			expect((await health()).versionDrift).toBe(false);
		});

		it('answers null — never a false verdict — when .env carries no OWLAT_VERSION', async () => {
			writeFileSync(join(OWLAT_DIR, '.env'), 'FOO=bar\n');
			execFileSyncMock.mockReturnValue(
				'{"Service":"web","State":"running","Status":"Up","Image":"ghcr.io/wolvesdotink/web:0.4.12","Health":"healthy"}\n'
			);
			const json = await health();
			expect(json.configuredVersion).toBeNull();
			expect(json.versionDrift).toBeNull();
		});

		it('still reports container facts when .env cannot be read', async () => {
			rmSync(join(OWLAT_DIR, '.env'));
			execFileSyncMock.mockReturnValue(
				'{"Service":"web","State":"running","Status":"Up","Image":"ghcr.io/wolvesdotink/web:0.4.12","Health":"healthy"}\n'
			);
			const res = await fetch(`${base}/health`, { headers: AUTH });
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				configuredVersion: string | null;
				containers: Array<Record<string, unknown>>;
			};
			expect(json.configuredVersion).toBeNull();
			expect(json.containers[0]).toMatchObject({ service: 'web' });
		});
	});
});
