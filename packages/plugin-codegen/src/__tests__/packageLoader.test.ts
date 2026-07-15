import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundledPlugins } from '../packageLoader';

const temporaryRoots: string[] = [];
const TEST_INTEGRITY = `sha512-${Buffer.alloc(64, 0xa5).toString('base64')}`;

interface TestPackage {
	readonly source?: string;
	readonly packageJson?: Record<string, unknown>;
	readonly files?: Readonly<Record<string, string>>;
}

async function createWorkspace(
	dependencies: Record<string, string>,
	modules: Record<string, string | TestPackage> = {},
	lockedPackages: readonly string[] = Object.keys(modules)
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-plugin-codegen-'));
	temporaryRoots.push(root);
	await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies }));
	await mkdir(join(root, 'node_modules'), { recursive: true });
	for (const [packageName, definition] of Object.entries(modules)) {
		const plugin = typeof definition === 'string' ? { source: definition } : definition;
		const packageRoot = join(root, 'node_modules', ...packageName.split('/'));
		await mkdir(packageRoot, { recursive: true });
		await writeFile(
			join(packageRoot, 'package.json'),
			JSON.stringify({
				name: packageName,
				version: '1.0.0',
				type: 'module',
				exports: './index.js',
				...plugin.packageJson,
			})
		);
		await writeFile(join(packageRoot, 'index.js'), plugin.source ?? 'export default {};');
		for (const [path, source] of Object.entries(plugin.files ?? {})) {
			await mkdir(dirname(join(packageRoot, path)), { recursive: true });
			await writeFile(join(packageRoot, path), source);
		}
	}
	const lockEntries = Object.fromEntries(
		lockedPackages.map((packageName) => [
			packageName,
			[`${packageName}@1.0.0`, '', {}, TEST_INTEGRITY],
		])
	);
	await writeFile(
		join(root, 'bun.lock'),
		JSON.stringify({
			workspaces: { '': { dependencies } },
			packages: lockEntries,
		})
	);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('installed plugin loading', () => {
	it('loads only direct locked registry dependencies and returns host-ordered manifests', async () => {
		const root = await createWorkspace(
			{ 'zebra-plugin': '1.0.0', '@acme/alpha-plugin': '^1.0.0' },
			{
				'zebra-plugin': `export default { id: 'zebra', version: '1.0.0', capabilities: [] };`,
				'@acme/alpha-plugin': `export default { id: 'alpha', version: '1.0.0', capabilities: ['mail:read'] };`,
			}
		);

		const plugins = await loadBundledPlugins(root, ['zebra-plugin', '@acme/alpha-plugin']);

		expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(['alpha', 'zebra']);
	});

	it('rejects a package that is installed transitively but not declared directly', async () => {
		const root = await createWorkspace(
			{},
			{
				'mail-plugin': `export default { id: 'mail', version: '1.0.0', capabilities: [] };`,
			}
		);

		await expect(loadBundledPlugins(root, ['mail-plugin'])).rejects.toMatchObject({
			code: 'dependency_missing',
		});
	});

	it('rejects a declared package that is not installed', async () => {
		const root = await createWorkspace({ 'missing-plugin': '1.0.0' });
		await expect(loadBundledPlugins(root, ['missing-plugin'])).rejects.toMatchObject({
			code: 'dependency_missing',
		});
	});

	it('rejects invalid and missing default manifests without printing module internals', async () => {
		const root = await createWorkspace(
			{ 'invalid-plugin': '1.0.0', 'named-plugin': 'latest' },
			{
				'invalid-plugin': `export default { id: 'Invalid', secret: process.env.SECRET };`,
				'named-plugin': `export const manifest = { id: 'named', version: '1.0.0', capabilities: [] };`,
			}
		);

		await expect(loadBundledPlugins(root, ['invalid-plugin'])).rejects.toMatchObject({
			code: 'invalid_manifest',
			message: 'Bundled plugin invalid-plugin does not export a valid default manifest',
		});
		await expect(loadBundledPlugins(root, ['named-plugin'])).rejects.toMatchObject({
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

		await expect(loadBundledPlugins(root, ['one-plugin', 'two-plugin'])).rejects.toMatchObject({
			code: 'composition_invalid',
		});
	});

	it('rejects runtime-conditional manifest exports before importing any target branch', async () => {
		const root = await createWorkspace(
			{ 'conditional-plugin': '1.0.0' },
			{
				'conditional-plugin': {
					packageJson: {
						exports: {
							'.': {
								browser: './browser.js',
								node: './node.js',
								bun: './bun.js',
								import: './import.js',
								default: './default.js',
							},
						},
					},
					files: Object.fromEntries(
						['browser', 'node', 'bun', 'import', 'default'].map((id) => [
							`${id}.js`,
							`export default { id: '${id}', version: '1.0.0', capabilities: [] };`,
						])
					),
				},
			}
		);
		let imported = false;

		await expect(
			loadBundledPlugins(root, ['conditional-plugin'], {
				loadModule: async () => {
					imported = true;
					return {};
				},
			})
		).rejects.toMatchObject({ code: 'conditional_manifest_export' });
		expect(imported).toBe(false);
	});

	it.each([
		'npm:different-plugin@1.0.0',
		'file:../outside',
		'../outside',
		'git+https://example.test/plugin.git',
		'https://example.test/plugin.tgz',
		'owner/repository',
		'workspace:*',
	])('rejects non-registry dependency provenance: %s', async (dependencySpec) => {
		const root = await createWorkspace(
			{ 'mail-plugin': dependencySpec },
			{
				'mail-plugin': `export default { id: 'mail', version: '1.0.0', capabilities: [] };`,
			}
		);
		await expect(loadBundledPlugins(root, ['mail-plugin'])).rejects.toMatchObject({
			code: 'dependency_provenance',
		});
	});

	it('rejects mismatched package identity and missing registry integrity', async () => {
		const mismatched = await createWorkspace(
			{ 'mail-plugin': '1.0.0' },
			{
				'mail-plugin': { packageJson: { name: 'different-plugin' } },
			}
		);
		await expect(loadBundledPlugins(mismatched, ['mail-plugin'])).rejects.toMatchObject({
			code: 'dependency_provenance',
		});

		const unlocked = await createWorkspace(
			{ 'mail-plugin': '1.0.0' },
			{
				'mail-plugin': `export default { id: 'mail', version: '1.0.0', capabilities: [] };`,
			},
			[]
		);
		await expect(loadBundledPlugins(unlocked, ['mail-plugin'])).rejects.toMatchObject({
			code: 'dependency_provenance',
		});
	});

	it('rejects lock comments, neighboring entries, duplicate keys, and malformed integrity', async () => {
		const root = await createWorkspace(
			{ 'mail-plugin': '1.0.0' },
			{
				'mail-plugin': `export default { id: 'mail', version: '1.0.0', capabilities: [] };`,
			}
		);
		const rootResolution = `"workspaces":{"":{"dependencies":{"mail-plugin":"1.0.0"}}}`;
		const spoof = `"mail-plugin": ["mail-plugin@1.0.0", "", {}, "${TEST_INTEGRITY}"]`;

		for (const lockSource of [
			`{${rootResolution},"packages":{/* ${spoof} */"mail-plugin-nearby":["mail-plugin@1.0.0","",{},"${TEST_INTEGRITY}"]}}`,
			`{${rootResolution},"packages":{${spoof},${spoof}}}`,
			`{${rootResolution},"packages":{"mail-plugin":["mail-plugin@1.0.0","",{},"sha512-not-a-digest"]}}`,
		]) {
			await writeFile(join(root, 'bun.lock'), lockSource);
			await expect(loadBundledPlugins(root, ['mail-plugin'])).rejects.toMatchObject({
				code: 'dependency_provenance',
			});
		}
	});

	it('rejects an oversized lock before parsing it', async () => {
		const root = await createWorkspace(
			{ 'mail-plugin': '1.0.0' },
			{
				'mail-plugin': `export default { id: 'mail', version: '1.0.0', capabilities: [] };`,
			}
		);
		await writeFile(join(root, 'bun.lock'), ' '.repeat(8 * 1024 * 1024 + 1));

		await expect(loadBundledPlugins(root, ['mail-plugin'])).rejects.toMatchObject({
			code: 'dependency_provenance',
		});
	});

	it('rejects a package symlink that escapes node_modules', async () => {
		const outside = await createWorkspace(
			{},
			{
				'outside-plugin': `export default { id: 'outside', version: '1.0.0', capabilities: [] };`,
			}
		);
		const root = await createWorkspace({ 'safe-plugin': '1.0.0' }, {}, ['safe-plugin']);
		await symlink(
			join(outside, 'node_modules', 'outside-plugin'),
			join(root, 'node_modules', 'safe-plugin'),
			'dir'
		);

		await expect(loadBundledPlugins(root, ['safe-plugin'])).rejects.toMatchObject({
			code: 'dependency_provenance',
		});
	});

	it('reads a hostile manifest once and composes the immutable first snapshot', async () => {
		const root = await createWorkspace(
			{ 'proxy-plugin': '1.0.0' },
			{
				'proxy-plugin': `export default { id: 'unused', version: '1.0.0', capabilities: [] };`,
			}
		);
		let ownKeyReads = 0;
		const firstManifest = { id: 'first', version: '1.0.0', capabilities: [] };
		const secondManifest = { id: 'second', version: '1.0.0', capabilities: [] };
		const manifest = new Proxy(firstManifest, {
			ownKeys() {
				ownKeyReads += 1;
				return Reflect.ownKeys(ownKeyReads === 1 ? firstManifest : secondManifest);
			},
			getOwnPropertyDescriptor(_target, key) {
				return Object.getOwnPropertyDescriptor(
					ownKeyReads === 1 ? firstManifest : secondManifest,
					key
				);
			},
		});

		const plugins = await loadBundledPlugins(root, ['proxy-plugin'], {
			loadModule: async () => ({ default: manifest }),
		});

		expect(plugins[0]?.manifest.id).toBe('first');
		expect(ownKeyReads).toBe(1);
	});

	it('never invokes an accessor default export and keeps the error package-attributed', async () => {
		const root = await createWorkspace(
			{ 'accessor-plugin': '1.0.0' },
			{
				'accessor-plugin': `export default { id: 'unused', version: '1.0.0', capabilities: [] };`,
			}
		);
		let getterCalls = 0;
		const loadedModule = Object.defineProperty({}, 'default', {
			get() {
				getterCalls += 1;
				return { id: 'unsafe', version: '1.0.0', capabilities: [] };
			},
		});

		await expect(
			loadBundledPlugins(root, ['accessor-plugin'], { loadModule: async () => loadedModule })
		).rejects.toMatchObject({
			code: 'invalid_manifest',
			message: 'Bundled plugin accessor-plugin does not export a valid default manifest',
		});
		expect(getterCalls).toBe(0);
	});
});
