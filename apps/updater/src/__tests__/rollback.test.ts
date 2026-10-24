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
const { beginShutdown, setShutdownHandle } = await import('../lifecycle.js');
const { fastReadiness } = await import('./readinessStubs.js');

const SNAPSHOT_DIR = join(OWLAT_DIR, '.owlat-update-snapshot');
const JOURNAL = join(SNAPSHOT_DIR, 'snapshot.json');
const RECORD = join(OWLAT_DIR, '.owlat-last-rollout.json');
const OVERRIDE = join(OWLAT_DIR, 'docker-compose.override.yml');
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
/** The label every container an update starts carries, and this install's value of it. */
const INSTALL_LABEL = `ink.wolves.owlat.update-install=${HOST_INSTALL_DIR}`;
/** The deploy containers that exist (run by an update, not removed yet), and their install label. */
let deployContainers: Map<string, string>;

type Mount = { Type: string; Name?: string; Source: string; Destination: string; RW: boolean };
const volume = (name: string, destination: string): Mount => ({
	Type: 'volume',
	Name: name,
	Source: `/var/lib/docker/volumes/${name}/_data`,
	Destination: destination,
	RW: true,
});
const bind = (source: string, destination: string): Mount => ({
	Type: 'bind',
	Source: source,
	Destination: destination,
	RW: true,
});

interface FakeContainer {
	id: string;
	name: string;
	service: string;
	mounts: Mount[];
	/** Its install label, for a container an update started. */
	install?: string;
}
/** The stack's containers, as `compose ps` lists them; all running. */
let stack: FakeContainer[];
/** Running containers outside the stack: a copy helper a lost client left, another tool's. */
let strays: FakeContainer[];

const defaultStack = (): FakeContainer[] => [
	{
		id: CONTAINERS.convex,
		name: 'owlat-convex-1',
		service: 'convex',
		mounts: [volume('owlat_convex-data', '/convex/data')],
	},
	{
		id: CONTAINERS.redis,
		name: 'owlat-redis-1',
		service: 'redis',
		mounts: [volume('owlat_redis-data', '/data')],
	},
	{ id: CONTAINERS.web, name: 'owlat-web-1', service: 'web', mounts: [] },
];

beforeEach(() => {
	readiness.webStatus(200);
	freeBytesMock.mockReset().mockReturnValue(50 * 1024 ** 3);
	overrides = [];
	deployContainers = new Map();
	stack = defaultStack();
	strays = [];
	commandMock.mockReset().mockImplementation((file: string, args: string[]) => {
		const cmd = [file, ...args].join(' ');
		// The run creates its container before it can fail.
		if (cmd.includes('convex-deploy')) {
			const label = args[args.indexOf('--label') + 1] ?? '';
			deployContainers.set(args[args.indexOf('--name') + 1] ?? '', label);
		}
		for (const override of overrides) {
			const answer = override(cmd);
			if (answer !== undefined) return answer;
		}
		return docker(cmd, args);
	});
	rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
	rmSync(RECORD, { force: true });
	rmSync(OVERRIDE, { recursive: true, force: true });
	writeFileSync(join(OWLAT_DIR, 'docker-compose.yml'), OLD_COMPOSE);
	writeFileSync(join(OWLAT_DIR, '.env'), OLD_ENV, { mode: 0o600 });
});

function fail(stderr: string): never {
	throw Object.assign(new Error('boom'), { stdout: '', stderr });
}

/** `docker container inspect` of `ids`: one JSON object per container, as its template prints. */
function inspectJson(ids: string[]): string {
	return ids
		.map((id) => [...stack, ...strays].find((c) => c.id === id))
		.filter((c): c is FakeContainer => c !== undefined)
		.map((c) => JSON.stringify({ Id: c.id, Running: true, Service: c.service, Mounts: c.mounts }))
		.join('\n');
}

/** What Docker's `volume` filter matches: a volume name, a bind source, or a destination. */
const usesPath = (c: FakeContainer, value: string) =>
	c.mounts.some(
		(m) => m.Name === value || (!m.Name && m.Source === value) || m.Destination === value
	);

/** A healthy Docker host with a convex and a redis that keep their data in volumes. */
function docker(cmd: string, args: string[]): string {
	if (cmd.includes('config --services'))
		return 'web\nconvex\nredis\nupdater\ndocker-socket-proxy\n';
	if (cmd.endsWith(' ps --all --quiet')) return stack.map((c) => `${c.id}\n`).join('');
	if (cmd.startsWith('docker container inspect --format ')) return inspectJson(args.slice(4));
	// A deploy whose run failed: its container exited with an error.
	if (cmd.startsWith('docker inspect --type container')) return 'exited|1\n';
	if (cmd.startsWith('docker ps --all --filter label=')) {
		const label = args[args.indexOf('--filter') + 1]?.replace(/^label=/, '');
		return [
			...[...deployContainers].filter(([, l]) => l === label).map(([name]) => name),
			...strays.filter((c) => c.install && INSTALL_LABEL === label).map((c) => c.name),
		]
			.map((name) => `${name}\n`)
			.join('');
	}
	if (cmd.startsWith('docker rm --force ')) {
		const name = args.at(-1) ?? '';
		deployContainers.delete(name);
		strays = strays.filter((c) => c.name !== name);
		return '';
	}
	if (cmd.startsWith('docker stop ')) {
		// A stray copy helper runs with --rm: once stopped it is gone.
		strays = strays.filter((c) => !args.includes(c.id));
		return '';
	}
	if (cmd.startsWith('docker ps --quiet --no-trunc --filter volume=')) {
		const value = (args.at(-1) ?? '').replace(/^volume=/, '');
		return [...stack, ...strays]
			.filter((c) => usesPath(c, value))
			.map((c) => `${c.id}\n`)
			.join('');
	}
	if (cmd.startsWith('docker inspect')) {
		const self = [{ Type: 'bind', Source: HOST_INSTALL_DIR, Destination: OWLAT_DIR, RW: true }];
		return [
			'ghcr.io/wolvesdotink/updater:0.4.16',
			JSON.stringify(self),
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

	it('rolls back a deploy that exited with an error, which does not prove Convex refused it', async () => {
		// The Convex CLI also exits 1 when it lost the answer to a push the
		// backend had committed.
		overrides.push((cmd) => (isDeploy(cmd) ? fail('Error: schema validation failed') : undefined));
		const { status, json } = await update();

		expect(status).toBe(500);
		expect(json.rollout).toBe('rolled-back');
		expect(json.error).toMatch(
			/^convex-deploy failed without showing whether it changed Convex \(its container exited with code 1\)/
		);
		expect(json.error).not.toContain('untouched');
		expect(commandLines().some(isRestore)).toBe(true);
		expect(journal()).toMatchObject({ state: 'restored', deployStarted: true });
	});

	const isDeployInspect = (cmd: string) => cmd.startsWith('docker inspect --type container');
	const isDeployRemoval = (cmd: string) => cmd.startsWith('docker rm --force owlat-update-deploy-');

	it.each([
		['its container never got created', () => fail('Error: No such container: x')],
		['its container was created but never started', () => 'created|0\n'],
	])('drops the snapshot of a failed run when %s', async (_label, inspect) => {
		overrides.push((cmd) => {
			if (isDeploy(cmd)) fail('error waiting for container: unexpected EOF');
			return isDeployInspect(cmd) ? inspect() : undefined;
		});
		const { json } = await update();

		expect(json.error).toContain('running stack untouched');
		expect(existsSync(SNAPSHOT_DIR)).toBe(false);
	});

	it.each([
		['still running', 'running|0\n'],
		['exited 1 on its own', 'exited|1\n'],
		['exited 0 after the client gave up', 'exited|0\n'],
		['killed', 'exited|137\n'],
	])(
		'keeps the snapshot and rolls back when the client lost a deploy that is %s',
		async (_label, state) => {
			overrides.push((cmd) => {
				if (isDeploy(cmd)) fail('error waiting for container: unexpected EOF');
				return isDeployInspect(cmd) ? state : undefined;
			});
			const { status, json } = await update();

			expect(status).toBe(500);
			expect(json.rollout).toBe('rolled-back');
			expect(json.error).toMatch(/^convex-deploy failed without showing whether it changed Convex/);
			expect(json.error).not.toContain('untouched');
			// The deploy, named after the snapshot, is stopped before a byte is restored.
			const { id } = journal() as { id: string };
			const removal = indexOf((c) => c === `docker rm --force owlat-update-deploy-${id}`);
			expect(removal).toBeGreaterThan(-1);
			expect(removal).toBeLessThan(indexOf(isRestore));
			expect(journal()).toMatchObject({ state: 'restored', deployStarted: true });
		}
	);

	it('restores nothing under a deploy it cannot stop, and keeps the snapshot', async () => {
		overrides.push((cmd) => {
			if (isDeploy(cmd)) fail('error waiting for container: unexpected EOF');
			if (isDeployInspect(cmd) || isDeployRemoval(cmd)) {
				fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
			}
			return undefined;
		});
		const { json } = await update();

		expect(json.rollout).toBe('failed');
		expect(json.error).toContain(
			'could not stop a container an update or rollback of this install'
		);
		expect(json.error).toContain('Nothing was restored');
		expect(commandLines().some(isRestore)).toBe(false);
		expect(journal()).toMatchObject({ state: 'armed', deployStarted: true });
	});

	it('stops a deploy cut off by its bound before it restores', async () => {
		overrides.push((cmd) => (isDeploy(cmd) ? fail('docker timed out after 900s') : undefined));
		await update();

		// Cut off by the updater itself: its state is not read as proof of anything.
		expect(commandLines().some(isDeployInspect)).toBe(false);
		expect(indexOf(isDeployRemoval)).toBeGreaterThan(-1);
		expect(indexOf(isDeployRemoval)).toBeLessThan(indexOf(isRestore));
	});

	it('refuses an update before deploying when a store has no container', async () => {
		// redis was removed; its volume (and the data in it) may well remain.
		stack = stack.filter((c) => c.service !== 'redis');
		const { status, json } = await update();

		expect(status).toBe(500);
		expect(json.error).toContain('redis has no container');
		expect(json.error).toContain('Nothing was changed');
		expect(commandLines().some(isDeploy)).toBe(false);
		expect(commandLines().some((c) => c.startsWith('docker stop'))).toBe(false);
		expect(existsSync(SNAPSHOT_DIR)).toBe(false);
		expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
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

		// Turning snapshots off does not turn the refusal off, and nothing else
		// that recreates containers runs over the half-restored data either.
		writeFileSync(join(OWLAT_DIR, '.env'), `${OLD_ENV}OWLAT_UPDATE_SNAPSHOT=off\n`);
		const before = commandMock.mock.calls.length;
		const optedOut = await update();
		expect(optedOut.status).toBe(409);
		expect(optedOut.json.error).toContain('did not finish');
		const profiles = await post('/apply-profiles', { flags: {} });
		expect(profiles.status).toBe(409);
		// Refused before any Docker command ran.
		expect(commandMock.mock.calls.length).toBe(before);
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

	it('ignores a journal that names a path the capture would never write', async () => {
		mkdirSync(join(SNAPSHOT_DIR, 'data'), { recursive: true });
		writeFileSync(
			JOURNAL,
			JSON.stringify({
				id: 'snap-abc-0123abcd',
				takenAt: 1,
				state: 'kept',
				fromVersion: null,
				targetVersion: null,
				paused: [],
				mounts: [{ service: 'convex', kind: 'volume', source: 'v', payload: '../../x.tar' }],
				files: ['../etc/passwd'],
			})
		);
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
				files: ['docker-compose.yml', '.env'],
				absent: ['docker-compose.override.yml'],
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

describe('a shutdown after the deploy has started', () => {
	it('keeps the snapshot, and does not claim the stack is unchanged', async () => {
		try {
			overrides.push((cmd) => {
				if (isDeploy(cmd)) beginShutdown();
				return isDeploy(cmd) ? '' : undefined;
			});
			const { status, json } = await update();

			expect(status).toBe(503);
			expect(json.rollout).toBe('interrupted');
			expect(json.error).toContain('convex-deploy had started');
			expect(json.error).toContain('`owlat rollback` on the host restores it');
			expect(json.error).not.toContain('was not changed');
			expect(journal()).toMatchObject({ state: 'kept', deployStarted: true });
			expect(existsSync(join(OWLAT_DIR, 'docker-compose.next.yml'))).toBe(false);
			expect(readFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'utf-8')).toBe(OLD_COMPOSE);
			expect(commandLines().some(isRestore)).toBe(false);
		} finally {
			setShutdownHandle(undefined);
		}
	});

	/** An update a shutdown stopped once its deploy had started; its snapshot's id, if it took one. */
	async function interruptedAfterDeploy(): Promise<string> {
		const shutdown = (cmd: string) => {
			if (isDeploy(cmd)) beginShutdown();
			return isDeploy(cmd) ? '' : undefined;
		};
		overrides.push(shutdown);
		try {
			await update();
		} finally {
			setShutdownHandle(undefined);
			overrides.splice(overrides.indexOf(shutdown), 1);
		}
		return existsSync(JOURNAL) ? (journal() as { id: string }).id : '';
	}

	it('stops the deploy it may have left running before `owlat rollback` restores', async () => {
		const id = await interruptedAfterDeploy();
		const res = await post('/rollback', { snapshot: id });
		expect(res.status).toBe(200);

		const removal = indexOf((c) => c === `docker rm --force owlat-update-deploy-${id}`);
		expect(removal).toBeGreaterThan(-1);
		expect(removal).toBeLessThan(indexOf(isRestore));
	});

	it('stops that deploy before the next update deploys again, or refuses', async () => {
		const id = await interruptedAfterDeploy();
		const previousDeploy = (c: string) => c === `docker rm --force owlat-update-deploy-${id}`;
		overrides.push((cmd) => (previousDeploy(cmd) ? fail('error during connect: EOF') : undefined));
		const before = commandLines().length;
		const refused = await update();

		expect(refused.status).toBe(500);
		expect(refused.json.error).toContain('Cannot stop a container an earlier update started');
		expect(commandLines().slice(before).some(isDeploy)).toBe(false);
		// The earlier snapshot is still the one `owlat rollback` restores.
		expect(journal()).toMatchObject({ id, state: 'kept' });

		overrides.pop();
		const next = await update();
		expect(next.status).toBe(200);
		expect(lastIndexOf(previousDeploy)).toBeLessThan(lastIndexOf(isDeploy));
	});

	it('stops that deploy before an update that takes no snapshot deploys again, or refuses', async () => {
		const id = await interruptedAfterDeploy();
		writeFileSync(join(OWLAT_DIR, '.env'), `${OLD_ENV}OWLAT_UPDATE_SNAPSHOT=off\n`);
		const previousDeploy = (c: string) => c === `docker rm --force owlat-update-deploy-${id}`;
		overrides.push((cmd) => (previousDeploy(cmd) ? fail('error during connect: EOF') : undefined));
		const before = commandLines().length;
		const refused = await update();

		expect(refused.status).toBe(500);
		expect(refused.json.error).toContain('Cannot stop a container an earlier update started');
		expect(commandLines().slice(before).some(isDeploy)).toBe(false);
		expect(journal()).toMatchObject({ id, state: 'kept' });

		overrides.pop();
		const next = await update();
		expect(next.status).toBe(200);
		expect(lastIndexOf(previousDeploy)).toBeGreaterThan(-1);
		expect(lastIndexOf(previousDeploy)).toBeLessThan(lastIndexOf(isDeploy));
	});

	it('stops a deploy an update without a snapshot left running before the next one deploys', async () => {
		writeFileSync(join(OWLAT_DIR, '.env'), `${OLD_ENV}OWLAT_UPDATE_SNAPSHOT=off\n`);
		await interruptedAfterDeploy();
		const [left] = [...deployContainers.keys()];
		expect(left).toMatch(/^owlat-update-deploy-[0-9a-f]{12}$/);

		const next = await update();
		expect(next.status).toBe(200);
		const removal = lastIndexOf((c) => c === `docker rm --force ${left}`);
		expect(removal).toBeGreaterThan(-1);
		expect(removal).toBeLessThan(lastIndexOf(isDeploy));
	});

	it('records that the deploy started before running it', async () => {
		let atDeploy: Record<string, unknown> = {};
		let recordAtDeploy: Record<string, unknown> = {};
		overrides.push((cmd) => {
			if (!isDeploy(cmd)) return undefined;
			atDeploy = journal();
			recordAtDeploy = JSON.parse(readFileSync(RECORD, 'utf-8'));
			return '';
		});
		await update();
		expect(atDeploy).toMatchObject({ state: 'armed', deployStarted: true });
		expect(recordAtDeploy).toMatchObject({ phase: 'applying', deployStarted: true });
	});
});

describe('after an updater killed between the deploy and the promote', () => {
	it('keeps the snapshot and says the backend may run the new release', async () => {
		mkdirSync(join(SNAPSHOT_DIR, 'data'), { recursive: true });
		writeFileSync(
			JOURNAL,
			JSON.stringify({
				id: 'snap-abc-0123abcd',
				takenAt: 2_000,
				state: 'armed',
				fromVersion: '0.4.16',
				targetVersion: '0.4.17',
				paused: [],
				mounts: [],
				files: ['docker-compose.yml', '.env'],
				absent: ['docker-compose.override.yml'],
				deployStarted: true,
			})
		);
		// The rollout record never got its own `deployStarted` written.
		writeFileSync(
			RECORD,
			JSON.stringify({ targetVersion: '0.4.17', startedAt: 1_000, phase: 'applying' })
		);
		const verdict = await reconcileInterruptedUpdate();

		expect(verdict?.summary).toContain('after convex-deploy started');
		expect(verdict?.summary).toContain('`owlat rollback` on the host restores it');
		expect(verdict?.summary).not.toContain('was not changed');
		expect(journal()).toMatchObject({ state: 'kept' });
	});
});

describe('a rollback that restored the data but did not start the release', () => {
	it('resumes at the start, without copying the data back again', async () => {
		await update();
		const snapshot = journal()['id'];
		let failUp = true;
		overrides.push((cmd) =>
			failUp && cmd.includes(' up -d --remove-orphans')
				? fail('error during connect: EOF')
				: undefined
		);

		const first = await post('/rollback', { snapshot });
		const firstJson = (await first.json()) as Answer;
		expect(first.status).toBe(500);
		expect(firstJson.description).toContain(
			'starts that release again without copying the data back'
		);
		expect(journal()).toMatchObject({ state: 'starting' });
		expect(commandLines().filter(isRestore)).toHaveLength(2);

		// Nothing but the rollback may run until it is finished.
		expect((await update()).status).toBe(409);
		const info = (await (await fetch(`${base}/snapshot`, { headers: AUTH })).json()) as {
			description: string;
		};
		expect(info.description).toContain('the data is not copied back a second time');

		failUp = false;
		const second = await post('/rollback', { snapshot });
		const secondJson = (await second.json()) as Answer;
		expect(second.status).toBe(200);
		expect(secondJson.rollout).toBe('rolled-back');
		expect(commandLines().filter(isRestore)).toHaveLength(2);
		expect(journal()).toMatchObject({ state: 'restored' });
		expect((await post('/rollback', { snapshot })).status).toBe(409);
	});

	it('stays resumable when the restored release fails its readiness check', async () => {
		await update();
		const snapshot = journal()['id'];
		readiness.webStatus(503);
		expect((await post('/rollback', { snapshot })).status).toBe(500);
		expect(journal()).toMatchObject({ state: 'starting' });

		readiness.webStatus(200);
		expect((await post('/rollback', { snapshot })).status).toBe(200);
		expect(journal()).toMatchObject({ state: 'restored' });
	});
});

describe('configuration files the snapshot did not have', () => {
	it('removes an override created after the snapshot', async () => {
		await update();
		expect(journal()).toMatchObject({
			files: ['docker-compose.yml', '.env'],
			absent: ['docker-compose.override.yml'],
		});
		const snapshot = journal()['id'];
		writeFileSync(OVERRIDE, 'services:\n  web:\n    environment:\n      ADDED_LATER: "1"\n');

		const res = await post('/rollback', { snapshot });
		const json = (await res.json()) as Answer;
		expect(res.status).toBe(200);
		expect(existsSync(OVERRIDE)).toBe(false);
		expect(json.steps.find((s) => s.step === 'rollback-restore')?.stdout).toContain(
			'removed docker-compose.override.yml'
		);
	});

	it('puts back an override the snapshot had', async () => {
		writeFileSync(OVERRIDE, 'services: {} # before\n');
		await update();
		writeFileSync(OVERRIDE, 'services: {} # after\n');
		await post('/rollback', { snapshot: journal()['id'] });
		expect(readFileSync(OVERRIDE, 'utf-8')).toBe('services: {} # before\n');
	});

	it('refuses the snapshot when a file cannot be read, rather than calling it absent', async () => {
		mkdirSync(OVERRIDE);
		const { status, json } = await update();

		expect(status).toBe(500);
		expect(json.error).toContain('cannot read docker-compose.override.yml');
		expect(json.error).toContain('Nothing was changed');
		expect(indexOf((c) => c.startsWith('docker stop'))).toBe(-1);
		expect(indexOf(isDeploy)).toBe(-1);
	});

	it('refuses the snapshot when a required file is missing', async () => {
		rmSync(join(OWLAT_DIR, 'docker-compose.yml'));
		const { status, json } = await update();

		expect(status).toBe(500);
		expect(json.error).toContain('docker-compose.yml does not exist');
		expect(indexOf(isDeploy)).toBe(-1);
	});
});

describe('what else may write while a rollback restores', () => {
	/** An update a shutdown stopped once its deploy had started. */
	async function interruptedAfterDeploy(): Promise<void> {
		const shutdown = (cmd: string) => {
			if (isDeploy(cmd)) beginShutdown();
			return isDeploy(cmd) ? '' : undefined;
		};
		overrides.push(shutdown);
		try {
			expect((await update()).status).toBe(503);
		} finally {
			setShutdownHandle(undefined);
			overrides.splice(overrides.indexOf(shutdown), 1);
		}
	}

	it('stops the deploy of a later update that took no snapshot before restoring the kept one', async () => {
		await update();
		const snapshot = journal()['id'];
		writeFileSync(join(OWLAT_DIR, '.env'), `${OLD_ENV}OWLAT_UPDATE_SNAPSHOT=off\n`);
		await interruptedAfterDeploy();
		const [left] = [...deployContainers.keys()];
		expect(left).toMatch(/^owlat-update-deploy-[0-9a-f]{12}$/);

		const runningAtRestore: string[] = [];
		overrides.push((cmd) => {
			if (isRestore(cmd)) runningAtRestore.push(...deployContainers.keys());
			return undefined;
		});
		const res = await post('/rollback', { snapshot });
		expect(res.status).toBe(200);
		expect(runningAtRestore).toEqual([]);
		expect(indexOf((c) => c === `docker rm --force ${left}`)).toBeLessThan(indexOf(isRestore));
	});

	it('restores nothing while a deploy of this install cannot be stopped', async () => {
		await update();
		const snapshot = journal()['id'];
		writeFileSync(join(OWLAT_DIR, '.env'), `${OLD_ENV}OWLAT_UPDATE_SNAPSHOT=off\n`);
		await interruptedAfterDeploy();
		overrides.push((cmd) =>
			cmd.startsWith('docker rm --force owlat-update-deploy-')
				? fail('error during connect: EOF')
				: undefined
		);

		const res = await post('/rollback', { snapshot });
		const json = (await res.json()) as Answer;
		expect(res.status).toBe(500);
		expect(json.error).toContain(
			'could not stop a container an update or rollback of this install'
		);
		expect(commandLines().some(isRestore)).toBe(false);
		expect(journal()).toMatchObject({ state: 'kept' });
	});

	it('leaves the deploy containers of another installation on the same daemon alone', async () => {
		const foreign = 'owlat-update-deploy-snap-foreign-0123abcd';
		deployContainers.set(foreign, 'ink.wolves.owlat.update-install=/srv/other-owlat');
		expect((await update()).status).toBe(200);
		expect(await (await post('/rollback', { snapshot: journal()['id'] })).status).toBe(200);

		expect(deployContainers.has(foreign)).toBe(true);
		expect(commandLines().some((c) => c.includes(foreign))).toBe(false);
		// Everything the update and the rollback started carries this install's label.
		const started = commandLines().filter((c) => isDeploy(c) || c.startsWith('docker run --rm'));
		expect(started.length).toBeGreaterThan(0);
		for (const cmd of started) expect(cmd).toContain(`--label ${INSTALL_LABEL}`);
	});

	it('waits for a leftover container that another removal is already stopping', async () => {
		await update();
		const helper = 'owlat-copy-helper';
		strays.push({
			id: 'deadbeef0004',
			name: helper,
			service: '',
			install: INSTALL_LABEL,
			mounts: [],
		});
		overrides.push((cmd) => {
			if (cmd === `docker rm --force ${helper}`) {
				fail(`Error response from daemon: removal of container ${helper} is already in progress`);
			}
			if (cmd === `docker wait ${helper}`) strays = strays.filter((c) => c.name !== helper);
			return undefined;
		});

		expect((await post('/rollback', { snapshot: journal()['id'] })).status).toBe(200);
		const waited = indexOf((c) => c === `docker wait ${helper}`);
		expect(waited).toBeGreaterThan(-1);
		expect(waited).toBeLessThan(indexOf(isRestore));
	});

	describe('with convex data in a bind mount', () => {
		const DATA = '/srv/owlat-data/convex';
		beforeEach(() => {
			stack[0] = { ...stack[0]!, mounts: [bind(DATA, '/convex/data')] };
		});

		/** The first restore loses its client; the helper it started goes on extracting. */
		function lostRestoreHelper(helper: FakeContainer): void {
			let first = true;
			overrides.push((cmd) => {
				if (!isRestore(cmd) || !first) return undefined;
				first = false;
				strays.push(helper);
				return fail('error waiting for container: unexpected EOF');
			});
		}

		async function retriedRollback(): Promise<string[]> {
			await update();
			const snapshot = journal()['id'];
			expect((await post('/rollback', { snapshot })).status).toBe(500);
			expect(journal()).toMatchObject({ state: 'restoring' });

			const runningAtRestore: string[] = [];
			overrides.push((cmd) => {
				if (isRestore(cmd)) runningAtRestore.push(...strays.map((c) => c.id));
				return undefined;
			});
			expect((await post('/rollback', { snapshot })).status).toBe(200);
			expect(journal()).toMatchObject({ state: 'restored' });
			return runningAtRestore;
		}

		it('snapshots and restores the bind', async () => {
			await update();
			expect(journal()['mounts']).toEqual([
				expect.objectContaining({ kind: 'bind', source: DATA }),
				expect.objectContaining({ kind: 'volume', source: 'owlat_redis-data' }),
			]);
		});

		it('stops a copy helper an interrupted restore left running before restoring again', async () => {
			lostRestoreHelper({
				id: 'deadbeef0001',
				name: 'owlat-restore-helper',
				service: '',
				install: INSTALL_LABEL,
				mounts: [bind(DATA, '/target')],
			});
			expect(await retriedRollback()).toEqual([]);
			expect(lastIndexOf((c) => c === 'docker rm --force owlat-restore-helper')).toBeLessThan(
				lastIndexOf(isRestore)
			);
		});

		it('stops any other container writing to the bind, found by its mounts', async () => {
			// Started without the install label (by hand, or by another tool).
			lostRestoreHelper({
				id: 'deadbeef0002',
				name: 'by-hand',
				service: '',
				mounts: [bind(DATA, '/target')],
			});
			// Mounts something else AT that path: Docker's filter lists it, but it writes elsewhere.
			strays.push({
				id: 'deadbeef0003',
				name: 'unrelated',
				service: '',
				mounts: [volume('other-data', DATA)],
			});
			const running = await retriedRollback();

			expect([...new Set(running)]).toEqual(['deadbeef0003']);
			const stop = commandLines().findLast((c) => c.startsWith('docker stop'));
			expect(stop).toContain('deadbeef0002');
			expect(stop).not.toContain('deadbeef0003');
		});
	});
});

describe('a self-inspect that fails partway', () => {
	const isSelfInspect = (cmd: string) =>
		cmd.startsWith('docker inspect ') && cmd.includes('{{json .Mounts}}');
	const LEFT = 'owlat-update-deploy-later';

	/** Docker loses its connection on the `n`th time the updater inspects itself. */
	function failSelfInspect(n: number): void {
		let reads = 0;
		overrides.push((cmd) => {
			if (isSelfInspect(cmd) && ++reads === n) fail('error during connect: unexpected EOF');
			return undefined;
		});
	}

	/** Every install label the run started a container with or looked for one by. */
	function labelsUsed(): string[] {
		return commandLines().flatMap((cmd) =>
			[
				...cmd.matchAll(/(?:--label |--filter label=)(ink\.wolves\.owlat\.update-install=\S+)/g),
			].map((m) => m[1] ?? '')
		);
	}

	// Whichever inspect fails, the run never restores under a deploy of this
	// install it did not find, nor looks for one under another install's label.
	it.each([1, 2, 3, 4, 5, 6])(
		'restores nothing under a running deploy when inspect %i fails during a rollback',
		async (n) => {
			await update();
			const snapshot = journal()['id'];
			deployContainers.set(LEFT, INSTALL_LABEL);
			commandMock.mockClear();
			failSelfInspect(n);
			const runningAtRestore: string[] = [];
			overrides.push((cmd) => {
				if (isRestore(cmd)) runningAtRestore.push(...deployContainers.keys());
				return undefined;
			});

			const res = await post('/rollback', { snapshot });
			expect(runningAtRestore).toEqual([]);
			for (const label of labelsUsed()) expect(label).toBe(INSTALL_LABEL);
			if (res.status !== 200) {
				expect(commandLines().some(isRestore)).toBe(false);
				expect(journal()).toMatchObject({ state: 'kept' });
			}
		}
	);

	it('refuses a rollback when it cannot tell which containers are this install', async () => {
		await update();
		const snapshot = journal()['id'];
		deployContainers.set(LEFT, INSTALL_LABEL);
		overrides.push((cmd) => (isSelfInspect(cmd) ? fail('error during connect: EOF') : undefined));

		const res = await post('/rollback', { snapshot });
		const json = (await res.json()) as Answer;
		expect(res.status).toBe(500);
		expect(json.error).toContain('cannot tell which containers belong to this install');
		expect(commandLines().some(isRestore)).toBe(false);
		expect(deployContainers.has(LEFT)).toBe(true);
		expect(journal()).toMatchObject({ state: 'kept' });
	});

	it.each([
		['with a snapshot', ''],
		['without a snapshot', 'OWLAT_UPDATE_SNAPSHOT=off\n'],
	])('never deploys beside an earlier deploy, %s, whichever inspect fails', async (_, optOut) => {
		let refusedUnresolved = false;
		for (const n of [1, 2, 3, 4, 5, 6]) {
			deployContainers = new Map([[LEFT, INSTALL_LABEL]]);
			rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
			rmSync(RECORD, { force: true });
			writeFileSync(join(OWLAT_DIR, '.env'), `${OLD_ENV}${optOut}`, { mode: 0o600 });
			commandMock.mockClear();
			overrides = [];
			failSelfInspect(n);
			const besideDeploy: string[] = [];
			overrides.push((cmd) => {
				if (isDeploy(cmd)) besideDeploy.push(...deployContainers.keys());
				return undefined;
			});

			const { status, json } = await update();
			expect(besideDeploy).not.toContain(LEFT);
			for (const label of labelsUsed()) expect(label).toBe(INSTALL_LABEL);
			if (json.error?.includes('Cannot tell which containers belong to this install')) {
				expect(status).toBe(500);
				expect(commandLines().some(isDeploy)).toBe(false);
				refusedUnresolved = true;
			}
		}
		expect(refusedUnresolved).toBe(true);
	});

	it('labels an updater outside a container with its own path, and finds its deploys by it', async () => {
		overrides.push((cmd) =>
			isSelfInspect(cmd) ? fail('Error: No such object: updater-host') : undefined
		);
		writeFileSync(join(OWLAT_DIR, '.env'), `${OLD_ENV}OWLAT_UPDATE_SNAPSHOT=off\n`);
		const own = `ink.wolves.owlat.update-install=${OWLAT_DIR}`;
		deployContainers.set(LEFT, own);

		await update();
		expect(deployContainers.has(LEFT)).toBe(false);
		const labels = labelsUsed();
		expect(labels.length).toBeGreaterThan(0);
		for (const label of labels) expect(label).toBe(own);
	});
});

describe('mount paths the snapshot cannot pass to Docker', () => {
	it('refuses a bind whose path holds a space, before pausing or deploying anything', async () => {
		stack[0] = { ...stack[0]!, mounts: [bind('/srv/Owlat Data/convex', '/convex/data')] };
		const { status, json } = await update();

		expect(status).toBe(500);
		expect(json.error).toContain('"/srv/Owlat Data/convex", which the snapshot cannot copy');
		expect(json.error).toContain('Nothing was changed');
		expect(commandLines().some(isDeploy)).toBe(false);
		expect(commandLines().some((c) => c.startsWith('docker stop'))).toBe(false);
		expect(existsSync(SNAPSHOT_DIR)).toBe(false);
	});

	it('refuses the snapshot when the install directory holds a space, rather than cutting it there', async () => {
		overrides.push((cmd) =>
			cmd.startsWith('docker inspect ') && cmd.includes('{{json .Mounts}}')
				? [
						'ghcr.io/wolvesdotink/updater:0.4.16',
						JSON.stringify([bind('/srv/Owlat Data', OWLAT_DIR)]),
						'owlat_default ',
					].join('\n')
				: undefined
		);
		const { status, json } = await update();

		expect(status).toBe(500);
		expect(json.error).toContain('Cannot read the install directory');
		expect(commandLines().some(isDeploy)).toBe(false);
		// The install label names the whole directory; nothing names a part of it.
		const args = commandMock.mock.calls.flatMap((c) => c[1] as string[]);
		for (const arg of args.filter((a) => a.includes('/srv/Owlat'))) {
			expect(arg).toContain('/srv/Owlat Data');
		}
	});
});
