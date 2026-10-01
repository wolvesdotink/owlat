/**
 * The desktop wizard uploads a setup config holding the admin password and
 * provider keys in plaintext, then runs `scripts/owlat quickstart --config` with
 * OWLAT_CONSUME_CONFIG=1. The wrapper must then delete that file when the run
 * ends, however it ends (issue #953): a failed install, a signal, or the SSH
 * session that started it going away must not leave the secret on the server.
 *
 * These cases run the REAL `scripts/owlat` against a stub `docker` that records
 * whether the config was still on disk while the setup container ran.
 */

import { execFile, spawn } from 'node:child_process';
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

// `docker run …` (the setup container) logs whether the config is still there,
// optionally sleeps, and exits with $STUB_RUN_EXIT. Everything else succeeds
// silently (`docker info` reports no Docker Desktop, so the Linux path runs).
const STUB_DOCKER = `#!/bin/sh
case "$1" in
	run)
		if [ -f "$STUB_CONFIG" ]; then echo "run: config present" >> "$STUB_LOG"; else echo "run: config missing" >> "$STUB_LOG"; fi
		[ -n "$STUB_RUN_SLEEP" ] && sleep "$STUB_RUN_SLEEP"
		exit "\${STUB_RUN_EXIT:-0}" ;;
esac
exit 0
`;

interface Install {
	readonly config: string;
	readonly log: string;
	readonly env: (extra: Record<string, string>) => NodeJS.ProcessEnv;
	readonly script: string;
}

async function makeInstall(): Promise<Install> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'owlat-consume-')));
	roots.push(root);
	const dir = join(root, 'owlat');
	const stubDir = join(root, 'stub-bin');
	await mkdir(join(dir, 'scripts'), { recursive: true });
	await mkdir(stubDir, { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, 'scripts/owlat'), join(dir, 'scripts', 'owlat'));
	await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
	await writeFile(join(stubDir, 'docker'), STUB_DOCKER);
	await chmod(join(stubDir, 'docker'), 0o755);
	const config = join(dir, '.owlat-setup.json');
	await writeFile(config, '{"admin":{"password":"fixture-only"}}\n', { mode: 0o600 });
	const log = join(root, 'docker-calls.log');
	return {
		config,
		log,
		script: join(dir, 'scripts', 'owlat'),
		env: (extra) => ({
			...process.env,
			PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
			OWLAT_DIR: dir,
			OWLAT_SKIP_CLI_LINK: '1',
			OWLAT_SETUP_IMAGE: 'setup-image:test',
			STUB_LOG: log,
			STUB_CONFIG: config,
			...extra,
		}),
	};
}

async function quickstart(
	install: Install,
	extra: Record<string, string>
): Promise<{ code: number; stdout: string }> {
	try {
		const { stdout } = await run(
			'bash',
			[install.script, 'quickstart', '--terminal', '--config', install.config],
			{ env: install.env(extra) }
		);
		return { code: 0, stdout };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? '' };
	}
}

const log = async (install: Install) => (await readFile(install.log, 'utf8')).trim().split('\n');

describe('scripts/owlat quickstart with OWLAT_CONSUME_CONFIG=1', () => {
	it('deletes the config after a successful run, which still read it', async () => {
		const install = await makeInstall();
		const result = await quickstart(install, { OWLAT_CONSUME_CONFIG: '1' });
		expect(result.code).toBe(0);
		expect(await log(install)).toEqual(['run: config present']);
		expect(existsSync(install.config)).toBe(false);
	});

	it('deletes the config when the installer fails, and keeps its exit code', async () => {
		const install = await makeInstall();
		const result = await quickstart(install, { OWLAT_CONSUME_CONFIG: '1', STUB_RUN_EXIT: '3' });
		expect(result.code).toBe(3);
		expect(await log(install)).toEqual(['run: config present']);
		expect(existsSync(install.config)).toBe(false);
	});

	it('deletes the config when the wrapper is told to hang up mid-run', async () => {
		const install = await makeInstall();
		const child = spawn(
			'bash',
			[install.script, 'quickstart', '--terminal', '--config', install.config],
			{ env: install.env({ OWLAT_CONSUME_CONFIG: '1', STUB_RUN_SLEEP: '1' }), stdio: 'ignore' }
		);
		const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
		// Wait until the setup container is running, then hang up the wrapper.
		const started = Date.now();
		while (!existsSync(install.log) && Date.now() - started < 5000) {
			await new Promise((r) => setTimeout(r, 20));
		}
		child.kill('SIGHUP');
		expect(await exited).toBe(129);
		expect(existsSync(install.config)).toBe(false);
	});

	it('leaves the config alone without the variable (install.sh and hand-run installs)', async () => {
		const install = await makeInstall();
		const result = await quickstart(install, {});
		expect(result.code).toBe(0);
		expect(existsSync(install.config)).toBe(true);
	});
});
