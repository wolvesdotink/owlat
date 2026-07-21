import { mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundledPlugins } from '../packageLoader';
import {
	cleanupPackageLoaderWorkspaces,
	createPackageLoaderWorkspace as createWorkspace,
	registerTemporaryRoot,
	TEST_INTEGRITY,
} from './packageLoaderFixtures';

afterEach(async () => {
	await cleanupPackageLoaderWorkspaces();
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

	it('accepts one exact static component export and rejects missing or conditional targets', async () => {
		const valid = await createWorkspace(
			{ 'component-plugin': '1.0.0' },
			{
				'component-plugin': {
					source: `export default { id: 'component', version: '1.0.0', capabilities: [], component: { exportPath: './convex/convex.config' } };`,
					packageJson: {
						exports: {
							'.': './index.js',
							'./convex/convex.config': './convex/convex.config.js',
						},
					},
					files: { 'convex/convex.config.js': 'export default {};' },
				},
			}
		);
		await expect(loadBundledPlugins(valid, ['component-plugin'])).resolves.toHaveLength(1);

		for (const componentTarget of [undefined, { convex: './convex/convex.config.js' }]) {
			const invalid = await createWorkspace(
				{ 'component-plugin': '1.0.0' },
				{
					'component-plugin': {
						source: `export default { id: 'component', version: '1.0.0', capabilities: [], component: { exportPath: './convex/convex.config' } };`,
						packageJson: {
							exports: {
								'.': './index.js',
								...(componentTarget === undefined
									? {}
									: { './convex/convex.config': componentTarget }),
							},
						},
						files: { 'convex/convex.config.js': 'export default {};' },
					},
				}
			);
			await expect(loadBundledPlugins(invalid, ['component-plugin'])).rejects.toMatchObject({
				code: 'component_export_invalid',
			});
		}
	});

	it('rejects a component export whose target symlink escapes the package', async () => {
		const root = await createWorkspace(
			{ 'component-plugin': '1.0.0' },
			{
				'component-plugin': {
					source: `export default { id: 'component', version: '1.0.0', capabilities: [], component: { exportPath: './convex/convex.config' } };`,
					packageJson: {
						exports: {
							'.': './index.js',
							'./convex/convex.config': './convex/convex.config.js',
						},
					},
					files: { 'convex/convex.config.js': 'export default {};' },
				},
			}
		);
		const outside = await mkdtemp(join(tmpdir(), 'owlat-component-outside-'));
		registerTemporaryRoot(outside);
		const outsideTarget = join(outside, 'convex.config.js');
		await writeFile(outsideTarget, 'export default {};');
		const componentTarget = join(root, 'node_modules/component-plugin/convex/convex.config.js');
		await unlink(componentTarget);
		await symlink(outsideTarget, componentTarget);

		await expect(loadBundledPlugins(root, ['component-plugin'])).rejects.toMatchObject({
			code: 'component_export_invalid',
		});
	});

	it('bounds the workspace package.json before parsing with workspace error taxonomy', async () => {
		const root = await createWorkspace(
			{ 'mail-plugin': '1.0.0' },
			{
				'mail-plugin': `export default { id: 'mail', version: '1.0.0', capabilities: [] };`,
			}
		);
		const packagePath = join(root, 'package.json');
		const packageSource = JSON.stringify({ dependencies: { 'mail-plugin': '1.0.0' } });
		await writeFile(packagePath, packageSource.padEnd(1024 * 1024, ' '));
		await expect(loadBundledPlugins(root, ['mail-plugin'])).resolves.toHaveLength(1);

		await writeFile(packagePath, packageSource.padEnd(1024 * 1024 + 1, ' '));
		await expect(loadBundledPlugins(root, ['mail-plugin'])).rejects.toMatchObject({
			code: 'workspace_not_found',
			message: 'Cannot read the workspace package.json',
		});
	});

	it('bounds installed package.json before parsing with provenance taxonomy', async () => {
		const root = await createWorkspace(
			{ 'mail-plugin': '1.0.0' },
			{
				'mail-plugin': `export default { id: 'mail', version: '1.0.0', capabilities: [] };`,
			}
		);
		const packagePath = join(root, 'node_modules/mail-plugin/package.json');
		const packageSource = JSON.stringify({
			name: 'mail-plugin',
			version: '1.0.0',
			type: 'module',
			exports: './index.js',
		});
		await writeFile(packagePath, packageSource.padEnd(1024 * 1024, ' '));
		await expect(loadBundledPlugins(root, ['mail-plugin'])).resolves.toHaveLength(1);

		await writeFile(packagePath, packageSource.padEnd(1024 * 1024 + 1, ' '));
		await expect(loadBundledPlugins(root, ['mail-plugin'])).rejects.toMatchObject({
			code: 'dependency_provenance',
			message: 'Bundled plugin mail-plugin has unreadable package metadata',
		});
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
