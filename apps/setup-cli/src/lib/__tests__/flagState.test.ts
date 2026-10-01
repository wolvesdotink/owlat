import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAndPersist, applyPackAndPersist, saveFlagState } from '../flagState';

const roots: string[] = [];

beforeEach(() => {
	vi.stubGlobal('Bun', {
		file: (path: string) => ({
			exists: async () =>
				stat(path)
					.then(() => true)
					.catch(() => false),
			text: async () => readFile(path, 'utf8'),
		}),
	});
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryOwlatDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-flags-'));
	roots.push(root);
	return root;
}

describe('setup CLI flag persistence', () => {
	it('preserves plugin overrides while toggling a core flag', async () => {
		const root = await temporaryOwlatDirectory();
		await saveFlagState(root, { ai: true, 'plugin.policy-pack': false });

		const result = await applyAndPersist(root, 'ai', false);

		expect(result.state['plugin.policy-pack']).toBe(false);
		expect(JSON.parse(await readFile(join(root, '.owlat-flags.json'), 'utf8'))).toMatchObject({
			ai: false,
			'plugin.policy-pack': false,
		});
	});

	it('preserves plugin overrides while toggling a feature pack', async () => {
		const root = await temporaryOwlatDirectory();
		await saveFlagState(root, { inbox: false, 'plugin.policy-pack': true });

		const result = await applyPackAndPersist(root, 'emailClient', true);

		expect(result.state['plugin.policy-pack']).toBe(true);
	});
});

describe.skipIf(process.platform === 'win32')('setup CLI flag file mode', () => {
	// The web setup wizard and the updater create the file owner-only; `owlat
	// feature` and `owlat pack` must agree with them.
	it('creates .owlat-flags.json owner-only on a flag toggle', async () => {
		const root = await temporaryOwlatDirectory();

		await applyAndPersist(root, 'ai', false);

		expect((await stat(join(root, '.owlat-flags.json'))).mode & 0o777).toBe(0o600);
	});

	it('creates .owlat-flags.json owner-only on a pack toggle', async () => {
		const root = await temporaryOwlatDirectory();

		await applyPackAndPersist(root, 'emailClient', true);

		expect((await stat(join(root, '.owlat-flags.json'))).mode & 0o777).toBe(0o600);
	});
});

describe('setup CLI flag toggles keep .env COMPOSE_PROFILES in step with the override', () => {
	it('drops a disabled profile from .env and keeps install-owned ones and every other line', async () => {
		const root = await temporaryOwlatDirectory();
		await writeFile(
			join(root, '.env'),
			'# operator note\nSITE_URL=https://owlat.example.com\nCOMPOSE_PROFILES=clamav,tls\n'
		);

		const result = await applyAndPersist(root, 'scan.files', false);

		expect(result.profiles).not.toContain('clamav');
		expect(result.profiles).toContain('tls');
		const env = await readFile(join(root, '.env'), 'utf8');
		expect(env).toContain('# operator note\nSITE_URL=https://owlat.example.com\n');
		expect(env).toContain(`COMPOSE_PROFILES=${result.profiles.join(',')}\n`);
		expect(env).not.toMatch(/COMPOSE_PROFILES=.*clamav/);
		const override = await readFile(join(root, 'docker-compose.override.yml'), 'utf8');
		expect(override).not.toContain('- clamav');
	});

	it('adds an enabled profile, appending the line when .env had none', async () => {
		const root = await temporaryOwlatDirectory();
		await writeFile(join(root, '.env'), 'SITE_URL=https://owlat.example.com');

		const result = await applyAndPersist(root, 'scan.files', true);

		expect(result.profiles).toContain('clamav');
		expect(await readFile(join(root, '.env'), 'utf8')).toBe(
			`SITE_URL=https://owlat.example.com\nCOMPOSE_PROFILES=${result.profiles.join(',')}\n`
		);
	});

	it.skipIf(process.platform === 'win32')(
		'makes a world-readable .env owner-only when it rewrites it',
		async () => {
			const root = await temporaryOwlatDirectory();
			await writeFile(join(root, '.env'), 'INSTANCE_SECRET=abc\nCOMPOSE_PROFILES=clamav\n');
			await chmod(join(root, '.env'), 0o644);

			await applyAndPersist(root, 'scan.files', false);

			expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
		}
	);

	it('does not create a .env for a directory that has none', async () => {
		const root = await temporaryOwlatDirectory();

		await applyAndPersist(root, 'scan.files', true);

		await expect(stat(join(root, '.env'))).rejects.toThrow();
	});
});
