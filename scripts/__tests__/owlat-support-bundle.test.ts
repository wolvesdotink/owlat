/**
 * `owlat support-bundle` runs the collector in the version-pinned setup image
 * and writes the archive it streams on stdout to a host file. These cases run
 * the REAL `scripts/owlat` against a stub `docker` that records each call and
 * the environment it saw, and answer the setup image with a fake archive.
 */

import { execFile } from 'node:child_process';
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

// Answers:
//   compose config               → a rendered config naming the project
//   network ls …                 → $STUB_NETWORK (default owlat-test_default)
//   run … --help                 → $STUB_SETUP_HELP (default lists support-bundle)
//   run … support-bundle …       → FAKE-ARCHIVE on stdout, exit $STUB_BUNDLE_EXIT;
//                                  first creates $STUB_CREATE if set, and sends
//                                  the wrapper $STUB_SIGNAL if set
const STUB_DOCKER = `#!/bin/sh
printf '%s | profiles=%s project=%s\\n' "$*" "\${COMPOSE_PROFILES-<unset>}" "\${COMPOSE_PROJECT_NAME-<unset>}" >> "$STUB_LOG"
case "$*" in
	"compose config") printf 'name: owlat-test\\nservices: {}\\n' ;;
	network\\ ls*) printf '%s\\n' "\${STUB_NETWORK-owlat-test_default}" ;;
	run\\ *--help)
		printf '%s\\n' "\${STUB_SETUP_HELP-  support-bundle [--lines N] [--output FILE|-]}"
		;;
	run\\ *support-bundle*)
		[ -z "\${STUB_CREATE-}" ] || printf 'created meanwhile' > "$STUB_CREATE"
		printf 'FAKE-ARCHIVE'
		echo "collector progress" >&2
		[ -z "\${STUB_SIGNAL-}" ] || kill -"$STUB_SIGNAL" "$PPID"
		exit "\${STUB_BUNDLE_EXIT:-0}" ;;
esac
exit 0
`;

async function makeInstall() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'owlat-bundle-')));
	roots.push(root);
	const dir = join(root, 'owlat');
	const caller = join(root, 'caller');
	const stubDir = join(root, 'stub-bin');
	await mkdir(join(dir, 'scripts'), { recursive: true });
	await mkdir(caller, { recursive: true });
	await mkdir(stubDir, { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, 'scripts/owlat'), join(dir, 'scripts', 'owlat'));
	await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
	await writeFile(join(dir, '.env'), 'COMPOSE_PROFILES=mta\n');
	await writeFile(join(stubDir, 'docker'), STUB_DOCKER);
	await chmod(join(stubDir, 'docker'), 0o755);
	const log = join(root, 'docker-calls.log');
	return {
		dir,
		caller,
		async invoke(args: string[], env: Record<string, string> = {}) {
			const base = { ...process.env };
			delete base['COMPOSE_PROFILES'];
			delete base['COMPOSE_PROJECT_NAME'];
			try {
				const { stdout, stderr } = await run('bash', [join(dir, 'scripts', 'owlat'), ...args], {
					cwd: caller,
					env: {
						...base,
						PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
						OWLAT_DIR: dir,
						OWLAT_SKIP_CLI_LINK: '1',
						OWLAT_SETUP_IMAGE: 'setup-image:test',
						STUB_LOG: log,
						...env,
					},
				});
				return { code: 0, stdout, stderr };
			} catch (error) {
				const failure = error as { code?: number; stdout?: string; stderr?: string };
				return {
					code: failure.code ?? 1,
					stdout: failure.stdout ?? '',
					stderr: failure.stderr ?? '',
				};
			}
		},
		async calls() {
			return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
		},
	};
}

describe('owlat support-bundle', () => {
	it('runs the collector with the socket, project and profiles, and writes its stdout owner-only', async () => {
		const install = await makeInstall();
		const result = await install.invoke([
			'support-bundle',
			'--lines',
			'50',
			'--output',
			'out/bundle.tar.gz',
		]);
		expect(result.code, result.stderr).toBe(1);
		expect(result.stderr).toContain('cannot write');

		await mkdir(join(install.caller, 'out'));
		const ok = await install.invoke(['support-bundle', '--lines', '50', '-o', 'out/bundle.tar.gz']);
		expect(ok.code, ok.stderr).toBe(0);
		const target = join(install.caller, 'out', 'bundle.tar.gz');
		expect(await readFile(target, 'utf8')).toBe('FAKE-ARCHIVE');
		expect((await stat(target)).mode & 0o777).toBe(0o600);
		expect(await readdir(join(install.caller, 'out'))).toEqual(['bundle.tar.gz']);
		expect(ok.stdout).toContain(`Support bundle written to ${target}`);

		const collector = (await install.calls()).find((call) => call.includes(' support-bundle '));
		expect(collector).toContain('run --rm --network owlat-test_default -v');
		expect(collector).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
		expect(collector).toContain('-e COMPOSE_PROJECT_NAME=owlat-test');
		expect(collector).toContain('-e COMPOSE_PROFILES=mta');
		expect(collector).toContain('setup-image:test support-bundle --output - --lines 50 |');
		expect(await install.calls()).toContain(
			'network ls --filter label=com.docker.compose.project=owlat-test --filter label=com.docker.compose.network=default --format {{.Name}} | profiles=mta project=<unset>'
		);
	});

	it('runs on the default bridge when the stack has no network yet', async () => {
		const install = await makeInstall();
		const result = await install.invoke(['support-bundle', '-o', 'bundle.tar.gz'], {
			STUB_NETWORK: '',
		});
		expect(result.code, result.stderr).toBe(0);
		const collector = (await install.calls()).find((call) => call.includes(' support-bundle '));
		expect(collector).not.toContain('--network');
	});

	it('never writes through a file or symlink already beside the output', async () => {
		const install = await makeInstall();
		const sentinel = join(install.caller, 'sentinel');
		await writeFile(sentinel, 'untouched');
		await symlink(sentinel, join(install.caller, 'bundle.tar.gz.partial'));
		await writeFile(join(install.caller, 'bundle.tar.gz.partial-1'), 'open', { mode: 0o644 });
		const result = await install.invoke(['support-bundle', '-o', 'bundle.tar.gz']);
		expect(result.code, result.stderr).toBe(0);
		expect(await readFile(sentinel, 'utf8')).toBe('untouched');
		const target = join(install.caller, 'bundle.tar.gz');
		expect(await readFile(target, 'utf8')).toBe('FAKE-ARCHIVE');
		expect((await stat(target)).mode & 0o777).toBe(0o600);
		expect((await readdir(install.caller)).sort()).toEqual([
			'bundle.tar.gz',
			'bundle.tar.gz.partial',
			'bundle.tar.gz.partial-1',
			'sentinel',
		]);
	});

	it('keeps an output created while the bundle was collected', async () => {
		const install = await makeInstall();
		const target = join(install.caller, 'bundle.tar.gz');
		const result = await install.invoke(['support-bundle', '-o', 'bundle.tar.gz'], {
			STUB_CREATE: target,
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('was created while the bundle was collected');
		expect(await readFile(target, 'utf8')).toBe('created meanwhile');
		expect(await readdir(install.caller)).toEqual(['bundle.tar.gz']);
	});

	it('removes the temp file when interrupted', async () => {
		const install = await makeInstall();
		const result = await install.invoke(['support-bundle', '-o', 'bundle.tar.gz'], {
			STUB_SIGNAL: 'TERM',
		});
		expect(result.code).toBe(143);
		expect(await readdir(install.caller)).toEqual([]);
	});

	it('refuses an option without its value before collecting anything', async () => {
		for (const args of [['--output'], ['-o'], ['--lines'], ['--output='], ['-o', '--lines', '5']]) {
			const install = await makeInstall();
			const result = await install.invoke(['support-bundle', ...args]);
			expect(result.code, args.join(' ')).toBe(2);
			expect(result.stderr).toContain('needs a value');
			expect(await readdir(install.caller)).toEqual([]);
			expect(await install.calls()).toEqual([]);
		}
	});

	it('names the archive after the time, in the directory the operator ran it from', async () => {
		const install = await makeInstall();
		const result = await install.invoke(['support-bundle']);
		expect(result.code, result.stderr).toBe(0);
		const files = await readdir(install.caller);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^owlat-support-\d{8}T\d{6}Z\.tar\.gz$/);
	});

	it('removes the partial file and passes the exit code on when collection fails', async () => {
		const install = await makeInstall();
		const result = await install.invoke(['support-bundle', '--output', 'bundle.tar.gz'], {
			STUB_BUNDLE_EXIT: '3',
		});
		expect(result.code).toBe(3);
		expect(result.stderr).toContain('could not be collected');
		expect(await readdir(install.caller)).toEqual([]);
	});

	it('writes nothing when the pinned setup image predates the command', async () => {
		const install = await makeInstall();
		const result = await install.invoke(['support-bundle', '--output', 'bundle.tar.gz'], {
			STUB_SETUP_HELP: '  doctor [--json]',
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("predates 'owlat support-bundle'");
		expect(await readdir(install.caller)).toEqual([]);
		expect((await install.calls()).some((call) => call.includes(' support-bundle '))).toBe(false);
	});

	it('never overwrites an existing file', async () => {
		const install = await makeInstall();
		await writeFile(join(install.caller, 'bundle.tar.gz'), 'keep me');
		const result = await install.invoke(['support-bundle', '--output=bundle.tar.gz']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('already exists');
		expect(await readFile(join(install.caller, 'bundle.tar.gz'), 'utf8')).toBe('keep me');
	});
});
