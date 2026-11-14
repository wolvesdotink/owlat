/**
 * `curl … | bash` runs the installer inside a container that `scripts/owlat`
 * starts, so a headless answer given as an environment variable only arrives if
 * the wrapper passes it in. These cases run the REAL wrapper against a stub
 * `docker` that records its arguments, and hold the wrapper's list equal to the
 * variables the headless install reads (`ASSUME_YES_ENV_KEYS`).
 */

import { execFile } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ASSUME_YES_ENV_KEYS } from '../commands/setupNonInteractive';

const WRAPPER = fileURLToPath(new URL('../../../../scripts/owlat', import.meta.url));
const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// `docker run` writes its arguments, one per line, to $STUB_LOG; everything
// else succeeds silently (`docker info` names no Docker Desktop: the Linux path).
const STUB_DOCKER = `#!/bin/sh
if [ "$1" = run ]; then printf '%s\\n' "$@" > "$STUB_LOG"; fi
exit 0
`;

const SECRET = 'fixture-admin-password-value';

async function dockerRunArgs(command: string[]): Promise<string[]> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'owlat-wrapper-env-')));
	roots.push(root);
	const dir = join(root, 'owlat');
	const stubDir = join(root, 'stub-bin');
	await mkdir(join(dir, 'scripts'), { recursive: true });
	await mkdir(stubDir, { recursive: true });
	await copyFile(WRAPPER, join(dir, 'scripts', 'owlat'));
	await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
	await writeFile(join(stubDir, 'docker'), STUB_DOCKER);
	await chmod(join(stubDir, 'docker'), 0o755);
	const log = join(root, 'docker-run.log');
	const answers = Object.fromEntries(ASSUME_YES_ENV_KEYS.map((key) => [key, `value-of-${key}`]));
	await run('bash', [join(dir, 'scripts', 'owlat'), ...command], {
		env: {
			PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
			HOME: root,
			OWLAT_DIR: dir,
			OWLAT_SKIP_CLI_LINK: '1',
			OWLAT_SETUP_IMAGE: 'setup-image:test',
			STUB_LOG: log,
			...answers,
			OWLAT_ADMIN_PASSWORD: SECRET,
			UNRELATED_HOST_SECRET: 'must-stay-on-the-host',
		},
	});
	return (await readFile(log, 'utf8')).trimEnd().split('\n');
}

/** The variable names a `docker run` argument list passes with `-e NAME`. */
function passedByName(args: string[]): string[] {
	return args.flatMap((arg, i) => (args[i - 1] === '-e' && !arg.includes('=') ? [arg] : []));
}

describe.skipIf(process.platform === 'win32')('scripts/owlat installer environment', () => {
	it.each([
		['quickstart', ['quickstart', '--terminal', '--assume-yes']],
		['setup', ['setup', '--terminal']],
	])('%s passes exactly the headless answers into the container', async (_name, command) => {
		const args = await dockerRunArgs(command);
		expect(passedByName(args).sort()).toEqual([...ASSUME_YES_ENV_KEYS].sort());
		// By name only: values (the admin password) stay off the command line,
		// and nothing else from the host environment is passed.
		expect(args.join(' ')).not.toContain(SECRET);
		expect(args.join(' ')).not.toContain('UNRELATED_HOST_SECRET');
	});

	it('runs setup on the host network so its port check reaches this machine', async () => {
		const args = await dockerRunArgs(['setup', '--terminal']);
		expect(args.slice(0, args.indexOf('setup-image:test'))).toEqual(
			expect.arrayContaining(['--network', 'host'])
		);
	});
});
