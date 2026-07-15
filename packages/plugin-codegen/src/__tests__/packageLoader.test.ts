import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundledPlugins, resolvePackageWithBun } from '../packageLoader';

const temporaryRoots: string[] = [];
type TestBunGlobal = typeof globalThis & {
	Bun?: { resolveSync(specifier: string, parent: string): string };
};

function resolveTestPackage(packageName: string, workspaceRoot: string): string {
	return createRequire(join(workspaceRoot, 'package.json')).resolve(packageName);
}

function loadTestPlugins(workspaceRoot: string, packageNames: readonly string[]) {
	return loadBundledPlugins(workspaceRoot, packageNames, { resolvePackage: resolveTestPackage });
}

async function createWorkspace(
	dependencies: Record<string, string>,
	modules: Record<string, string> = {}
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-plugin-codegen-'));
	temporaryRoots.push(root);
	await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies }));
	for (const [packageName, source] of Object.entries(modules)) {
		const packageRoot = join(root, 'node_modules', ...packageName.split('/'));
		await mkdir(packageRoot, { recursive: true });
		await writeFile(
			join(packageRoot, 'package.json'),
			JSON.stringify({ name: packageName, type: 'module', exports: './index.js' })
		);
		await writeFile(join(packageRoot, 'index.js'), source);
	}
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('installed plugin loading', () => {
	it('loads only direct production dependencies and returns host-ordered manifests', async () => {
		const root = await createWorkspace(
			{ 'zebra-plugin': '1.0.0', '@acme/alpha-plugin': '1.0.0' },
			{
				'zebra-plugin': `export default { id: 'zebra', version: '1.0.0', capabilities: [] };`,
				'@acme/alpha-plugin': `export default { id: 'alpha', version: '1.0.0', capabilities: ['mail:read'] };`,
			}
		);

		const plugins = await loadTestPlugins(root, ['zebra-plugin', '@acme/alpha-plugin']);

		expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(['alpha', 'zebra']);
	});

	it('rejects a package that is installed transitively but not declared directly', async () => {
		const root = await createWorkspace(
			{},
			{
				'mail-plugin': `export default { id: 'mail', version: '1.0.0', capabilities: [] };`,
			}
		);

		await expect(loadTestPlugins(root, ['mail-plugin'])).rejects.toMatchObject({
			code: 'dependency_missing',
		});
	});

	it('rejects a declared package that is not installed', async () => {
		const root = await createWorkspace({ 'missing-plugin': '1.0.0' });
		await expect(loadTestPlugins(root, ['missing-plugin'])).rejects.toMatchObject({
			code: 'dependency_missing',
		});
	});

	it('rejects invalid and missing default manifests without printing module internals', async () => {
		const root = await createWorkspace(
			{ 'invalid-plugin': '1.0.0', 'named-plugin': '1.0.0' },
			{
				'invalid-plugin': `export default { id: 'Invalid', secret: process.env.SECRET };`,
				'named-plugin': `export const manifest = { id: 'named', version: '1.0.0', capabilities: [] };`,
			}
		);

		await expect(loadTestPlugins(root, ['invalid-plugin'])).rejects.toMatchObject({
			code: 'invalid_manifest',
			message: 'Bundled plugin invalid-plugin does not export a valid default manifest',
		});
		await expect(loadTestPlugins(root, ['named-plugin'])).rejects.toMatchObject({
			code: 'invalid_manifest',
		});
	});

	it('rejects duplicate manifest ids across packages', async () => {
		const root = await createWorkspace(
			{ 'one-plugin': '1.0.0', 'two-plugin': '1.0.0' },
			{
				'one-plugin': `export default { id: 'shared', version: '1.0.0', capabilities: [] };`,
				'two-plugin': `export default { id: 'shared', version: '2.0.0', capabilities: [] };`,
			}
		);

		await expect(loadTestPlugins(root, ['one-plugin', 'two-plugin'])).rejects.toMatchObject({
			code: 'composition_invalid',
		});
	});

	it('uses Bun import-condition resolution from the requested workspace root', () => {
		const runtime = globalThis as TestBunGlobal;
		const originalBun = runtime.Bun;
		const calls: string[][] = [];
		runtime.Bun = {
			resolveSync(specifier, parent) {
				calls.push([specifier, parent]);
				return '/workspace/node_modules/mail-plugin/import.js';
			},
		};
		try {
			expect(resolvePackageWithBun('mail-plugin', '/workspace')).toBe(
				'/workspace/node_modules/mail-plugin/import.js'
			);
			expect(calls).toEqual([['mail-plugin', '/workspace']]);
		} finally {
			runtime.Bun = originalBun;
		}
	});
});
