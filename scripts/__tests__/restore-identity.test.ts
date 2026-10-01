/**
 * scripts/restore.sh must restore the volumes into the Compose project the
 * RESTORED configuration starts.
 *
 * It used to resolve the project from the configuration in place before the
 * restore, replace that project's volumes, then install the archived .env and
 * override and start whatever project those named. When the two differed it
 * exited 0 with the restored database in volumes the started stack never
 * mounted. Every case here checks which project `docker compose up` started
 * and that its volumes hold the archive's data.
 */
import { readFile, writeFile } from 'node:fs/promises';
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
	makeInstall,
	type Install,
} from './restore.testlib';

afterAll(cleanupRoots);

const ARCHIVED_PROJECT = 'archive-source';
const ARCHIVED_ENV = `RESTORED=1\nCOMPOSE_PROJECT_NAME=${ARCHIVED_PROJECT}\n`;

/** The install's own volumes still hold what they held before the restore. */
async function expectCurrentVolumesUntouched(install: Install) {
	for (const suffix of ['convex-data', 'redis-data']) {
		await expect(readFile(join(install.volume(suffix), 'old.txt'), 'utf8')).resolves.toBe(
			`old ${suffix}\n`
		);
	}
	expect(existsSync(join(install.volume('convex-data'), 'db.sqlite'))).toBe(false);
	expect(existsSync(install.volume('mail-certs'))).toBe(false);
}

/** Refused before `down`: nothing stopped, nothing written. */
async function expectNothingChanged(install: Install, out: string) {
	expect(out).toContain('nothing was changed');
	expect(out).not.toContain('Restore complete');
	expect((await install.calls()).some((c) => / down$/.test(c))).toBe(false);
	expect((await install.calls()).some((c) => c.startsWith('run '))).toBe(false);
	await expectCurrentVolumesUntouched(install);
	await expect(readFile(join(install.dir, '.env'), 'utf8')).resolves.toBe('CURRENT=1\n');
}

describe('restore.sh restores into the project the restored configuration starts', () => {
	it('follows a COMPOSE_PROJECT_NAME in the archived .env that differs from the current one', async () => {
		const install = await makeInstall({}, { archivedEnv: ARCHIVED_ENV });
		const result = await install.run();

		expect(result.out).toContain('Restore complete.');
		expect(result.code).toBe(0);
		expect(result.out).toContain(
			`This install runs as project '${PROJECT}', but the restored configuration starts project '${ARCHIVED_PROJECT}'`
		);
		// The current stack is what `down` stops; the restored one is what `up` starts.
		expect(result.calls).toContain('compose down');
		await expect(readFile(join(install.root, 'down.log'), 'utf8')).resolves.toMatch(
			new RegExp(`^${PROJECT} `)
		);
		await expectStartedOnRestoredData(install, ARCHIVED_PROJECT);
		expect(result.calls).toContain(
			`volume create --label com.docker.compose.project=${ARCHIVED_PROJECT} --label com.docker.compose.volume=convex-data ${ARCHIVED_PROJECT}_convex-data`
		);
		// The replaced install's volumes are left as they were.
		await expectCurrentVolumesUntouched(install);
		await expect(readFile(join(install.dir, '.env'), 'utf8')).resolves.toBe(ARCHIVED_ENV);
	});

	it('follows a top-level name: in the archived override', async () => {
		const install = await makeInstall(
			{},
			{ composeFile: COMPOSE_WITHOUT_NAME, archivedOverride: 'name: from-override\n' }
		);
		const result = await install.run();

		expect(result.code).toBe(0);
		await expectStartedOnRestoredData(install, 'from-override');
		// This install derived its project from the directory name.
		expect(existsSync(install.volumeDir('install_convex-data'))).toBe(false);
	});

	it('restores into the explicitly named volume the archived override declares', async () => {
		const install = await makeInstall(
			{},
			{ archivedOverride: 'volumes:\n  convex-data:\n    name: owlat-database\n' }
		);
		const result = await install.run();

		expect(result.code).toBe(0);
		await expectStartedOnRestoredData(install, PROJECT, {
			'convex-data': 'owlat-database',
			'redis-data': `${PROJECT}_redis-data`,
			'mail-certs': `${PROJECT}_mail-certs`,
		});
		expect(result.calls).toContain(
			`volume create --label com.docker.compose.project=${PROJECT} --label com.docker.compose.volume=convex-data owlat-database`
		);
		// The default-named volume the override no longer mounts keeps its data.
		await expect(readFile(join(install.volume('convex-data'), 'old.txt'), 'utf8')).resolves.toBe(
			'old convex-data\n'
		);
	});

	it('keeps the current project with --keep-env, whatever the archived .env names', async () => {
		const install = await makeInstall({}, { archivedEnv: ARCHIVED_ENV });
		const result = await install.run({}, ['--keep-env']);

		expect(result.code).toBe(0);
		await expectStartedOnRestoredData(install, PROJECT);
		expect(existsSync(install.volumeDir(`${ARCHIVED_PROJECT}_convex-data`))).toBe(false);
		await expect(readFile(join(install.dir, '.env'), 'utf8')).resolves.toBe('CURRENT=1\n');
	});

	it('lets COMPOSE_PROJECT_NAME from the shell win over both .env files, as Compose does', async () => {
		const install = await makeInstall({}, { archivedEnv: ARCHIVED_ENV });
		const result = await install.run({ COMPOSE_PROJECT_NAME: 'from-shell' });

		expect(result.code).toBe(0);
		await expectStartedOnRestoredData(install, 'from-shell');
		expect(existsSync(install.volumeDir(`${ARCHIVED_PROJECT}_convex-data`))).toBe(false);
	});

	it('follows the archived .env on a fresh host', async () => {
		const install = await makeInstall({}, { freshHost: true, archivedEnv: ARCHIVED_ENV });
		const result = await install.run();

		expect(result.code).toBe(0);
		await expectStartedOnRestoredData(install, ARCHIVED_PROJECT);
		expect((await install.volumeNames()).some((n) => n.startsWith(`${PROJECT}_`))).toBe(false);
	});

	it('works out the archived project from the files when Compose cannot read them', async () => {
		const install = await makeInstall(
			{},
			{ composeFile: COMPOSE_WITHOUT_NAME, archivedOverride: 'name: from-override\n' }
		);
		const result = await install.run({ FAKE_DOCKER_FAIL: '^compose (\\S+ )*config$' });

		expect(result.code).toBe(0);
		expect(result.out).toContain("using 'from-override', the name docker compose up derives here");
		await expectStartedOnRestoredData(install, 'from-override');
	});
});

describe('restore.sh rolls back to the current project', () => {
	it('removes the restored project’s new volumes and restarts the previous stack on its own data', async () => {
		const install = await makeInstall({}, { archivedEnv: ARCHIVED_ENV });
		const result = await install.run({
			FAKE_DOCKER_FAIL_AFTER: `^run --rm -v ${ARCHIVED_PROJECT}_redis-data:/dst -v .* tar -xf`,
		});

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('previous stack is running again');
		expect(result.out).not.toContain('Restore complete');
		// Every volume of the restored project was created by this restore: gone again.
		expect((await install.volumeNames()).some((n) => n.startsWith(`${ARCHIVED_PROJECT}_`))).toBe(
			false
		);
		await expectCurrentVolumesUntouched(install);
		await expect(readFile(join(install.dir, '.env'), 'utf8')).resolves.toBe('CURRENT=1\n');
		const up = (await install.ups()).at(-1);
		expect(up?.project).toBe(PROJECT);
	});
});

describe('restore.sh refuses a mapping it cannot vouch for, before stopping anything', () => {
	it('refuses while containers of the restored project are running', async () => {
		const install = await makeInstall({}, { archivedEnv: ARCHIVED_ENV });
		const result = await install.run({
			FAKE_DOCKER_PS: '0123456789ab',
			FAKE_DOCKER_PS_FILTER: `project=${ARCHIVED_PROJECT}$`,
		});

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(`Containers of project '${ARCHIVED_PROJECT}' are still running`);
		expect(result.calls.some((c) => c.startsWith('run ') || c.startsWith('volume create'))).toBe(
			false
		);
		await expectCurrentVolumesUntouched(install);
	});

	it('refuses when COMPOSE_FILE picks the compose files', async () => {
		const install = await makeInstall();
		const result = await install.run({ COMPOSE_FILE: 'docker-compose.yml:extra.yml' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('COMPOSE_FILE is set');
		expect(result.calls).toEqual([]);
		await expectNothingChanged(install, result.out);
	});

	it('refuses when the archived .env sets COMPOSE_FILE', async () => {
		const install = await makeInstall({}, { archivedEnv: 'RESTORED=1\nCOMPOSE_FILE=other.yml\n' });
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('COMPOSE_FILE is set');
		await expectNothingChanged(install, result.out);
	});

	it('refuses when a compose.yaml would replace docker-compose.yml', async () => {
		const install = await makeInstall();
		await writeFile(join(install.dir, 'compose.yaml'), 'services: {}\n');
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('compose.yaml is present');
		await expectNothingChanged(install, result.out);
	});

	it('refuses an interpolated project name Compose could not resolve', async () => {
		const install = await makeInstall(
			{},
			{ composeFile: COMPOSE_WITHOUT_NAME, archivedOverride: 'name: ${OWLAT_PROJECT}\n' }
		);
		const result = await install.run({ FAKE_DOCKER_FAIL: '^compose (\\S+ )*config$' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('interpolated project name');
		await expectNothingChanged(install, result.out);
	});

	it('refuses when two payloads map to the same volume', async () => {
		const install = await makeInstall(
			{},
			{ archivedOverride: `volumes:\n  redis-data:\n    name: ${PROJECT}_convex-data\n` }
		);
		const result = await install.run();

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(`map to the same volume (${PROJECT}_convex-data)`);
		await expectNothingChanged(install, result.out);
	});
});

describe('restore.sh checks the installed config files before starting', () => {
	it('does not start a stack that would not mount the restored volumes', async () => {
		const install = await makeInstall();
		// Compose resolves the files it finds itself differently from the ones
		// the restore handed it: a divergence nothing up front could foresee.
		const result = await install.run({ FAKE_COMPOSE_DISCOVERED_NAME: 'elsewhere' });

		expect(result.code).not.toBe(0);
		expect(result.out).toContain(
			"The restored config files start project 'elsewhere', which does not mount the restored volumes"
		);
		expect(result.out).toContain('the stack is stopped');
		expect(result.out).not.toContain('Restore complete');
		expect(result.calls).not.toContain('compose up -d');
		expect(result.calls.some((c) => isWipe(c) || isExtraction(c))).toBe(true);
	});
});
