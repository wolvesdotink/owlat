/**
 * scripts/restore.sh must put each payload into the volume the restored stack
 * mounts for it, also when that volume has an explicit `name:`.
 *
 * backup.sh names a payload after its volume minus the source project's
 * "<project>_" prefix, explicit names included, so an explicit
 * `owlat_database` became the payload `database`. The restore matched that
 * against neither a compose key nor a volume name, fell back to
 * "<project>_database", and its final check reused the same mapping: it exited
 * 0 with the database in a volume the started stack never mounted. backup.sh
 * now records each payload's compose key and volume in VOLUMES.txt; archives
 * from before are matched by every reading of the payload name and refused
 * when the readings disagree or leave a mounted volume without its data.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	BACKUP,
	PROJECT,
	cleanupRoots,
	expectStartedOnRestoredData,
	makeHost,
	makeInstall,
	run,
	type Install,
} from './restore.testlib';

afterAll(cleanupRoots);

const EXPLICIT_OVERRIDE = `volumes:\n  convex-data:\n    name: ${PROJECT}_database\n`;
const TARGET_ENV = 'CURRENT=1\nCOMPOSE_PROJECT_NAME=target\n';

/**
 * Runs the real backup.sh on an install of project `owlat` whose convex-data
 * volume is explicitly named `owlat_database`.
 */
async function backupWithExplicitName(): Promise<string> {
	const source = await makeHost();
	await writeFile(join(source.dir, '.env'), `SOURCE=1\nCOMPOSE_PROJECT_NAME=${PROJECT}\n`);
	await writeFile(join(source.dir, 'docker-compose.override.yml'), EXPLICIT_OVERRIDE);
	const data = {
		'convex-data': [`${PROJECT}_database`, 'db.sqlite', 'new convex\n'],
		'redis-data': [`${PROJECT}_redis-data`, 'appendonly.aof', 'new redis\n'],
		'mail-certs': [`${PROJECT}_mail-certs`, 'cert.pem', 'new cert\n'],
	} as const;
	for (const [key, [name, file, text]] of Object.entries(data)) {
		await writeFile(join(await source.composeVolume(name, key, PROJECT), file), text);
	}
	const backups = join(source.root, 'backups');
	const result = await source.script(BACKUP, [backups]);
	expect(result.code, result.out).toBe(0);
	const archive = (await readdir(backups)).find((name) => name.endsWith('.tar.gz'));
	if (!archive) throw new Error(`backup.sh wrote no archive:\n${result.out}`);
	return join(backups, archive);
}

/** The archive without VOLUMES.txt, as backup.sh wrote it before. */
async function withoutVolumeList(archive: string): Promise<string> {
	const staging = `${archive}.legacy`;
	await mkdir(staging);
	await run('tar', ['-xzf', archive, '-C', staging]);
	await rm(join(staging, 'VOLUMES.txt'));
	const manifest = join(staging, 'MANIFEST.txt');
	await writeFile(
		manifest,
		(await readFile(manifest, 'utf8')).replace(/^ {2}VOLUMES\.txt .*\n/m, '')
	);
	const legacy = archive.replace(/\.tar\.gz$/, '-legacy.tar.gz');
	await run('tar', ['-czf', legacy, '-C', staging, '.']);
	const sha = createHash('sha256')
		.update(await readFile(legacy))
		.digest('hex');
	await writeFile(`${legacy}.sha256`, `${sha}\n`);
	return legacy;
}

const TARGET_NAMES = {
	'convex-data': `${PROJECT}_database`,
	'redis-data': 'target_redis-data',
	'mail-certs': 'target_mail-certs',
};

/** Refused before `down`: nothing stopped, nothing written. */
async function expectNothingChanged(install: Install, out: string) {
	expect(out).toMatch(/nothing was changed|refusing to touch the running stack/);
	expect(out).not.toContain('Restore complete');
	const calls = await install.calls();
	expect(calls.some((c) => c.endsWith(' down') || c.startsWith('run '))).toBe(false);
	expect(calls.some((c) => c.startsWith('volume create'))).toBe(false);
}

describe('backup.sh → restore.sh with an explicitly named volume', () => {
	it('records the compose key and volume of every payload', async () => {
		const archive = await backupWithExplicitName();
		const { stdout } = await run('tar', ['-xzOf', archive, './VOLUMES.txt']);
		expect(stdout.split('\n').filter(Boolean).sort()).toEqual([
			`database convex-data ${PROJECT}_database`,
			`mail-certs mail-certs ${PROJECT}_mail-certs`,
			`redis-data redis-data ${PROJECT}_redis-data`,
		]);
	});

	it('restores a project-prefixed explicit name into the volume the started stack mounts, across projects', async () => {
		const install = await makeInstall(
			{},
			{ currentEnv: TARGET_ENV, archive: await backupWithExplicitName() }
		);
		const result = await install.run({}, ['--keep-env']);

		expect(result.out).toContain('Restore complete.');
		expect(result.code).toBe(0);
		await expectStartedOnRestoredData(install, 'target', TARGET_NAMES);
		expect(existsSync(install.volumeDir('target_database'))).toBe(false);
	});

	it('restores an archive from before VOLUMES.txt the same way', async () => {
		const install = await makeInstall(
			{},
			{ currentEnv: TARGET_ENV, archive: await withoutVolumeList(await backupWithExplicitName()) }
		);
		const result = await install.run({}, ['--keep-env']);

		expect(result.code, result.out).toBe(0);
		await expectStartedOnRestoredData(install, 'target', TARGET_NAMES);
		expect(existsSync(install.volumeDir('target_database'))).toBe(false);
	});

	it.each([
		['an archive from before VOLUMES.txt', true],
		['an archive with VOLUMES.txt', false],
	])(
		'refuses %s before stopping anything when the planning read of the restored configuration fails',
		async (_label, legacy) => {
			const archive = await backupWithExplicitName();
			const install = await makeInstall(
				{},
				{ currentEnv: TARGET_ENV, archive: legacy ? await withoutVolumeList(archive) : archive }
			);
			// Only the read with the archived files handed over (-f) fails, once;
			// every later Compose call, including the final check, would work.
			const result = await install.run(
				{ FAKE_DOCKER_FAIL: '^compose .* -f .*config$', FAKE_DOCKER_FAIL_ONCE: '1' },
				['--keep-env']
			);

			expect(result.code).not.toBe(0);
			expect(result.out).toContain('cannot tell which volumes docker compose up mounts');
			await expectNothingChanged(install, result.out);
			expect(await install.ups()).toEqual([]);
			expect(existsSync(install.volumeDir('target_database'))).toBe(false);
			expect(existsSync(install.volumeDir(`${PROJECT}_database`))).toBe(false);
		}
	);

	it('refuses to back up two volumes that would share a payload name', async () => {
		const source = await makeHost();
		await writeFile(join(source.dir, '.env'), 'SOURCE=1\n');
		await source.composeVolume(`${PROJECT}_database`, 'convex-data', PROJECT);
		await source.composeVolume('database', 'archive-db', PROJECT);
		const backups = join(source.root, 'backups');
		const result = await source.script(BACKUP, [backups]);

		expect(result.code).not.toBe(0);
		expect(result.out).toContain("would share the payload name 'database'");
		expect(existsSync(backups) ? await readdir(backups) : []).toEqual([]);
	});
});

describe('restore.sh refuses a payload it cannot place, before stopping anything', () => {
	it('refuses an old archive whose unmatched payload could be a mounted volume left without data', async () => {
		const install = await makeInstall(
			{ index: { files: { 'segment.bin': 'index\n' } } },
			{ archivedOverride: 'volumes:\n  search-index:\n    name: elsewhere_index\n' }
		);
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(
			'payload index matches no volume the restored configuration mounts, while elsewhere_index would get no payload'
		);
		await expectNothingChanged(install, result.out);
	});

	it('refuses an old archive whose payload name fits several mounted volumes', async () => {
		const install = await makeInstall(
			{ database: { files: { 'db.sqlite': 'which\n' } } },
			{
				archivedOverride: `volumes:\n  database:\n    name: other-db\n  search-index:\n    name: ${PROJECT}_database\n`,
			}
		);
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(
			`payload database could belong to any of other-db,${PROJECT}_database`
		);
		await expectNothingChanged(install, result.out);
	});

	it('refuses a VOLUMES.txt that does not cover every payload', async () => {
		const install = await makeInstall(
			{},
			{ volumeList: `convex-data convex-data ${PROJECT}_convex-data\n` }
		);
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('VOLUMES.txt does not record the volume of payload mail-certs');
		await expectNothingChanged(install, result.out);
	});

	it('refuses to put a payload no service mounts into a volume mounted under another key', async () => {
		const install = await makeInstall(
			{ old: { files: { 'x.bin': 'old\n' } } },
			{
				archivedOverride: `volumes:\n  redis-data:\n    name: ${PROJECT}_old-data\n`,
				volumeList: [
					`convex-data convex-data ${PROJECT}_convex-data`,
					`redis-data redis-data ${PROJECT}_redis-data`,
					`mail-certs mail-certs ${PROJECT}_mail-certs`,
					`old old-data ${PROJECT}_old-data`,
				].join('\n'),
			}
		);
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(
			`Payload old would go into ${PROJECT}_old-data, which the restored configuration mounts as another volume`
		);
		await expectNothingChanged(install, result.out);
	});

	it('restores a recorded volume no service mounts under its explicit name, and says so', async () => {
		const install = await makeInstall(
			{ search: { files: { 'segment.bin': 'search\n' } } },
			{
				volumeList: [
					`convex-data convex-data ${PROJECT}_convex-data`,
					`redis-data redis-data ${PROJECT}_redis-data`,
					`mail-certs mail-certs ${PROJECT}_mail-certs`,
					'search search-index owlat-search',
				].join('\n'),
			}
		);
		const result = await install.run();

		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain(
			'No service the restored configuration starts mounts the volume of payload search; restoring it into owlat-search.'
		);
		await expectStartedOnRestoredData(install, PROJECT);
		await expect(
			readFile(join(install.volumeDir('owlat-search'), 'segment.bin'), 'utf8')
		).resolves.toBe('search\n');
	});
});

describe('restore.sh checks the volumes Compose mounts before starting', () => {
	it('does not start a stack whose config mounts another volume for a restored key', async () => {
		const install = await makeInstall();
		const result = await install.run({ FAKE_COMPOSE_DISCOVERED_VOLUME: 'convex-data=elsewhere' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(
			`The restored config files start project '${PROJECT}' with the volumes elsewhere ${PROJECT}_redis-data ${PROJECT}_mail-certs`
		);
		expect(result.calls).not.toContain('compose up -d');
	});
});
