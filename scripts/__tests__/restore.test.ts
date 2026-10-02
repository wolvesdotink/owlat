/**
 * scripts/restore.sh must fail closed.
 *
 * It used to ignore a failing `docker compose down` and a failing volume
 * removal, went on to extract over whatever was there, and printed "Restore
 * complete." A corrupt inner volume.tar was only discovered after the live
 * volumes had already been wiped.
 *
 * These cases run the REAL script against a fake `docker` on PATH
 * (restore.testlib.ts), so a test can check the data a failure leaves behind,
 * not just the calls made.
 */

import { chmod, link, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	COMPOSE_WITHOUT_NAME,
	PROJECT,
	cleanupRoots,
	expectStartedOnRestoredData,
	isExtraction,
	isWipe,
	FIXED_STAMP,
	makeInstall,
	run,
	stubDate,
	tarOf,
	type Install,
} from './restore.testlib';

afterAll(cleanupRoots);

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
		] as const) {
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
			const files = await readdir(install.volumeDir(name));
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
		// The stack it started mounts exactly the volumes it restored.
		await expectStartedOnRestoredData(install, PROJECT);
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
	it('aborts when docker compose down fails and the stack is still running', async () => {
		const install = await makeInstall();
		const result = await install.run({
			FAKE_DOCKER_FAIL: '^compose down',
			FAKE_DOCKER_PS: '0123456789ab',
		});

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

describe('restore.sh on a fresh host (disaster recovery: no .env yet)', () => {
	it('restores the volumes and the .env using the archive env for Compose', async () => {
		const install = await makeInstall({}, { freshHost: true });
		const result = await install.run();

		expect(result.out).toContain('Restore complete.');
		expect(result.code).toBe(0);
		for (const [suffix, file, text] of [
			['convex-data', 'db.sqlite', 'new convex\n'],
			['redis-data', 'appendonly.aof', 'new redis\n'],
			['mail-certs', 'cert.pem', 'new cert\n'],
		] as const) {
			await expect(readFile(join(install.volume(suffix), file), 'utf8')).resolves.toBe(text);
		}
		// Volumes that are new on this host still carry the labels backup.sh finds them by.
		expect(result.calls).toContain(
			`volume create --label com.docker.compose.project=${PROJECT} --label com.docker.compose.volume=convex-data ${PROJECT}_convex-data`
		);
		const envPath = join(install.dir, '.env');
		await expect(readFile(envPath, 'utf8')).resolves.toBe('RESTORED=1\n');
		expect((await stat(envPath)).mode & 0o777).toBe(0o600);
		// Before the restored .env exists, Compose reads the archive's copy;
		// the final start uses the restored .env.
		expect(result.calls.some((c) => /^compose --env-file \S+\/env config$/.test(c))).toBe(true);
		expect(result.calls.some((c) => /^compose --env-file \S+\/env down$/.test(c))).toBe(true);
		expect(result.calls.at(-1)).toBe('compose up -d');
		await expectStartedOnRestoredData(install, PROJECT);
		// No pre-restore copies: there was nothing to keep.
		expect((await install.volumeNames()).filter((n) => n.includes('pre-restore'))).toEqual([]);
	});

	it('refuses, before touching anything, when Compose cannot read the archived env', async () => {
		// An older backup whose .env lacks a variable the compose file now
		// requires. Without Compose's answer the volumes `up` mounts are a
		// guess, so nothing may be replaced.
		const install = await makeInstall({}, { freshHost: true, composeFile: COMPOSE_WITHOUT_NAME });
		const result = await install.run({ FAKE_COMPOSE_REQUIRES: 'NEW_SECRET' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('required variable NEW_SECRET is missing a value');
		expect(result.out).toContain('nothing was changed');
		expect(result.out).toContain(`tar -xzOf ${install.archive} ./env > .env`);
		expect(result.out).toContain('with --keep-env');
		expect(result.calls.some((c) => c.endsWith(' down') || c.startsWith('run '))).toBe(false);
		expect(await install.volumeNames()).toEqual([]);
		expect(existsSync(join(install.dir, '.env'))).toBe(false);
	});

	it('restores once the archived env is completed and kept, as the refusal says', async () => {
		const install = await makeInstall({}, { freshHost: true, composeFile: COMPOSE_WITHOUT_NAME });
		const env = { FAKE_COMPOSE_REQUIRES: 'NEW_SECRET' };
		expect((await install.run(env)).code).not.toBe(0);

		const { stdout: archivedEnv } = await run('tar', ['-xzOf', install.archive, './env']);
		await writeFile(join(install.dir, '.env'), `${archivedEnv}NEW_SECRET=1\n`, { mode: 0o600 });
		const result = await install.run(env, ['--keep-env']);

		expect(result.out).toContain('Restore complete.');
		expect(result.code).toBe(0);
		// This clone lives in a directory called "install": that is the project.
		await expectStartedOnRestoredData(install, 'install');
		expect((await install.volumeNames()).some((n) => n.startsWith(`${PROJECT}_`))).toBe(false);
	});

	it('does not start a stack of its own when a fresh-host restore fails', async () => {
		const install = await makeInstall({}, { freshHost: true });
		const result = await install.run({
			FAKE_DOCKER_FAIL: `^run --rm -v ${PROJECT}_redis-data:/dst -v .* tar -xf`,
		});

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('no previous stack to restart');
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls.some((c) => c.includes(' up '))).toBe(false);
		// Every volume the restore created is gone again.
		expect(await install.volumeNames()).toEqual([]);
		expect(existsSync(join(install.dir, '.env'))).toBe(false);
	});

	it('refuses --keep-env when there is no .env to keep, before stopping anything', async () => {
		const install = await makeInstall({}, { freshHost: true });
		const result = await install.run({}, ['--keep-env']);

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('no .env here to keep');
		expect(result.calls).toEqual([]);
	});
});

describe('restore.sh rolls back when interrupted', () => {
	it.each(['SIGTERM', 'SIGINT'] as const)(
		'puts the previous data back and restarts the stack on %s mid-extraction',
		async (signal) => {
			const install = await makeInstall();
			// convex-data and mail-certs are already replaced when redis-data's
			// extraction is interrupted.
			const result = await install.interrupt(signal, {
				FAKE_DOCKER_HANG: `^run --rm -v ${PROJECT}_redis-data:/dst -v .* tar -xf`,
			});

			expect(result.code).not.toBe(0);
			expect(result.out).toContain('Restore interrupted.');
			expect(result.out).toContain('previous stack is running again');
			expect(result.out).not.toContain('Restore complete');
			await expectOriginalData(install);
			expect(result.calls.at(-1)).toBe('compose up -d');
		},
		30_000
	);

	it('drops the half-made copies when interrupted while keeping the current data', async () => {
		const install = await makeInstall();
		const result = await install.interrupt('SIGTERM', {
			FAKE_DOCKER_HANG: `^run --rm -v ${PROJECT}_redis-data:/from`,
		});

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('No volume data was changed');
		expect(result.calls.some((c) => isWipe(c) || isExtraction(c))).toBe(false);
		await expectOriginalData(install);
		expect((await install.volumeNames()).filter((n) => n.includes('pre-restore'))).toEqual([]);
	}, 30_000);
});

describe('restore.sh keeps deployment secrets owner-only', () => {
	it('tightens a world-readable .env and its pre-restore copy', async () => {
		const install = await makeInstall();
		const envPath = join(install.dir, '.env');
		await chmod(envPath, 0o644);
		const result = await install.run();

		expect(result.code).toBe(0);
		expect((await stat(envPath)).mode & 0o777).toBe(0o600);
		const copies = (await readdir(install.dir)).filter((f) => f.startsWith('.env.before-restore-'));
		expect(copies).toHaveLength(1);
		const copy = join(install.dir, copies[0]!);
		await expect(readFile(copy, 'utf8')).resolves.toBe('CURRENT=1\n');
		expect((await stat(copy)).mode & 0o777).toBe(0o600);
	});
});

describe('restore.sh never writes secrets into a file that is already there', () => {
	// A file already at the copy's name keeps its own mode while it is written
	// to. The copy has to be a new file, owner-only before the secrets go in.
	it('replaces a world-readable file at the pre-restore copy name instead of writing into it', async () => {
		const install = await makeInstall({}, { currentEnv: 'CURRENT_SECRET=1\n' });
		await stubDate(install);
		const copy = join(install.dir, `.env.before-restore-${FIXED_STAMP}`);
		await writeFile(copy, 'placeholder\n', { mode: 0o644 });
		await chmod(copy, 0o644);
		// Holds on to the file that was there, to see what was written into it.
		const earlier = join(install.root, 'earlier-copy');
		await link(copy, earlier);

		const result = await install.run();

		expect(result.code, result.out).toBe(0);
		await expect(readFile(earlier, 'utf8')).resolves.toBe('placeholder\n');
		await expect(readFile(copy, 'utf8')).resolves.toBe('CURRENT_SECRET=1\n');
		expect((await stat(copy)).mode & 0o777).toBe(0o600);
		// No temporary file is left next to it.
		const copies = (await readdir(install.dir)).filter((f) => f.startsWith('.env.before-restore-'));
		expect(copies).toEqual([`.env.before-restore-${FIXED_STAMP}`]);
	});
});

describe('restore.sh config-file failures', () => {
	it('stops with the next step when .env cannot be made owner-only', async () => {
		const install = await makeInstall();
		const bin = join(install.dir, '..', 'bin');
		await writeFile(join(bin, 'chmod'), '#!/usr/bin/env bash\necho "chmod: denied" >&2\nexit 1\n');
		await chmod(join(bin, 'chmod'), 0o755);
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('chmod 600 .env');
		expect(result.out).toContain('the stack is stopped');
		expect(result.out).toContain('docker compose up -d');
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls).not.toContain('compose up -d');
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
