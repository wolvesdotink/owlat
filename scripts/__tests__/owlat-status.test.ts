/**
 * `owlat status` names the release `.env` pins and warns when the git checkout
 * in the install directory is another one: updates replace the compose file and
 * `.env`, never the checkout. These cases run the REAL `scripts/owlat` in a
 * real git repository, against a stub `docker` that only answers `compose ps`.
 */

import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);

const STUB_DOCKER = `#!/bin/sh
if [ "$1 $2" = "compose ps" ]; then
	echo "NAME  SERVICE  STATUS"
	exit 0
fi
echo "unexpected docker call: $*" >&2
exit 3
`;

let root = '';
let dir = '';
let stubDir = '';

const GIT_ENV = {
	GIT_AUTHOR_NAME: 'Owlat',
	GIT_AUTHOR_EMAIL: 'release@owlat.app',
	GIT_COMMITTER_NAME: 'Owlat',
	GIT_COMMITTER_EMAIL: 'release@owlat.app',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
};

async function git(...args: string[]): Promise<void> {
	await run('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_ENV } });
}

/** A checkout of `tags` in order, each an annotated tag on its own commit, left at the first. */
async function checkoutOf(tags: string[]): Promise<void> {
	await git('init', '-q');
	for (const tag of tags) {
		await git('commit', '-q', '--allow-empty', '-m', tag);
		await git('tag', '-a', tag, '-m', tag);
	}
	await git('checkout', '-q', '--detach', tags[0]!);
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'owlat-status-cli-')));
	dir = join(root, 'owlat');
	stubDir = join(root, 'stub-bin');
	await mkdir(join(dir, 'scripts'), { recursive: true });
	await mkdir(stubDir, { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, 'scripts/owlat'), join(dir, 'scripts', 'owlat'));
	await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
	await writeFile(join(stubDir, 'docker'), STUB_DOCKER);
	await chmod(join(stubDir, 'docker'), 0o755);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function status(): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run('bash', [join(dir, 'scripts', 'owlat'), 'status'], {
			env: {
				...process.env,
				...GIT_ENV,
				PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
				OWLAT_DIR: dir,
				OWLAT_SKIP_CLI_LINK: '1',
			},
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
	}
}

describe('owlat status', () => {
	it('names the running release and warns when the checkout is an older one', async () => {
		await checkoutOf(['v0.4.19', 'v0.6.24']);
		await writeFile(join(dir, '.env'), 'OWLAT_VERSION=0.6.24\n');

		const result = await status();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('NAME  SERVICE  STATUS');
		expect(result.stdout).not.toContain('v0.6.24');
		expect(result.stderr).toContain('Owlat v0.6.24 runs here');
		expect(result.stderr).toContain(`The source tree in ${dir} is v0.4.19, not v0.6.24`);
		expect(result.stderr).toContain('https://github.com/wolvesdotink/owlat/tree/v0.6.24');
	});

	it('does not warn when the checkout is the running release', async () => {
		await checkoutOf(['v0.6.24']);
		await writeFile(join(dir, '.env'), 'OWLAT_VERSION=0.6.24\n');

		const result = await status();

		expect(result.stderr).toContain('Owlat v0.6.24 runs here');
		expect(result.stderr).not.toContain('[warn]');
	});

	it('says nothing about versions on a stack built from the tree it runs in', async () => {
		await checkoutOf(['v0.4.19']);
		await writeFile(join(dir, '.env'), 'OWLAT_VERSION=dev\n');

		const result = await status();

		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
	});
});
