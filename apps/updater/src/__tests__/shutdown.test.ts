import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShutdown, type ShutdownHandle } from '@owlat/shared/nodeShutdown';
import type * as Security from '../security.js';

/**
 * The updater under SIGTERM, against a fake `docker` that is a real process.
 *
 * `docker` here is a shell script on PATH: it logs each command, answers the
 * reads the rollout makes, and holds `pull` and `up` open until the test
 * releases them. The handlers spawn it for real, so what is pinned is what the
 * shutdown actually does to a command in flight: the updater keeps answering
 * while one runs, a rollout that has not promoted its release backs out and
 * stops the command, and one that has finishes its recreate first.
 */

const { rateLimitedMock } = vi.hoisted(() => ({ rateLimitedMock: vi.fn(() => false) }));
vi.mock('../security.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Security>();
	return { ...actual, isRateLimited: rateLimitedMock };
});

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-updater-shutdown-'));
const FAKE = mkdtempSync(join(tmpdir(), 'owlat-fake-docker-'));
mkdirSync(join(FAKE, 'bin'));
writeFileSync(
	join(FAKE, 'bin', 'docker'),
	`#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_DIR/calls"
hold() {
	echo $$ > "$FAKE_DOCKER_DIR/$1.pid"
	while [ ! -e "$FAKE_DOCKER_DIR/release-$1" ]; do sleep 0.02; done
}
case "$*" in
	*"config --services"*) printf 'web\\nupdater\\n' ;;
	*"config --format json"*) echo '{}' ;;
	*"ps --all --format json"*) echo '{"Service":"web","State":"running","Image":"","Health":""}' ;;
	*" pull"*) hold pull ;;
	*"up -d"*) hold up ;;
	"run -d"*) echo helper-container-id ;;
	inspect*org.opencontainers*) ;;
	inspect*) printf 'ghcr.io/wolvesdotink/updater:0.5.0\\n/srv/owlat:%s:rw \\nowlat_default \\n' "$OWLAT_DIR" ;;
esac
exit 0
`
);
chmodSync(join(FAKE, 'bin', 'docker'), 0o755);

process.env['INSTANCE_SECRET'] = 'test-instance-secret-0123456789';
process.env['OWLAT_DIR'] = OWLAT_DIR;
process.env['PORT'] = '0';
process.env['FAKE_DOCKER_DIR'] = FAKE;
process.env['PATH'] = `${join(FAKE, 'bin')}:${process.env['PATH']}`;

const { buildRequestListener } = await import('../server.js');
const { beginShutdown, setShutdownHandle } = await import('../lifecycle.js');
const { reconcileInterruptedUpdate } = await import('../update.js');
const { readLastRollout, writeLastRollout } = await import('../rolloutState.js');
const { fastReadiness } = await import('./readinessStubs.js');

const AUTH = { 'x-instance-secret': 'test-instance-secret-0123456789' };
const OLD_COMPOSE = 'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:0.4.16\n';
const NEW_COMPOSE = 'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:0.4.17\n';

let server: Server;
let base: string;
let readiness: ReturnType<typeof fastReadiness>;
let handle: ShutdownHandle;
let exit: ReturnType<typeof vi.fn<(code: number) => void>>;

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
	// Removed, not emptied: `hold` waits for its release file to exist.
	for (const file of ['calls', 'release-pull', 'release-up', 'pull.pid', 'up.pid']) {
		rmSync(join(FAKE, file), { force: true });
	}
	writeFileSync(join(OWLAT_DIR, '.env'), 'FOO=bar\nOWLAT_VERSION=0.4.16\n');
	writeFileSync(join(OWLAT_DIR, 'docker-compose.yml'), OLD_COMPOSE);
	exit = vi.fn<(code: number) => void>();
	// Signals are delivered by the test (`handle.shutdown`), never by the OS,
	// and the server is the test's own: the shutdown must not close it.
	handle = installShutdown({
		timeoutMs: 10_000,
		log: () => {},
		signals: [],
		exit,
		onShutdown: beginShutdown,
	});
	setShutdownHandle(handle);
});

afterEach(() => {
	// Whatever a test left holding, let it go so no fake command outlives it.
	writeFileSync(join(FAKE, 'release-pull'), '');
	writeFileSync(join(FAKE, 'release-up'), '');
	setShutdownHandle(undefined);
});

function calls(): string[] {
	const path = join(FAKE, 'calls');
	return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean) : [];
}

/** Resolve once the fake docker has started `step` (and is holding it). */
async function started(step: 'pull' | 'up'): Promise<number> {
	const pidFile = join(FAKE, `${step}.pid`);
	for (let i = 0; i < 250; i++) {
		if (existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim()) {
			return Number(readFileSync(pidFile, 'utf-8'));
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`fake docker never started ${step}; calls: ${calls().join(' / ')}`);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function update() {
	return fetch(`${base}/update`, {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ composeTemplate: NEW_COMPOSE, attempt: 'attempt-0001' }),
	});
}

describe('while a Docker command runs', () => {
	it('answers /health and turns a second rollout away with 409', async () => {
		const updating = update();
		await started('pull');

		const health = await fetch(`${base}/health`, { headers: AUTH });
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ rolloutInProgress: 'update' });

		const second = await fetch(`${base}/apply-profiles`, {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({ flags: {} }),
		});
		expect(second.status).toBe(409);

		writeFileSync(join(FAKE, 'release-pull'), '');
		writeFileSync(join(FAKE, 'release-up'), '');
		expect((await updating).status).toBe(200);
	});
});

describe('SIGTERM during an update', () => {
	it('before the promote: stops the pull, backs out, and says the stack is unchanged', async () => {
		const updating = update();
		const pullPid = await started('pull');

		const shutting = handle.shutdown('SIGTERM');
		const res = await updating;
		await shutting;

		expect(res.status).toBe(503);
		const body = (await res.json()) as { rollout: string; error: string };
		expect(body.rollout).toBe('interrupted');
		expect(body.error).toContain('The running stack was not changed');
		// The pull was stopped, not waited out, and nothing after it ran.
		expect(alive(pullPid)).toBe(false);
		expect(calls().some((c) => c.includes('convex-deploy'))).toBe(false);
		expect(calls().some((c) => c.includes('up -d'))).toBe(false);
		// The host is as it was: live file untouched, staged file gone.
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(OLD_COMPOSE);
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
		expect(readLastRollout()).toMatchObject({
			attempt: 'attempt-0001',
			phase: 'done',
			outcome: 'interrupted',
		});
		expect(readLastRollout()?.committed).toBeUndefined();
		expect(exit).toHaveBeenCalledWith(0);
	});

	it('after the promote: finishes the recreate before the process may exit', async () => {
		const updating = update();
		await started('pull');
		writeFileSync(join(FAKE, 'release-pull'), '');
		const upPid = await started('up');

		const shutting = handle.shutdown('SIGTERM');
		await new Promise((resolve) => setTimeout(resolve, 200));
		// Still recreating: the recreate is not stopped and the exit waits.
		expect(alive(upPid)).toBe(true);
		expect(exit).not.toHaveBeenCalled();

		writeFileSync(join(FAKE, 'release-up'), '');
		const res = await updating;
		await shutting;

		// Started, and said to be unconfirmed: no silent success.
		expect(res.status).toBe(503);
		const body = (await res.json()) as {
			rollout: string;
			error: string;
			steps: { step: string; ok?: boolean; stderr: string }[];
		};
		expect(body.rollout).toBe('started');
		expect(body.error).toContain('stopped checking whether they are serving');
		expect(body.steps.find((s) => s.step === 'up')).toMatchObject({ ok: true });
		// Its own replacement is not scheduled on the way out.
		expect(body.steps.find((s) => s.step === 'self-update')?.stderr).toContain(
			'did not schedule its own replacement'
		);
		expect(calls().some((c) => c.startsWith('run -d'))).toBe(false);

		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(NEW_COMPOSE);
		expect(readLastRollout()).toMatchObject({
			phase: 'done',
			outcome: 'started',
			committed: true,
		});
		expect(exit).toHaveBeenCalledWith(0);
	});
});

describe('reconcileInterruptedUpdate', () => {
	/** A process killed mid-rollout leaves its record in flight. */
	it.each([
		[false, 'The running stack was not changed'],
		[true, '`docker compose up -d`'],
	])(
		'turns an in-flight record (committed: %s) into an interrupted verdict',
		async (committed, says) => {
			writeFileSync(join(OWLAT_DIR, 'docker-compose.next.yml'), NEW_COMPOSE);
			writeLastRollout({
				attempt: 'attempt-0002',
				targetVersion: '0.4.17',
				startedAt: Date.now() - 60_000,
				phase: committed ? 'verifying' : 'applying',
				...(committed ? { committed } : {}),
			});
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

			const verdict = await reconcileInterruptedUpdate();

			expect(verdict).toMatchObject({ phase: 'done', outcome: 'interrupted' });
			expect(verdict?.summary).toContain(says);
			// Durable: on disk, not only in the /health translation.
			const onDisk = JSON.parse(readFileSync(join(OWLAT_DIR, '.owlat-last-rollout.json'), 'utf-8'));
			expect(onDisk).toMatchObject({
				attempt: 'attempt-0002',
				phase: 'done',
				outcome: 'interrupted',
			});
			expect(onDisk.finishedAt).toEqual(expect.any(Number));
			expect(logged).toHaveBeenCalledWith(expect.stringContaining(says));
			// A staged template nobody promoted is not left looking like a pending release.
			expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
			logged.mockRestore();
		}
	);

	it('leaves a finished record alone', async () => {
		writeLastRollout({
			targetVersion: '0.4.17',
			startedAt: 1,
			phase: 'done',
			outcome: 'healthy',
			finishedAt: 2,
		});

		expect(await reconcileInterruptedUpdate()).toBeNull();
		expect(readLastRollout()).toMatchObject({ outcome: 'healthy', finishedAt: 2 });
	});
});
