/**
 * The legacy bash wizard (`scripts/setup.sh`, self-host mode) writes every
 * deployment secret into `.env`. The file, and the backup it takes of an
 * existing one, must end up owner-only even when the `.env` already there was
 * readable by other local users, and the wizard must stop before writing when
 * it cannot make it so.
 *
 * The script runs its whole interactive flow when executed, so these cases
 * lift the two functions under test out of it and run them in bash against a
 * temp directory, with the wizard's output helpers stubbed.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SETUP = fileURLToPath(new URL('../setup.sh', import.meta.url));
const run = promisify(execFile);

/** The text of `name() { … }` in setup.sh, up to its closing brace at column 0. */
async function extractFunction(name: string): Promise<string> {
	const source = await readFile(SETUP, 'utf-8');
	const start = source.indexOf(`\n${name}() {\n`);
	expect(start, `${name} not found in setup.sh`).toBeGreaterThan(-1);
	const end = source.indexOf('\n}\n', start);
	return source.slice(start + 1, end + 3);
}

async function writeSelfhostEnv(cwd: string, prelude = ''): Promise<void> {
	const script = [
		'set -eo pipefail',
		'declare -A SELFHOST_VARS=([INSTANCE_SECRET]=test-instance-secret)',
		'section() { :; }; success() { :; }; info() { :; }; warn() { :; }; owl_say() { :; }',
		'error() { echo "$1" >&2; }',
		prelude,
		await extractFunction('secure_env_file'),
		await extractFunction('write_selfhost_env'),
		'write_selfhost_env',
	].join('\n');
	await run('bash', ['-c', script], { cwd });
}

async function modeOf(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

describe.skipIf(process.platform === 'win32')('setup.sh write_selfhost_env', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'owlat-setup-sh-'));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('creates .env owner-only', async () => {
		await writeSelfhostEnv(dir);

		expect(await modeOf(join(dir, '.env'))).toBe(0o600);
		expect(await readFile(join(dir, '.env'), 'utf-8')).toContain(
			'INSTANCE_SECRET=test-instance-secret'
		);
	});

	it('makes an existing world-readable .env and its backup owner-only', async () => {
		await writeFile(
			join(dir, '.env'),
			'FBL_DEDUP_PROTOCOL=owned-v2\nFBL_DEDUP_CUTOVER_ACK=fresh-install\nINSTANCE_SECRET=old\n'
		);
		await chmod(join(dir, '.env'), 0o644);

		await writeSelfhostEnv(dir);

		expect(await modeOf(join(dir, '.env'))).toBe(0o600);
		const backups = (await readdir(dir)).filter((name) => name.startsWith('.env.backup.'));
		expect(backups).toHaveLength(1);
		expect(await modeOf(join(dir, backups[0]!))).toBe(0o600);
		expect(await readFile(join(dir, backups[0]!), 'utf-8')).toContain('INSTANCE_SECRET=old');
	});

	it('stops without writing when .env cannot be made owner-only', async () => {
		const original =
			'FBL_DEDUP_PROTOCOL=owned-v2\nFBL_DEDUP_CUTOVER_ACK=fresh-install\nINSTANCE_SECRET=old\n';
		await writeFile(join(dir, '.env'), original);
		await chmod(join(dir, '.env'), 0o644);

		await expect(writeSelfhostEnv(dir, 'chmod() { return 1; }')).rejects.toMatchObject({
			stderr: expect.stringContaining('Could not make .env owner-only'),
		});
		expect(await readFile(join(dir, '.env'), 'utf-8')).toBe(original);
		expect((await readdir(dir)).filter((name) => name.startsWith('.env.backup.'))).toEqual([]);
	});
});
