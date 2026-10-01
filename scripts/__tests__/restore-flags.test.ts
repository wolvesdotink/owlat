/**
 * Backups carry .owlat-flags.json, the CLI's copy of the feature flags, and
 * restores put it back with the database and override it belongs to.
 *
 * backup.sh used to leave it out. A fresh-host restore then had no copy, so
 * `owlat doctor`, `feature` and `pack` fell back to the default flags, and the
 * next toggle rewrote the override from those defaults; a restore over an
 * existing install kept that install's unrelated copy. The round trip here
 * runs the real backup.sh, the real restore.sh and the real setup CLI toggle.
 */
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	FEATURE_FLAGS,
	getActiveProfiles,
	getRequiredEnvVars,
	resolveFlags,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { renderComposeOverrideYaml } from '@owlat/shared/composeOverride';
import { BACKUP, PROJECT, cleanupRoots, makeHost, makeInstall, run } from './restore.testlib';

afterAll(cleanupRoots);

const REPO = resolve(import.meta.dirname, '../..');
const MIRROR = '.owlat-flags.json';

/**
 * Non-default core flags (campaigns and file scanning off, URL scanning and
 * the inbox on) and an opaque plugin override, written the way every writer
 * writes the file.
 */
const SOURCE_FLAGS: FeatureFlagState = {
	campaigns: false,
	'scan.files': false,
	'scan.urls': true,
	inbox: true,
	'plugin.example-pack': false,
};
const SOURCE_PROFILES = getActiveProfiles(SOURCE_FLAGS);
const mirrorText = (flags: FeatureFlagState) => JSON.stringify(flags, null, 2);
/** The summary line a restore without the mirror ends with. */
const SYNC_STEP = "Rebuild the CLI's copy of the feature flags:  owlat feature --sync";

/** The profiles an override records under `x-owlat-profiles`. */
function overrideProfiles(text: string): string[] {
	const block = /^x-owlat-profiles:\n((?: {2}- .+\n)*)/m.exec(text)?.[1] ?? '';
	return block
		.split('\n')
		.filter(Boolean)
		.map((line) => line.replace(/^ {2}- /, ''));
}

/** Runs the real backup.sh on an install configured with SOURCE_FLAGS. */
async function backupOfSourceInstall(): Promise<string> {
	const source = await makeHost();
	await writeFile(
		join(source.dir, '.env'),
		`SOURCE=1\nCOMPOSE_PROFILES=${SOURCE_PROFILES.join(',')}\n`
	);
	await writeFile(
		join(source.dir, 'docker-compose.override.yml'),
		renderComposeOverrideYaml(SOURCE_PROFILES)
	);
	await writeFile(join(source.dir, MIRROR), mirrorText(SOURCE_FLAGS), { mode: 0o600 });
	for (const suffix of ['convex-data', 'redis-data']) {
		await mkdir(source.volumeDir(`${PROJECT}_${suffix}`), { recursive: true });
		await writeFile(join(source.volumeDir(`${PROJECT}_${suffix}`), 'data'), `${suffix}\n`);
	}
	const backups = join(source.root, 'backups');
	const result = await source.script(BACKUP, [backups], { FAKE_DOCKER_SERVICES: 'convex redis' });
	expect(result.code, result.out).toBe(0);
	expect(result.out).toContain('Captured .owlat-flags.json');
	const archive = (await readdir(backups)).find((name) => name.endsWith('.tar.gz'));
	if (!archive) throw new Error(`backup.sh wrote no archive:\n${result.out}`);
	// It embeds the whole .env.
	expect((await stat(join(backups, archive))).mode & 0o777).toBe(0o600);
	return join(backups, archive);
}

describe('backup.sh → restore.sh carries the CLI feature flags', () => {
	it('lists the mirror in the manifest and ships it in the archive', async () => {
		const archive = await backupOfSourceInstall();
		const { stdout: members } = await run('tar', ['-tzf', archive]);
		expect(members.split('\n')).toContain('./owlat-flags.json');
		const { stdout: manifest } = await run('tar', ['-xzOf', archive, './MANIFEST.txt']);
		expect(manifest).toContain('owlat-flags.json');
	});

	it('restores it on a fresh host, so doctor and a later toggle see the backed-up flags', async () => {
		const install = await makeInstall(
			{},
			{ freshHost: true, archive: await backupOfSourceInstall() }
		);
		const result = await install.run();

		expect(result.out).toContain('Restore complete.');
		expect(result.code).toBe(0);
		expect(result.out).toContain(`Restored ${MIRROR}`);
		const mirrorPath = join(install.dir, MIRROR);
		const restored = JSON.parse(await readFile(mirrorPath, 'utf8')) as FeatureFlagState;
		expect(restored).toEqual(SOURCE_FLAGS);
		expect((await stat(mirrorPath)).mode & 0o777).toBe(0o600);

		// doctor resolves the mirror: the same flags and required env as the source.
		expect(resolveFlags(restored)).toEqual(resolveFlags(SOURCE_FLAGS));
		expect(resolveFlags(restored)['campaigns.archive']).toBe(false);
		expect(getRequiredEnvVars(restored)).toContain('GOOGLE_SAFE_BROWSING_API_KEY');
		// The restored override records the profiles the restored mirror derives.
		const override = await readFile(join(install.dir, 'docker-compose.override.yml'), 'utf8');
		expect(overrideProfiles(override)).toEqual(getActiveProfiles(restored));

		// An unrelated toggle through the real CLI keeps every restored choice.
		await run('bun', [join(REPO, 'apps/setup-cli/src/index.ts'), 'feature', 'webhooks', 'on'], {
			cwd: install.dir,
			env: { ...process.env, OWLAT_DIR: install.dir },
		});
		const toggled = JSON.parse(await readFile(mirrorPath, 'utf8')) as FeatureFlagState;
		expect(toggled).toEqual({ ...SOURCE_FLAGS, webhooks: true });
		const rewritten = await readFile(join(install.dir, 'docker-compose.override.yml'), 'utf8');
		expect(overrideProfiles(rewritten)).toEqual(SOURCE_PROFILES);
		expect(overrideProfiles(rewritten)).not.toContain('clamav');
	}, 30_000);
});

describe('restore.sh over an existing install', () => {
	const CURRENT_FLAGS = mirrorText({ campaigns: true, automations: true });

	it('replaces a conflicting mirror and keeps the previous one aside', async () => {
		const install = await makeInstall(
			{},
			{ currentFlags: CURRENT_FLAGS, archivedFlags: mirrorText(SOURCE_FLAGS) }
		);
		const result = await install.run();

		expect(result.code).toBe(0);
		await expect(readFile(join(install.dir, MIRROR), 'utf8')).resolves.toBe(
			mirrorText(SOURCE_FLAGS)
		);
		expect(result.out).not.toContain(SYNC_STEP);
		const kept = (await readdir(install.dir)).filter((n) =>
			n.startsWith(`${MIRROR}.before-restore-`)
		);
		expect(kept).toHaveLength(1);
		await expect(readFile(join(install.dir, kept[0] ?? ''), 'utf8')).resolves.toBe(CURRENT_FLAGS);
	});

	it('restores the mirror with --keep-env too: it belongs to the restored database', async () => {
		const install = await makeInstall(
			{},
			{ currentFlags: CURRENT_FLAGS, archivedFlags: mirrorText(SOURCE_FLAGS) }
		);
		const result = await install.run({}, ['--keep-env']);

		expect(result.code).toBe(0);
		await expect(readFile(join(install.dir, '.env'), 'utf8')).resolves.toBe('CURRENT=1\n');
		await expect(readFile(join(install.dir, MIRROR), 'utf8')).resolves.toBe(
			mirrorText(SOURCE_FLAGS)
		);
	});

	it('leaves the current mirror alone when the volumes are rolled back', async () => {
		const install = await makeInstall(
			{},
			{ currentFlags: CURRENT_FLAGS, archivedFlags: mirrorText(SOURCE_FLAGS) }
		);
		const result = await install.run({
			FAKE_DOCKER_FAIL_AFTER: `^run --rm -v ${PROJECT}_redis-data:/dst -v .* tar -xf`,
		});

		expect(result.code).not.toBe(0);
		expect(result.out).toContain('previous stack is running again');
		await expect(readFile(join(install.dir, MIRROR), 'utf8')).resolves.toBe(CURRENT_FLAGS);
	});

	it('moves an unrelated mirror aside and warns when the archive predates the mirror', async () => {
		const install = await makeInstall({}, { currentFlags: CURRENT_FLAGS });
		const result = await install.run();

		expect(result.code).toBe(0);
		expect(result.out).toContain(`The archive has no ${MIRROR}`);
		expect(result.out).toContain('assume the default feature flags');
		// The warning and the summary name the step that rebuilds the file.
		expect(result.out).toContain("run 'owlat feature --sync'");
		expect(result.out).toContain(SYNC_STEP);
		const names = await readdir(install.dir);
		expect(names).not.toContain(MIRROR);
		const kept = names.filter((n) => n.startsWith(`${MIRROR}.before-restore-`));
		await expect(readFile(join(install.dir, kept[0] ?? ''), 'utf8')).resolves.toBe(CURRENT_FLAGS);
	});

	it('warns on a fresh host when the archive predates the mirror', async () => {
		const install = await makeInstall({}, { freshHost: true });
		const result = await install.run();

		expect(result.code).toBe(0);
		expect(result.out).toContain(`The archive has no ${MIRROR}`);
		expect(result.out).toContain(SYNC_STEP);
		expect(await readdir(install.dir)).not.toContain(MIRROR);
	});
});

describe('every writer of the mirror writes the file backup.sh captures', () => {
	it.each([
		['the setup CLI', 'apps/setup-cli/src/lib/flagState.ts'],
		['the web setup wizard', 'apps/web/server/api/setup/apply.post.ts'],
		['the updater Apply', 'apps/updater/src/applyProfiles.ts'],
	])('%s writes .owlat-flags.json in the install directory', async (_label, path) => {
		expect(await readFile(join(REPO, path), 'utf8')).toContain(`'${MIRROR}'`);
	});

	it('the registry still has the flags these cases rely on', () => {
		for (const key of [
			'campaigns',
			'campaigns.archive',
			'scan.files',
			'scan.urls',
			'inbox',
			'webhooks',
		]) {
			expect(FEATURE_FLAGS).toHaveProperty([key]);
		}
		expect(SOURCE_PROFILES).toContain('mta');
		expect(SOURCE_PROFILES).not.toContain('clamav');
	});
});
