/**
 * The snapshot an update takes before `convex-deploy`, and the rollback to it
 * (snapshot.ts, snapshotCapture.ts, rollback.ts). Docker is scripted: the copy
 * helpers write and read real payload files in a temp install directory, so
 * the checksums and the restored configuration are the real thing.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import type * as Security from '../security.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { commandMock, freeBytesMock } = vi.hoisted(() => ({
	commandMock: vi.fn(),
	freeBytesMock: vi.fn((): number => 50 * 1024 ** 3),
}));
vi.mock('node:child_process', async () => {
	const { spawnFrom } = await import('./fakeSpawn.js');
	return { spawn: spawnFrom(commandMock) };
});
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return { ...actual, statfsSync: () => ({ bavail: freeBytesMock(), bsize: 1 }) };
});
vi.mock('../security.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Security>();
	return { ...actual, isRateLimited: () => false };
});

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-rollback-test-'));
process.env['INSTANCE_SECRET'] = 'test-instance-secret-0123456789';
process.env['OWLAT_DIR'] = OWLAT_DIR;

const { buildRequestListener } = await import('../server.js');
const { reconcileInterruptedUpdate } = await import('../update.js');
const { fastReadiness } = await import('./readinessStubs.js');

const SNAPSHOT_DIR = join(OWLAT_DIR, '.owlat-update-snapshot');
const JOURNAL = join(SNAPSHOT_DIR, 'snapshot.json');
const RECORD = join(OWLAT_DIR, '.owlat-last-rollout.json');
const HOST_INSTALL_DIR = '/srv/owlat';
const AUTH = { 'x-instance-secret': 'test-instance-secret-0123456789' };

const OLD_COMPOSE = 'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:0.4.16\n';
const OLD_ENV = 'FOO=bar\nOWLAT_VERSION=0.4.16\n';
const TEMPLATE = [
	'services:',
	'  web:',
	`    image: ghcr.io/wolvesdotink/web:0.4.17@sha256:${'a'.repeat(64)}`,
	'',
].join('\n');

/** The stack's containers: convex and redis hold data, web does not. */
const CONTAINERS = {
	convex: 'c0ffee000001',
	redis: 'c0ffee000002',
	web: 'c0ffee000003',
};

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

/** What each scripted command line does, for one case. */
let overrides: Array<(cmd: string) => string | undefined>;

beforeEach(() => {
	readiness.webStatus(200);
	freeBytesMock.mockReset().mockReturnValue(50 * 1024 ** 3);
	overrides = [];
	commandMock.mockReset().mockImplementation((file: string, args: string[]) => {
		const cmd = [file, ...args].join(' ');
		for (const override of overrides) {
			const answer = override(cmd);
			if (answer !== undefined) return answer;
		}
		return docker(cmd, args);
	});
	rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
	rmSync(RECORD, { force: true });
	writeFileSync(join(OWLAT_DIR, 'docker-compose.yml'), OLD_COMPOSE);
	writeFileSync(join(OWLAT_DIR, '.env'), OLD_ENV, { mode: 0o600 });
});

function fail(stderr: string): never {
	throw Object.assign(new Error('boom'), { stdout: '', stderr });
}

/** A healthy Docker host with a convex and a redis that keep their data in volumes. */
function docker(cmd: string, args: string[]): string {
	if (cmd.includes('config --services'))
		return 'web\nconvex\nredis\nupdater\ndocker-socket-proxy\n';
	if (cmd.endsWith(' ps --all --quiet')) return `${Object.values(CONTAINERS).join('\n')}\n`;
	if (cmd.startsWith('docker inspect --format {{.Id}}')) {
		return [
			`${CONTAINERS.convex}|true|convex|volume=owlat_convex-data `,
			`${CONTAINERS.redis}|true|redis|volume=owlat_redis-data `,
			`${CONTAINERS.web}|true|web|`,
		].join('\n');
	}
	if (cmd.startsWith('docker inspect')) {
		return [
			'ghcr.io/wolvesdotink/updater:0.4.16',
			`${HOST_INSTALL_DIR}:${OWLAT_DIR}:rw `,
			'owlat_default owlat_docker-proxy ',
		].join('\n');
	}
	if (cmd.startsWith('docker run') && cmd.includes('--entrypoint du'))
		return '1024\t/m0\n16\t/m1\n';
	if (cmd.startsWith('docker run') && cmd.includes('--entrypoint tar')) {
		// The copy helper writes the payload through the install bind.
		const source = args[args.indexOf('-v') + 1]?.split(':')[0];
		const payload = args.at(-4)?.replace('/snapshot/', '') ?? '';
		writeFileSync(join(SNAPSHOT_DIR, payload), `copy of ${source}`);
		return '';
	}
	if (cmd.startsWith('docker run') && cmd.includes(':/target')) return '';
	if (cmd.startsWith('docker run')) return 'helper-container-id\n';
	if (cmd.startsWith('docker ps --quiet --no-trunc --filter volume=')) return '';
	if (cmd.endsWith(' ps --format json convex')) return composePs(RUNNING);
	if (cmd.includes(' ps --all --format json')) return composePs(RUNNING);
	return '';
}

function composePs(rows: Array<{ Service: string; State: string; Health?: string }>): string {
	return rows
		.map((row) => JSON.stringify({ Image: 'ghcr.io/wolvesdotink/x:1.0.0', Health: '', ...row }))
		.join('\n');
}

const RUNNING = [
	{ Service: 'web', State: 'running' },
	{ Service: 'convex', State: 'running' },
	{ Service: 'redis', State: 'running' },
];

function commandLines(): string[] {
	return commandMock.mock.calls.map((c) => [String(c[0]), ...(c[1] as string[])].join(' '));
}

const indexOf = (match: (cmd: string) => boolean) => commandLines().findIndex(match);
const lastIndexOf = (match: (cmd: string) => boolean) => commandLines().findLastIndex(match);
const isDeploy = (cmd: string) => cmd.includes('convex-deploy');
const isRestore = (cmd: string) => cmd.startsWith('docker run') && cmd.includes(':/target');

function post(path: string, body?: unknown) {
	return fetch(`${base}${path}`, {
		method: 'POST',
		headers: AUTH,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

type Answer = {
	success?: boolean;
	rollout?: string;
	error?: string;
	description?: string;
	steps: Array<{ step: string; ok?: boolean; stdout: string; stderr: string }>;
};

async function update(): Promise<{ status: number; json: Answer }> {
	const res = await post('/update', { composeTemplate: TEMPLATE });
	return { status: res.status, json: (await res.json()) as Answer };
}

const journal = () => JSON.parse(readFileSync(JOURNAL, 'utf-8')) as Record<string, unknown>;

/** The new release fails its readiness check; the one the snapshot holds passes it. */
function newReleaseNotReady(): void {
	readiness.webStatus(503);
	overrides.push((cmd) => {
		if (isRestore(cmd)) readiness.webStatus(200);
		return undefined;
	});
}

describe('the snapshot before convex-deploy', () => {
	it('pauses convex and redis, copies their volumes and the config, and only then deploys', async () => {
		const { status, json } = await update();
		expect(status).toBe(200);
		expect(json.rollout).toBe('healthy');

		const stop = indexOf((c) => c.startsWith('docker stop'));
		const copies = commandLines().filter((c) => c.includes('--entrypoint tar'));
		const start = indexOf((c) => c.startsWith('docker start'));
		expect(commandLines()[stop]).toBe(`docker stop ${CONTAINERS.convex} ${CONTAINERS.redis}`);
		expect(copies).toEqual([
			expect.stringContaining('-v owlat_convex-data:/source:ro'),
			expect.stringContaining('-v owlat_redis-data:/source:ro'),
		]);
		// The copy runs in a helper with no network, reaching the snapshot through the HOST path.
		expect(copies[0]).toContain(`-v ${HOST_INSTALL_DIR}/.owlat-update-snapshot:/snapshot`);
		expect(copies[0]).toContain('--network none');
		expect(commandLines()[start]).toBe(`docker start ${CONTAINERS.convex} ${CONTAINERS.redis}`);
		expect(start).toBeGreaterThan(indexOf((c) => c.includes('--entrypoint tar')));
		expect(indexOf(isDeploy)).toBeGreaterThan(start);

		expect(json.steps.map((s) => s.step).indexOf('snapshot')).toBe(
			json.steps.map((s) => s.step).indexOf('pull') + 1
		);
		expect(readFileSync(join(SNAPSHOT_DIR, 'config', 'docker-compose.yml'), 'utf-8')).toBe(
			OLD_COMPOSE
		);
		expect(readFileSync(join(SNAPSHOT_DIR, 'config', '.env'), 'utf-8')).toBe(OLD_ENV);
		expect(statSync(join(SNAPSHOT_DIR, 'config', '.env')).mode & 0o777).toBe(0o600);
	});

	it('keeps the snapshot once the release is confirmed ready, and never rolls back to it on its own', async () => {
		await update();
		expect(journal()).toMatchObject({
			state: 'kept',
			fromVersion: '0.4.16',
			targetVersion: '0.4.17',
		});
		expect(commandLines().some(isRestore)).toBe(false);
	});

	it('aborts before the deploy, with convex and redis started again, when the copy fails', async () => {
		overrides.push((cmd) =>
			cmd.includes('--entrypoint tar') && cmd.includes('owlat_redis-data')
				? fail('no space left on device')
				: undefined
		);
		const { status, json } = await update();

		expect(status).toBe(500);
		expect(json.error).toContain('copying owlat_redis-data failed');
		expect(json.error).toContain('Nothing was changed');
		expect(commandLines()).toContain(`docker start ${CONTAINERS.convex} ${CONTAINERS.redis}`);
		expect(indexOf(isDeploy)).toBe(-1);
		expect(existsSync(SNAPSHOT_DIR)).toBe(false);
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(OLD_COMPOSE);
	});

	it('refuses before pausing anything when the disk cannot hold the copy', async () => {
		freeBytesMock.mockReturnValue(5 * 1024 ** 3);
		// The disk check before the pull passes; the copy needs more than is left.
		overrides.push((cmd) =>
			cmd.includes('--entrypoint du') ? `${8 * 1024 * 1024}\t/m0\n16\t/m1\n` : undefined
		);
		const { status, json } = await update();

		expect(status).toBe(507);
		expect(json.error).toContain('Not enough disk space for the snapshot');
		expect(json.error).toContain('OWLAT_UPDATE_SNAPSHOT=off');
		expect(indexOf((c) => c.startsWith('docker stop'))).toBe(-1);
		expect(indexOf(isDeploy)).toBe(-1);
	});

	it('takes no snapshot when .env turns it off, and says a failure will not be rolled back', async () => {
		writeFileSync(join(OWLAT_DIR, '.env'), `${OLD_ENV}OWLAT_UPDATE_SNAPSHOT=off\n`);
		const { status, json } = await update();

		expect(status).toBe(200);
		expect(json.steps.find((s) => s.step === 'snapshot')?.stdout).toContain('not rolled back');
		expect(indexOf((c) => c.startsWith('docker stop'))).toBe(-1);
		expect(existsSync(SNAPSHOT_DIR)).toBe(false);
	});
});

describe('the automatic rollback', () => {
	it('restores the data, compose file and .env when the release does not pass readiness', async () => {
		newReleaseNotReady();
		const { status, json } = await update();

		expect(status).toBe(500);
		expect(json.rollout).toBe('rolled-back');
		expect(json.error).toContain('did not pass the readiness check');
		expect(json.error).toContain('The update was rolled back to the snapshot');
		expect(json.error).toContain('discarded');

		const restores = commandLines().filter(isRestore);
		expect(restores).toEqual([
			expect.stringContaining('-v owlat_convex-data:/target'),
			expect.stringContaining('-v owlat_redis-data:/target'),
		]);
		expect(restores[0]).toContain('/snapshot/data/m0.tar');
		// The writers are stopped before a byte is overwritten.
		expect(
			lastIndexOf((c) => c === `docker stop ${CONTAINERS.convex} ${CONTAINERS.redis}`)
		).toBeGreaterThan(indexOf((c) => c.includes(' up -d --remove-orphans')));
		expect(
			lastIndexOf((c) => c === `docker stop ${CONTAINERS.convex} ${CONTAINERS.redis}`)
		).toBeLessThan(indexOf(isRestore));
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(OLD_COMPOSE);
		expect(readFileSync(join(OWLAT_DIR, '.env'), 'utf-8')).toBe(OLD_ENV);
		expect(json.steps.map((s) => s.step).slice(-3)).toEqual([
			'rollback-restore',
			'rollback-up',
			'rollback-readiness',
		]);
		expect(json.steps.at(-1)?.ok).toBe(true);
		// The updater never moved to the release that was rolled back.
		expect(json.steps.map((s) => s.step)).not.toContain('self-update');
		expect(journal()).toMatchObject({ state: 'restored' });

		const record = JSON.parse(readFileSync(RECORD, 'utf-8'));
		expect(record).toMatchObject({ phase: 'done', outcome: 'rolled-back', committed: true });
	});

	it('rolls back instead of starting forward when the recreate fails', async () => {
		let ups = 0;
		overrides.push((cmd) =>
			cmd.includes(' up -d --remove-orphans') && ups++ === 0
				? fail('error during connect: EOF')
				: undefined
		);
		const { json } = await update();

		expect(json.rollout).toBe('rolled-back');
		expect(json.steps.map((s) => s.step)).not.toContain('up-recovery');
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(OLD_COMPOSE);
	});

	it('rolls back a deploy cut off by its bound, which might still go live', async () => {
		overrides.push((cmd) => (isDeploy(cmd) ? fail('docker timed out after 900s') : undefined));
		const { json } = await update();

		expect(json.rollout).toBe('rolled-back');
		expect(json.error).toMatch(/^convex-deploy timed out/);
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
	});

	it('drops the snapshot of a stack a rejected deploy never changed', async () => {
		overrides.push((cmd) => (isDeploy(cmd) ? fail('Error: schema validation failed') : undefined));
		const { json } = await update();

		expect(json.error).toContain('running stack untouched');
		expect(commandLines().some(isRestore)).toBe(false);
		expect(existsSync(SNAPSHOT_DIR)).toBe(false);
	});

	it('says so, and refuses the next update, when the restore fails partway', async () => {
		newReleaseNotReady();
		overrides.push((cmd) =>
			isRestore(cmd) && cmd.includes('owlat_redis-data') ? fail('i/o error') : undefined
		);
		const { json } = await update();

		expect(json.rollout).toBe('failed');
		expect(json.error).toContain('Rolling back failed partway');
		expect(json.error).toContain('owlat rollback');
		expect(journal()).toMatchObject({ state: 'restoring' });

		const next = await update();
		expect(next.status).toBe(409);
		expect(next.json.error).toContain('did not finish');
		expect(next.json.steps.map((s) => s.step)).not.toContain('convex-deploy');
	});

	it('restores nothing from a snapshot whose copy has changed since it was taken', async () => {
		newReleaseNotReady();
		overrides.push((cmd) => {
			if (
				cmd.includes(' up -d --remove-orphans') &&
				existsSync(join(SNAPSHOT_DIR, 'data', 'm0.tar'))
			) {
				writeFileSync(join(SNAPSHOT_DIR, 'data', 'm0.tar'), 'tampered');
			}
			return undefined;
		});
		const { json } = await update();

		expect(json.rollout).toBe('failed');
		expect(json.error).toContain('the copy of owlat_convex-data has changed');
		expect(json.error).toContain('Nothing was restored');
		expect(commandLines().some(isRestore)).toBe(false);
	});
});

describe('owlat rollback (GET /snapshot, POST /rollback)', () => {
	it('describes the kept snapshot, and restores it only when named', async () => {
		await update();
		const info = (await (await fetch(`${base}/snapshot`, { headers: AUTH })).json()) as {
			snapshot: { id: string; state: string };
			description: string;
		};
		expect(info.snapshot.state).toBe('kept');
		expect(info.description).toContain('from 0.4.16 to 0.4.17');
		expect(info.description).toContain('Everything written to the instance since is lost');

		const unnamed = await post('/rollback', {});
		expect(unnamed.status).toBe(400);
		expect(commandLines().some(isRestore)).toBe(false);

		const res = await post('/rollback', { snapshot: info.snapshot.id });
		const json = (await res.json()) as Answer;
		expect(res.status).toBe(200);
		expect(json.rollout).toBe('rolled-back');
		expect(commandLines().filter(isRestore)).toHaveLength(2);
		expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(OLD_COMPOSE);
		expect(json.steps.at(-1)?.step).toBe('self-update');

		const again = await post('/rollback', { snapshot: info.snapshot.id });
		expect(again.status).toBe(409);
	});

	it('answers that there is nothing to restore before any update', async () => {
		const info = (await (await fetch(`${base}/snapshot`, { headers: AUTH })).json()) as {
			snapshot: unknown;
		};
		expect(info.snapshot).toBeNull();
		expect((await post('/rollback', { snapshot: 'snap-abc-0123abcd' })).status).toBe(404);
	});

	it('requires the instance secret', async () => {
		expect((await fetch(`${base}/snapshot`)).status).toBe(401);
		expect((await fetch(`${base}/rollback`, { method: 'POST' })).status).toBe(401);
	});
});

describe('after an updater that stopped mid-rollout', () => {
	function journalOf(state: string, extra: Record<string, unknown> = {}) {
		mkdirSync(join(SNAPSHOT_DIR, 'data'), { recursive: true });
		writeFileSync(
			JOURNAL,
			JSON.stringify({
				id: 'snap-abc-0123abcd',
				takenAt: 2_000,
				state,
				fromVersion: '0.4.16',
				targetVersion: '0.4.17',
				paused: [],
				mounts: [],
				files: [],
				...extra,
			})
		);
	}

	it('starts what a cut-off copy paused, and drops the partial copy', async () => {
		journalOf('capturing', { paused: [CONTAINERS.convex, CONTAINERS.redis] });
		await reconcileInterruptedUpdate();
		expect(commandLines()).toEqual([`docker start ${CONTAINERS.convex} ${CONTAINERS.redis}`]);
		expect(existsSync(SNAPSHOT_DIR)).toBe(false);
	});

	it('points at `owlat rollback` when the release was promoted but never confirmed', async () => {
		journalOf('armed');
		writeFileSync(
			RECORD,
			JSON.stringify({
				targetVersion: '0.4.17',
				startedAt: 1_000,
				phase: 'verifying',
				committed: true,
			})
		);
		const verdict = await reconcileInterruptedUpdate();
		expect(verdict).toMatchObject({ outcome: 'interrupted' });
		expect(verdict?.summary).toContain('`owlat rollback` on the host restores it');
		expect(commandLines().some(isRestore)).toBe(false);
	});

	it('drops the snapshot of an update that stopped before the deploy', async () => {
		journalOf('armed');
		writeFileSync(
			RECORD,
			JSON.stringify({ targetVersion: '0.4.17', startedAt: 1_000, phase: 'applying' })
		);
		await reconcileInterruptedUpdate();
		expect(existsSync(SNAPSHOT_DIR)).toBe(false);
	});

	it('says a rollback was cut off, and how to finish it', async () => {
		journalOf('restoring');
		writeFileSync(
			RECORD,
			JSON.stringify({
				targetVersion: '0.4.17',
				startedAt: 1_000,
				phase: 'rolling-back',
				committed: true,
			})
		);
		const verdict = await reconcileInterruptedUpdate();
		expect(verdict?.summary).toContain('while rolling a failed release back');
		expect(verdict?.summary).toContain('owlat rollback');
		expect(journal()).toMatchObject({ state: 'restoring' });
	});
});
