import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomically } from '../atomicWrite';
import { generatePluginComposition } from '../generate';

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '../cli.ts');

async function createZeroPluginWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-plugin-generate-'));
	temporaryRoots.push(root);
	await mkdir(join(root, 'packages', 'plugin-codegen'), { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
	await writeFile(
		join(root, 'plugins.config.ts'),
		'export default { bundledPluginPackages: [] };\n'
	);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('generated composition freshness', () => {
	it('resolves encoded file URLs without treating URL paths as filesystem paths', () => {
		const testPath = join(tmpdir(), 'plugin codegen', 'generate.test.ts');
		expect(fileURLToPath(pathToFileURL(testPath))).toBe(testPath);
	});

	it('writes both targets and accepts them in non-writing check mode', async () => {
		const root = await createZeroPluginWorkspace();

		await generatePluginComposition(root);
		const convexPath = join(root, 'apps/api/convex/plugins/plugins.generated.ts');
		const nuxtPath = join(root, 'apps/web/app/plugins/plugin-composition.generated.ts');
		expect(await readFile(convexPath, 'utf8')).toContain('composeBundledPlugins([]);');
		expect(await readFile(nuxtPath, 'utf8')).toContain('defineNuxtPlugin');
		await expect(generatePluginComposition(root, { check: true })).resolves.toBeUndefined();
	});

	it('reports every stale or missing generated target without rewriting it', async () => {
		const root = await createZeroPluginWorkspace();
		const convexPath = join(root, 'apps/api/convex/plugins/plugins.generated.ts');
		await mkdir(join(root, 'apps/api/convex/plugins'), { recursive: true });
		await writeFile(convexPath, '// stale and must remain unchanged\n');

		await expect(generatePluginComposition(root, { check: true })).rejects.toMatchObject({
			code: 'generated_files_stale',
			details: [
				'apps/api/convex/plugins/plugins.generated.ts',
				'apps/web/app/plugins/plugin-composition.generated.ts',
			],
		});
		expect(await readFile(convexPath, 'utf8')).toBe('// stale and must remain unchanged\n');
	});

	it('supports concurrent generation in one process without temporary-file collisions', async () => {
		const root = await createZeroPluginWorkspace();

		await Promise.all(Array.from({ length: 20 }, () => generatePluginComposition(root)));

		await expect(generatePluginComposition(root, { check: true })).resolves.toBeUndefined();
	});

	it('supports concurrent generation in separate Bun processes', async () => {
		const root = await createZeroPluginWorkspace();

		await Promise.all(
			Array.from({ length: 4 }, () => execFileAsync('bun', [cliPath], { cwd: root }))
		);

		await expect(generatePluginComposition(root, { check: true })).resolves.toBeUndefined();
	});

	it('ignores a planted legacy temporary symlink and never overwrites its victim', async () => {
		const root = await createZeroPluginWorkspace();
		const convexPath = join(root, 'apps/api/convex/plugins/plugins.generated.ts');
		const victimPath = join(root, 'victim.txt');
		await mkdir(dirname(convexPath), { recursive: true });
		await writeFile(victimPath, 'unchanged\n');
		await symlink(victimPath, `${convexPath}.${process.pid}.tmp`);

		await generatePluginComposition(root);

		expect(await readFile(victimPath, 'utf8')).toBe('unchanged\n');
		await expect(generatePluginComposition(root, { check: true })).resolves.toBeUndefined();
	});

	it('rejects generated targets and parents that are symbolic links', async () => {
		const targetRoot = await createZeroPluginWorkspace();
		const targetVictim = join(targetRoot, 'target-victim.ts');
		const convexTarget = join(targetRoot, 'apps/api/convex/plugins/plugins.generated.ts');
		await mkdir(dirname(convexTarget), { recursive: true });
		await writeFile(targetVictim, '// victim\n');
		await symlink(targetVictim, convexTarget);
		await expect(generatePluginComposition(targetRoot)).rejects.toMatchObject({
			code: 'generated_path_unsafe',
		});
		expect(await readFile(targetVictim, 'utf8')).toBe('// victim\n');

		const parentRoot = await createZeroPluginWorkspace();
		const outsideParent = await mkdtemp(join(tmpdir(), 'owlat-plugin-outside-'));
		temporaryRoots.push(outsideParent);
		await mkdir(join(parentRoot, 'apps/api/convex'), { recursive: true });
		await symlink(outsideParent, join(parentRoot, 'apps/api/convex/plugins'), 'dir');
		await expect(generatePluginComposition(parentRoot)).rejects.toMatchObject({
			code: 'generated_path_unsafe',
		});
	});

	it('commits relative to the stable parent when its pathname is swapped at commit', async () => {
		const root = await createZeroPluginWorkspace();
		const parent = join(root, 'apps/api/convex/plugins');
		const parkedParent = join(root, 'parked-plugins');
		const target = join(parent, 'plugins.generated.ts');
		const outside = await mkdtemp(join(tmpdir(), 'owlat-plugin-race-outside-'));
		temporaryRoots.push(outside);
		await mkdir(parent, { recursive: true });
		await writeFile(join(outside, 'plugins.generated.ts'), 'outside victim\n');

		const write = writeFileAtomically(root, target, 'committed safely\n', {
			beforeCommit: async () => {
				expect((await readdir(parent)).filter((entry) => entry.endsWith('.tmp'))).toHaveLength(1);
				expect((await readdir(root)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
				await rename(parent, parkedParent);
				await symlink(outside, parent, 'dir');
			},
		});

		await expect(write).rejects.toMatchObject({ code: 'generated_path_unsafe' });
		expect(await readFile(join(outside, 'plugins.generated.ts'), 'utf8')).toBe('outside victim\n');
		expect(await readFile(join(parkedParent, 'plugins.generated.ts'), 'utf8')).toBe(
			'committed safely\n'
		);
		expect((await readdir(root)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
		expect((await readdir(parkedParent)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
	});

	it('stages beside a target on a nested filesystem device', async () => {
		if (process.platform !== 'linux') return;
		let workspaceDevice;
		let sharedMemoryDevice;
		try {
			[workspaceDevice, sharedMemoryDevice] = await Promise.all([stat('/'), stat('/dev/shm')]);
		} catch {
			return;
		}
		if (workspaceDevice.dev === sharedMemoryDevice.dev) return;

		const parent = await mkdtemp('/dev/shm/owlat-plugin-atomic-');
		temporaryRoots.push(parent);
		const target = join(parent, 'generated.ts');
		await writeFileAtomically('/', target, 'cross-device workspace\n');

		expect(await readFile(target, 'utf8')).toBe('cross-device workspace\n');
		expect((await readdir(parent)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
	});
});
