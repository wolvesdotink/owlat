/**
 * `owlat feature --sync` rebuilds .owlat-flags.json from the flags the running
 * backend holds. A restore from an archive made before backups carried the file
 * leaves the install without one, and before this step existed the only way to
 * get it back was an Apply & restart the Features page only offers when the
 * services drifted, which they do not right after a restore. Until then the CLI
 * assumed the default flags, so the next `owlat feature` or `owlat pack` could
 * turn off services the restored install uses.
 *
 * These cases run the REAL scripts/owlat and scripts/read-feature-flags.mjs. A
 * stub `docker` runs the reader with this machine's node where the wrapper
 * execs it in the web container, and a local HTTP server stands in for the
 * Convex query API.
 */

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { getActiveProfiles, resolveFlags, type FeatureFlagState } from '@owlat/shared/featureFlags';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIRROR = '.owlat-flags.json';
const QUERY = 'workspaces/featureFlags:getFeatureFlags';
const LEGACY_QUERY = 'organizations/featureFlags:getFeatureFlags';
const run = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * Non-default flags as the backend resolves them: campaigns and file scanning
 * off, URL scanning on, and a plugin flag switched on.
 */
const BACKEND_FLAGS: FeatureFlagState = {
	...resolveFlags({}),
	campaigns: false,
	'scan.files': false,
	'scan.urls': true,
	'plugin.example-pack': true,
};

// Records each call; runs the reader with the test's node in place of
// `docker compose exec -T web node …`, which gets the script on stdin.
const STUB_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
	"compose exec -T web node --input-type=module -")
		if [ -n "\${STUB_WEB_DOWN:-}" ]; then
			echo 'service "web" is not running' >&2
			exit 1
		fi
		exec "$STUB_NODE" --input-type=module - ;;
esac
exit 0
`;

type Answer = { status: number; body: unknown };

/** A Convex query API that answers each function path with a fixed response. */
async function fakeConvex(answers: Record<string, Answer>): Promise<{
	url: string;
	paths: string[];
}> {
	const paths: string[] = [];
	const server: Server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		req.on('end', () => {
			const { path } = JSON.parse(raw) as { path: string };
			paths.push(`${req.method} ${req.url} ${path}`);
			const answer = answers[path] ?? {
				status: 404,
				body: { status: 'error', errorMessage: `Could not find public function for '${path}'` },
			};
			res.writeHead(answer.status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(answer.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
}

const success = (value: unknown): Answer => ({
	status: 200,
	body: { status: 'success', value, logLines: [] },
});

interface Install {
	readonly dir: string;
	readonly sync: (
		env: Record<string, string>,
		args?: string[]
	) => Promise<{ code: number; out: string; calls: string[] }>;
}

async function makeInstall(files: { mirror?: string; env?: string; override?: string } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'owlat-feature-sync-')));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, 'owlat');
	const stubDir = join(root, 'stub-bin');
	await mkdir(join(dir, 'scripts'), { recursive: true });
	await mkdir(stubDir);
	for (const script of ['owlat', 'read-feature-flags.mjs']) {
		await copyFile(join(REPOSITORY_ROOT, 'scripts', script), join(dir, 'scripts', script));
	}
	await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
	if (files.env !== undefined) await writeFile(join(dir, '.env'), files.env);
	if (files.override !== undefined) {
		await writeFile(join(dir, 'docker-compose.override.yml'), files.override);
	}
	if (files.mirror !== undefined) await writeFile(join(dir, MIRROR), files.mirror);
	await writeFile(join(stubDir, 'docker'), STUB_DOCKER);
	await chmod(join(stubDir, 'docker'), 0o755);
	const log = join(root, 'docker-calls.log');

	const install: Install = {
		dir,
		async sync(env, args = ['feature', '--sync']) {
			await writeFile(log, '');
			const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean);
			try {
				const { stdout, stderr } = await run('bash', [join(dir, 'scripts', 'owlat'), ...args], {
					env: {
						...process.env,
						PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
						OWLAT_DIR: dir,
						OWLAT_SKIP_CLI_LINK: '1',
						OWLAT_SETUP_IMAGE: 'setup-image:test',
						STUB_LOG: log,
						STUB_NODE: process.execPath,
						...env,
					},
				});
				return { code: 0, out: stdout + stderr, calls: await calls() };
			} catch (error) {
				const failure = error as { code?: number; stdout?: string; stderr?: string };
				return {
					code: failure.code ?? 1,
					out: (failure.stdout ?? '') + (failure.stderr ?? ''),
					calls: await calls(),
				};
			}
		},
	};
	return install;
}

const DEFAULT_MIRROR = JSON.stringify(resolveFlags({}), null, 2);

describe('owlat feature --sync', () => {
	it('rebuilds the mirror from non-default backend flags, plugin flags included', async () => {
		const convex = await fakeConvex({ [QUERY]: success(BACKEND_FLAGS) });
		const override = 'x-owlat-profiles: [mta]\nservices: {}\n';
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta,tls\n', override });

		const result = await install.sync({ OWLAT_CONVEX_URL: convex.url });

		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain(`Wrote ${join(install.dir, MIRROR)}`);
		expect(convex.paths).toEqual([`POST /api/query ${QUERY}`]);
		const path = join(install.dir, MIRROR);
		// Byte for byte what the updater's Apply writes for the same flags.
		await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify(BACKEND_FLAGS, null, 2));
		expect((await stat(path)).mode & 0o777).toBe(0o600);

		// The CLI now derives the backend's profiles, not the defaults'.
		const mirror = JSON.parse(await readFile(path, 'utf8')) as FeatureFlagState;
		expect(mirror['plugin.example-pack']).toBe(true);
		expect(getActiveProfiles(resolveFlags(mirror))).toEqual(getActiveProfiles(BACKEND_FLAGS));
		expect(getActiveProfiles(resolveFlags(mirror))).not.toEqual(getActiveProfiles({}));

		// Only the mirror is written: no container is touched and no other file.
		expect(result.calls).toEqual(['compose exec -T web node --input-type=module -']);
		await expect(readFile(join(install.dir, '.env'), 'utf8')).resolves.toBe(
			'COMPOSE_PROFILES=mta,tls\n'
		);
		await expect(readFile(join(install.dir, 'docker-compose.override.yml'), 'utf8')).resolves.toBe(
			override
		);
		expect((await readdir(install.dir)).filter((name) => name.startsWith(MIRROR))).toEqual([
			MIRROR,
		]);
	});

	it('replaces a mirror that holds the defaults', async () => {
		const convex = await fakeConvex({ [QUERY]: success(BACKEND_FLAGS) });
		const install = await makeInstall({ mirror: DEFAULT_MIRROR });

		const result = await install.sync({ OWLAT_CONVEX_URL: convex.url });

		expect(result.code, result.out).toBe(0);
		await expect(readFile(join(install.dir, MIRROR), 'utf8')).resolves.toBe(
			JSON.stringify(BACKEND_FLAGS, null, 2)
		);
	});

	it('reads a backend from before the workspaces rename', async () => {
		const convex = await fakeConvex({ [LEGACY_QUERY]: success(BACKEND_FLAGS) });
		const install = await makeInstall();

		const result = await install.sync({ OWLAT_CONVEX_URL: convex.url });

		expect(result.code, result.out).toBe(0);
		expect(convex.paths).toEqual([`POST /api/query ${QUERY}`, `POST /api/query ${LEGACY_QUERY}`]);
		await expect(readFile(join(install.dir, MIRROR), 'utf8')).resolves.toBe(
			JSON.stringify(BACKEND_FLAGS, null, 2)
		);
	});

	it.each<[string, Record<string, Answer>]>([
		['the query fails', {}],
		['a flag is not a boolean', { [QUERY]: success({ ...BACKEND_FLAGS, campaigns: 'off' }) }],
		['the answer is not a flag map', { [QUERY]: success(['campaigns']) }],
		['the answer is empty', { [QUERY]: success({}) }],
	])('leaves the mirror alone when %s', async (_label, answers) => {
		const convex = await fakeConvex(answers);
		const install = await makeInstall({ mirror: DEFAULT_MIRROR });

		const result = await install.sync({ OWLAT_CONVEX_URL: convex.url });

		expect(result.code).toBe(1);
		expect(result.out).toContain('could not read the feature flags from the backend');
		await expect(readFile(join(install.dir, MIRROR), 'utf8')).resolves.toBe(DEFAULT_MIRROR);
		expect((await readdir(install.dir)).filter((name) => name.startsWith(MIRROR))).toEqual([
			MIRROR,
		]);
	});

	it('leaves the mirror alone when the backend is unreachable', async () => {
		const convex = await fakeConvex({});
		const install = await makeInstall({ mirror: DEFAULT_MIRROR });

		// A port nothing listens on: the fake server's, after it is closed.
		const closed = await new Promise<string>((resolve) => {
			const probe = createServer();
			probe.listen(0, '127.0.0.1', () => {
				const port = (probe.address() as AddressInfo).port;
				probe.close(() => resolve(`http://127.0.0.1:${port}`));
			});
		});
		const result = await install.sync({ OWLAT_CONVEX_URL: closed });

		expect(convex.paths).toEqual([]);
		expect(result.code).toBe(1);
		expect(result.out).toContain(`Could not reach the Convex backend at ${closed}`);
		await expect(readFile(join(install.dir, MIRROR), 'utf8')).resolves.toBe(DEFAULT_MIRROR);
	});

	it('leaves the mirror alone when the web container is not running', async () => {
		const install = await makeInstall({ mirror: DEFAULT_MIRROR });

		const result = await install.sync({ STUB_WEB_DOWN: '1' });

		expect(result.code).toBe(1);
		expect(result.out).toContain("The stack must be running with Convex healthy ('owlat status')");
		await expect(readFile(join(install.dir, MIRROR), 'utf8')).resolves.toBe(DEFAULT_MIRROR);
	});

	it('takes no further arguments', async () => {
		const install = await makeInstall();

		const result = await install.sync({}, ['feature', '--sync', 'campaigns']);

		expect(result.code).toBe(2);
		expect(result.out).toContain('Usage: owlat feature --sync');
		expect(result.calls).toEqual([]);
	});

	it('is listed in the wrapper help', async () => {
		const install = await makeInstall();

		const result = await install.sync({}, ['--help']);

		expect(result.out).toContain('owlat feature --sync');
	});
});
