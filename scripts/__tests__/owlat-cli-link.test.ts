/**
 * `owlat` must end up on PATH no matter how a box was provisioned.
 *
 * install.sh used to be the only thing that created `/usr/local/bin/owlat`,
 * while the desktop SSH wizard and the documented hand-clone flow both clone the
 * repo themselves and run `./scripts/owlat quickstart` directly — so those boxes
 * got a working stack and no `owlat` command, contradicting the day-2 ops docs.
 * The link now lives in the wrapper, which every one of those paths goes through.
 *
 * These cases exercise the REAL `scripts/owlat`, copied into a throwaway clone,
 * with `OWLAT_CLI_LINK` pointed at a temporary directory instead of
 * `/usr/local/bin`. A stub `docker` on PATH lets the wizard subcommands run to
 * their `exec docker …` line without a daemon, which is precisely the point: the
 * link has to be in place BEFORE the wizard takes over the process.
 */

import { execFile } from 'node:child_process';
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WRAPPER = 'scripts/owlat';

const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

interface Clone {
	/** Install dir holding the copied wrapper — `$OWLAT_DIR` on a real box. */
	readonly owlatDir: string;
	/** The wrapper's own path; what a correct symlink must point at. */
	readonly wrapper: string;
	/** Stands in for `/usr/local/bin/owlat`. */
	readonly link: string;
	readonly invoke: (args: string[], env?: Record<string, string>) => Promise<CommandResult>;
}

interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * A throwaway install: the real wrapper, a `docker-compose.yml` so it accepts
 * the directory as an install, and a stub `docker` that succeeds silently.
 */
async function makeClone(): Promise<Clone> {
	// mkdtemp hands back /var/… on macOS while the wrapper resolves its own path
	// through a real `cd`, which yields /private/var/… — compare like for like.
	const root = await realpath(await mkdtemp(join(tmpdir(), 'owlat-cli-link-')));
	roots.push(root);

	const owlatDir = join(root, 'opt', 'owlat');
	const binDir = join(root, 'usr', 'local', 'bin');
	const stubDir = join(root, 'stub-bin');
	await mkdir(join(owlatDir, 'scripts'), { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(stubDir, { recursive: true });

	const wrapper = join(owlatDir, 'scripts', 'owlat');
	await copyFile(join(REPOSITORY_ROOT, WRAPPER), wrapper);
	await chmod(wrapper, 0o755);
	await writeFile(join(owlatDir, 'docker-compose.yml'), 'services: {}\n', 'utf8');

	// Records its argv so a test can prove the wizard was actually reached.
	await writeFile(
		join(stubDir, 'docker'),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(root, 'docker-calls.log')}"\nexit 0\n`,
		'utf8'
	);
	await chmod(join(stubDir, 'docker'), 0o755);

	const link = join(binDir, 'owlat');

	return {
		owlatDir,
		wrapper,
		link,
		async invoke(args, env = {}) {
			try {
				const { stdout, stderr } = await run('bash', [wrapper, ...args], {
					env: {
						...process.env,
						PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
						OWLAT_DIR: owlatDir,
						OWLAT_CLI_LINK: link,
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
	};
}

describe('owlat install-cli', () => {
	it('links the wrapper onto PATH', async () => {
		const clone = await makeClone();

		const result = await clone.invoke(['install-cli']);

		expect(result.code).toBe(0);
		await expect(readlink(clone.link)).resolves.toBe(clone.wrapper);
	});

	it('is idempotent — a second run leaves the same link and succeeds', async () => {
		const clone = await makeClone();
		await clone.invoke(['install-cli']);

		const second = await clone.invoke(['install-cli']);

		expect(second.code).toBe(0);
		await expect(readlink(clone.link)).resolves.toBe(clone.wrapper);
	});

	it('repoints a symlink that targets a different clone', async () => {
		const clone = await makeClone();
		await run('ln', ['-sfn', '/somewhere/else/scripts/owlat', clone.link]);

		const result = await clone.invoke(['install-cli']);

		expect(result.code).toBe(0);
		await expect(readlink(clone.link)).resolves.toBe(clone.wrapper);
	});

	it('refuses to clobber a regular file it does not own', async () => {
		const clone = await makeClone();
		await writeFile(clone.link, '#!/bin/sh\necho someone elses owlat\n', 'utf8');

		const result = await clone.invoke(['install-cli']);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('not a symlink');
		await expect(readFile(clone.link, 'utf8')).resolves.toContain('someone elses owlat');
	});

	it('resolves back to the clone when invoked through the installed link', async () => {
		const clone = await makeClone();
		await clone.invoke(['install-cli']);

		// A second install-cli run driven through the symlink must not turn the
		// link into a self-reference — it has to resolve to the real wrapper.
		const result = await run('bash', [clone.link, 'install-cli'], {
			env: { ...process.env, OWLAT_DIR: clone.owlatDir, OWLAT_CLI_LINK: clone.link },
		});

		expect(result.stdout + result.stderr).not.toContain('could not be written');
		await expect(readlink(clone.link)).resolves.toBe(clone.wrapper);
	});

	it('does nothing when OWLAT_SKIP_CLI_LINK is set', async () => {
		const clone = await makeClone();

		const result = await clone.invoke(['install-cli'], { OWLAT_SKIP_CLI_LINK: '1' });

		expect(result.code).toBe(0);
		await expect(lstat(clone.link)).rejects.toThrow();
	});
});

describe('provisioning subcommands self-heal the link', () => {
	// The exact repair case: a box provisioned by the desktop SSH wizard or a
	// hand clone, which has a working install and no `owlat` on PATH. Re-opening
	// the wizard must fix it.
	it.each(['quickstart', 'setup', 'config'])('%s installs the missing link', async (cmd) => {
		const clone = await makeClone();

		const result = await clone.invoke([cmd, '--assume-yes']);

		expect(result.code).toBe(0);
		await expect(readlink(clone.link)).resolves.toBe(clone.wrapper);
	});

	it('still hands off to the wizard after linking', async () => {
		const clone = await makeClone();

		await clone.invoke(['quickstart']);

		const calls = await readFile(join(clone.owlatDir, '..', '..', 'docker-calls.log'), 'utf8');
		expect(calls).toContain('quickstart');
	});

	it('does not abort the wizard when the link cannot be written', async () => {
		const clone = await makeClone();

		const result = await clone.invoke(['quickstart'], {
			OWLAT_CLI_LINK: join(clone.owlatDir, 'no-such-dir', 'owlat'),
		});

		expect(result.code).toBe(0);
		expect(result.stderr).toContain('install-cli');
	});

	// Day-2 ops commands are not provisioning. `owlat logs` must not quietly
	// rewrite a system path as a side effect of tailing a log.
	it.each(['status', 'logs'])('%s leaves /usr/local/bin alone', async (cmd) => {
		const clone = await makeClone();

		await clone.invoke([cmd]);

		await expect(lstat(clone.link)).rejects.toThrow();
	});
});
