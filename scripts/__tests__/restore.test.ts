/**
 * scripts/restore.sh must fail closed.
 *
 * It used to ignore a failing `docker compose down` and a failing volume
 * removal, went on to extract over whatever was there, and printed "Restore
 * complete." A corrupt inner volume.tar was only discovered after the live
 * volumes had already been wiped.
 *
 * These cases run the REAL script against a fake `docker` on PATH. The fake
 * keeps each named volume as a plain directory and runs the script's container
 * commands on the host with the mount points mapped to those directories, so a
 * test can check the data a failure leaves behind, not just the calls made.
 * Failures are injected by matching the fake's argv against a regex.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const RESTORE = fileURLToPath(new URL('../restore.sh', import.meta.url));
const PROJECT = 'owlat';

const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/*
 * FAKE_DOCKER_FAIL        regex; a matching call exits 1 without doing anything
 * FAKE_DOCKER_FAIL_ONCE   set: only the first matching call fails (transient)
 * FAKE_DOCKER_FAIL_AFTER  regex; a matching call does its work, then exits 1
 *                         (a partial extraction)
 * FAKE_DOCKER_PS          what `docker ps` prints (a container still running)
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
line="$*"
if [[ -n "\${FAKE_DOCKER_FAIL:-}" && "$line" =~ $FAKE_DOCKER_FAIL ]]; then
	if [[ -z "\${FAKE_DOCKER_FAIL_ONCE:-}" || ! -e "$FAKE_DOCKER_ROOT/failed-once" ]]; then
		touch "$FAKE_DOCKER_ROOT/failed-once"
		echo "fake docker: injected failure" >&2
		exit 1
	fi
fi
fail_after=0
if [[ -n "\${FAKE_DOCKER_FAIL_AFTER:-}" && "$line" =~ $FAKE_DOCKER_FAIL_AFTER ]]; then
	fail_after=1
fi
vols="$FAKE_DOCKER_ROOT/volumes"
case "$1" in
	compose)
		[[ "$2" == config ]] && echo "name: ${PROJECT}"
		;;
	ps)
		[[ -n "\${FAKE_DOCKER_PS:-}" ]] && echo "$FAKE_DOCKER_PS"
		;;
	volume)
		name="\${@: -1}"
		case "$2" in
			inspect) [[ -d "$vols/$name" ]] || { echo "no such volume: $name" >&2; exit 1; } ;;
			create) mkdir -p "$vols/$name" ;;
			rm) rm -rf "\${vols:?}/$name" ;;
		esac
		;;
	run)
		shift
		points=(); hosts=()
		while [[ "$1" != busybox:latest ]]; do
			if [[ "$1" == -v ]]; then
				src="\${2%%:*}"; rest="\${2#*:}"; point="\${rest%%:*}"
				if [[ "$src" == /* ]]; then host="$src"; else host="$vols/$src"; mkdir -p "$host"; fi
				points+=("$point"); hosts+=("$host")
				shift 2
			else
				shift
			fi
		done
		shift
		args=()
		for a in "$@"; do
			for i in "\${!points[@]}"; do
				p="\${points[$i]}"
				if [[ "$a" == "$p" || "$a" == "$p"/* ]]; then a="\${hosts[$i]}\${a#"$p"}"; break; fi
			done
			args+=("$a")
		done
		"\${args[@]}" || exit $?
		;;
esac
if [[ $fail_after == 1 ]]; then
	echo "fake docker: injected failure after running" >&2
	exit 1
fi
exit 0
`;

interface Result {
	readonly code: number;
	readonly out: string;
	readonly calls: string[];
}

interface Install {
	readonly dir: string;
	readonly archive: string;
	readonly volume: (suffix: string) => string;
	readonly run: (env?: Record<string, string>) => Promise<Result>;
	readonly volumeNames: () => Promise<string[]>;
}

type Payload = string | Buffer | { files: Record<string, string> };

/**
 * An install with live data in convex-data and redis-data (mail-certs does
 * not exist yet) and a backup archive carrying all three volumes.
 */
async function makeInstall(
	payloads: Record<string, Payload> = {},
	options: { manifestExtra?: string } = {}
): Promise<Install> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-restore-'));
	roots.push(root);
	const dir = join(root, 'install');
	const bin = join(root, 'bin');
	const vols = join(root, 'volumes');
	const log = join(root, 'docker.log');
	await mkdir(dir, { recursive: true });
	await mkdir(bin);
	await writeFile(join(bin, 'docker'), FAKE_DOCKER);
	await chmod(join(bin, 'docker'), 0o755);
	await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
	await writeFile(join(dir, '.env'), 'CURRENT=1\n');

	const volume = (suffix: string) => join(vols, `${PROJECT}_${suffix}`);
	for (const suffix of ['convex-data', 'redis-data']) {
		await mkdir(volume(suffix), { recursive: true });
		await writeFile(join(volume(suffix), 'old.txt'), `old ${suffix}\n`);
	}

	// Build the archive the way backup.sh lays it out.
	const staging = join(root, 'staging');
	const content: Record<string, Payload> = {
		'convex-data': { files: { 'db.sqlite': 'new convex\n' } },
		'redis-data': { files: { 'appendonly.aof': 'new redis\n' } },
		'mail-certs': { files: { 'cert.pem': 'new cert\n' } },
		...payloads,
	};
	let listed = '';
	for (const [suffix, payload] of Object.entries(content)) {
		await mkdir(join(staging, suffix), { recursive: true });
		const tarPath = join(staging, suffix, 'volume.tar');
		if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
			await writeFile(tarPath, payload);
		} else {
			const src = join(root, 'src', suffix);
			await mkdir(src, { recursive: true });
			for (const [name, text] of Object.entries(payload.files)) {
				await writeFile(join(src, name), text);
			}
			await run('tar', ['-cf', tarPath, '-C', src, '.']);
		}
		listed += `  ${suffix}/volume.tar\n`;
	}
	await writeFile(join(staging, 'env'), 'RESTORED=1\n');
	await writeFile(
		join(staging, 'MANIFEST.txt'),
		`Owlat backup\n============\n\nIncludes:\n${listed}${options.manifestExtra ?? ''}  env                      — .env file\n`
	);
	const archive = join(root, 'owlat-20260101-000000.tar.gz');
	await run('tar', ['-czf', archive, '-C', staging, '.']);
	const sha = createHash('sha256')
		.update(await readFile(archive))
		.digest('hex');
	await writeFile(`${archive}.sha256`, `${sha}\n`);

	return {
		dir,
		archive,
		volume,
		volumeNames: async () => (await readdir(vols)).sort(),
		async run(env = {}) {
			await writeFile(log, '');
			const options = {
				cwd: dir,
				env: {
					...process.env,
					PATH: `${bin}:${process.env['PATH'] ?? ''}`,
					FAKE_DOCKER_LOG: log,
					FAKE_DOCKER_ROOT: root,
					TMPDIR: root,
					...env,
				},
			};
			let code = 0;
			let out: string;
			try {
				const r = await run('bash', [RESTORE, '--yes', archive], options);
				out = r.stdout + r.stderr;
			} catch (error) {
				const failure = error as { code?: number; stdout?: string; stderr?: string };
				code = failure.code ?? 1;
				out = (failure.stdout ?? '') + (failure.stderr ?? '');
			}
			const calls = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
			return { code, out, calls };
		},
	};
}

/** A real tar of `files`, for payloads that are then damaged on purpose. */
async function tarOf(files: Record<string, string>): Promise<Buffer> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-restore-tar-'));
	roots.push(root);
	await mkdir(join(root, 'src'));
	for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'src', name), text);
	await run('tar', ['-cf', join(root, 'out.tar'), '-C', join(root, 'src'), '.']);
	return readFile(join(root, 'out.tar'));
}

const isExtraction = (call: string) => call.startsWith('run ') && call.includes('tar -xf');
const isWipe = (call: string) => call.startsWith('run ') && call.includes('rm -rf');

async function expectOriginalData(install: Install) {
	await expect(readFile(join(install.volume('convex-data'), 'old.txt'), 'utf8')).resolves.toBe(
		'old convex-data\n'
	);
	await expect(readFile(join(install.volume('redis-data'), 'old.txt'), 'utf8')).resolves.toBe(
		'old redis-data\n'
	);
	expect(existsSync(join(install.volume('convex-data'), 'db.sqlite'))).toBe(false);
	expect(existsSync(join(install.volume('redis-data'), 'appendonly.aof'))).toBe(false);
	expect(existsSync(install.volume('mail-certs'))).toBe(false);
	await expect(readFile(join(install.dir, '.env'), 'utf8')).resolves.toBe('CURRENT=1\n');
}

describe('restore.sh happy path', () => {
	it('replaces every volume, keeps the old data aside, and only then reports success', async () => {
		const install = await makeInstall();
		const result = await install.run();

		expect(result.out).toContain('Restore complete.');
		expect(result.code).toBe(0);
		for (const [suffix, file, text] of [
			['convex-data', 'db.sqlite', 'new convex\n'],
			['redis-data', 'appendonly.aof', 'new redis\n'],
			['mail-certs', 'cert.pem', 'new cert\n'],
		]) {
			await expect(readFile(join(install.volume(suffix), file), 'utf8')).resolves.toBe(text);
		}
		expect(existsSync(join(install.volume('convex-data'), 'old.txt'))).toBe(false);

		// The previous contents survive in the pre-restore copies.
		const names = await install.volumeNames();
		const kept = names.filter((n) => n.includes('-pre-restore-'));
		expect(kept.map((n) => n.replace(/-pre-restore-.*/, ''))).toEqual([
			'owlat_convex-data',
			'owlat_redis-data',
		]);
		for (const name of kept) {
			const files = await readdir(join(install.volume('x'), '..', name));
			expect(files).toEqual(['old.txt']);
		}
		await expect(readFile(join(install.dir, '.env'), 'utf8')).resolves.toBe('RESTORED=1\n');

		// Shutdown precedes every write; startup follows the last one.
		const down = result.calls.findIndex((c) => c === 'compose down');
		const up = result.calls.findIndex((c) => c === 'compose up -d');
		const firstWrite = result.calls.findIndex((c) => isWipe(c) || isExtraction(c));
		const lastExtraction = result.calls.findLastIndex(isExtraction);
		expect(down).toBeGreaterThanOrEqual(0);
		expect(down).toBeLessThan(firstWrite);
		expect(up).toBeGreaterThan(lastExtraction);
	});

	it('creates a volume missing on this host with the Compose labels backup.sh looks for', async () => {
		const install = await makeInstall();
		const result = await install.run();

		expect(result.code).toBe(0);
		expect(result.calls).toContain(
			`volume create --label com.docker.compose.project=${PROJECT} --label com.docker.compose.volume=mail-certs ${PROJECT}_mail-certs`
		);
		// Existing volumes are emptied in place, never removed and recreated.
		expect(result.calls.some((c) => c.startsWith(`volume rm ${PROJECT}_convex-data`))).toBe(false);
	});
});

describe('restore.sh refuses before touching anything', () => {
	it.each([
		['a garbage payload', Buffer.from('this is not a tar archive at all'.repeat(40))],
		['an empty payload', ''],
	])('rejects %s before stopping the stack', async (_label, payload) => {
		const install = await makeInstall({ 'redis-data': payload });
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toMatch(/redis-data\/volume\.tar is (corrupt|empty)/);
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls).not.toContain('compose down');
		expect(result.calls.some((c) => c.startsWith('run '))).toBe(false);
		await expectOriginalData(install);
	});

	it('rejects a truncated payload before stopping the stack', async () => {
		const whole = await tarOf({ 'appendonly.aof': 'x'.repeat(20_000) });
		const install = await makeInstall({ 'redis-data': whole.subarray(0, 5_000) });
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('redis-data/volume.tar is corrupt or truncated');
		expect(result.calls).not.toContain('compose down');
		expect(result.calls.some(isExtraction)).toBe(false);
		await expectOriginalData(install);
	});

	it('rejects a backup whose manifest lists a payload the archive lost', async () => {
		const install = await makeInstall({}, { manifestExtra: '  clamav-data/volume.tar\n' });
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('clamav-data/volume.tar');
		expect(result.calls).not.toContain('compose down');
		await expectOriginalData(install);
	});
});

describe('restore.sh fails closed when the stack does not stop', () => {
	it('aborts when docker compose down fails', async () => {
		const install = await makeInstall();
		const result = await install.run({ FAKE_DOCKER_FAIL: '^compose down' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('docker compose down failed');
		expect(result.out).not.toContain('Stack stopped');
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls.some((c) => c.startsWith('run ') || c.startsWith('volume create'))).toBe(
			false
		);
		await expectOriginalData(install);
	});

	it('aborts when containers are still running after down reports success', async () => {
		const install = await makeInstall();
		const result = await install.run({ FAKE_DOCKER_PS: '0123456789ab' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('still running');
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls.some((c) => c.startsWith('run '))).toBe(false);
		await expectOriginalData(install);
	});

	it('aborts when the running containers cannot be listed', async () => {
		const install = await makeInstall();
		const result = await install.run({ FAKE_DOCKER_FAIL: '^ps ' });

		expect(result.code).not.toBe(0);
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls.some((c) => c.startsWith('run '))).toBe(false);
		await expectOriginalData(install);
	});
});

describe('restore.sh puts the old data back when replacing fails', () => {
	const WIPE_REDIS = `^run --rm -v ${PROJECT}_redis-data:/dst busybox:latest sh -c find`;

	it('stops at a failed volume wipe, extracts nothing into it, and restores the previous stack', async () => {
		const install = await makeInstall();
		const result = await install.run({ FAKE_DOCKER_FAIL: WIPE_REDIS, FAKE_DOCKER_FAIL_ONCE: '1' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(`Restoring ${PROJECT}_redis-data failed`);
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls.some((c) => isExtraction(c) && c.includes('redis-data:/dst'))).toBe(false);
		await expectOriginalData(install);
		// The stack comes back on the original data.
		expect(result.calls.at(-1)).toBe('compose up -d');
		expect(result.out).toContain('previous stack is running again');
	});

	it('leaves the stack down and names the volume when it cannot be put back', async () => {
		const install = await makeInstall();
		const result = await install.run({ FAKE_DOCKER_FAIL: WIPE_REDIS });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(`${PROJECT}_redis-data (copy ${PROJECT}_redis-data-pre-restore-`);
		expect(result.out).toContain('The stack is stopped');
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls).not.toContain('compose up -d');
		// The volumes that could be put back were; the copy of the stuck one is kept.
		await expect(readFile(join(install.volume('convex-data'), 'old.txt'), 'utf8')).resolves.toBe(
			'old convex-data\n'
		);
		expect(existsSync(install.volume('mail-certs'))).toBe(false);
		expect(
			(await install.volumeNames()).some((n) => n.startsWith(`${PROJECT}_redis-data-pre-restore-`))
		).toBe(true);
	});

	it('rolls every volume back after a partial extraction', async () => {
		const install = await makeInstall();
		// Extraction into the last volume writes its files, then fails.
		const result = await install.run({
			FAKE_DOCKER_FAIL_AFTER: `^run --rm -v ${PROJECT}_redis-data:/dst -v .* tar -xf`,
		});

		expect(result.code).not.toBe(0);
		expect(result.out).not.toContain('Restore complete');
		// convex-data and mail-certs were fully restored before the failure:
		// both must be back to their pre-restore state too.
		await expectOriginalData(install);
		expect(existsSync(join(install.volume('redis-data'), 'appendonly.aof'))).toBe(false);
	});

	it('aborts without changing data when the pre-restore copy cannot be made', async () => {
		const install = await makeInstall();
		const result = await install.run({ FAKE_DOCKER_FAIL: '^run --rm -v owlat_redis-data:/from' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('No volume data was changed');
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls.some((c) => isWipe(c) || isExtraction(c))).toBe(false);
		await expectOriginalData(install);
		// The half-made copies are cleaned up again.
		expect((await install.volumeNames()).filter((n) => n.includes('pre-restore'))).toEqual([]);
	});
});

describe('restore.sh never claims success after a failed restart', () => {
	it('reports the restored data but fails when docker compose up fails', async () => {
		const install = await makeInstall();
		const result = await install.run({ FAKE_DOCKER_FAIL: '^compose up' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('the stack failed to start');
		expect(result.out).not.toContain('Restore complete');
		expect(result.out).not.toContain('Stack started');
	});
});
