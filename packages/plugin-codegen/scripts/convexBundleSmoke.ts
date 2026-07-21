import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const convexDirectory = join(workspaceRoot, 'apps/api/convex');
const fixtureComponents = [
	{
		packageName: 'fixture-alpha-plugin',
		pluginId: 'fixture-alpha',
		namespace: 'plugin_fixture_alpha',
	},
	{
		packageName: 'fixture-beta-plugin',
		pluginId: 'fixture-beta',
		namespace: 'plugin_fixture_beta',
	},
] as const;

await assertProductionCompositionBundles();
if (process.env['OWLAT_CONVEX_BUNDLE_PRODUCTION_ONLY'] !== '1') {
	await assertNonemptyCompositionBundles();
}

console.info('Convex bundled the validated plugin composition from packaged workspace exports.');

async function assertProductionCompositionBundles() {
	const result = await convexBuild(workspaceRoot, join(convexDirectory, 'convex.config.ts'));
	const inputs = Object.keys(result.metafile.inputs);
	if (!inputs.some((input) => input.endsWith('packages/plugin-host/src/composition.ts'))) {
		throw new Error('Convex-compatible bundle did not include the plugin host composition');
	}
	if (!inputs.some((input) => input.endsWith('apps/api/convex/plugins/components.generated.ts'))) {
		throw new Error(
			'Convex-compatible bundle did not include static plugin component registration'
		);
	}
	if (
		!inputs.some(
			(input) =>
				input.endsWith('packages/plugin-kit/dist/index.js') ||
				input.endsWith('packages/plugin-kit/src/index.ts')
		)
	) {
		throw new Error('Convex-compatible bundle did not include the plugin-kit manifest contract');
	}
}

async function assertNonemptyCompositionBundles() {
	const root = await mkdtemp(join(tmpdir(), 'owlat-convex-bundle-'));
	try {
		await materializeFixtureWorkspace(root);
		const cliPath = join(workspaceRoot, 'packages/plugin-codegen/src/cli.ts');
		execFileSync('bun', [cliPath], { cwd: root, stdio: 'inherit' });
		execFileSync('bun', [cliPath, '--check'], { cwd: root, stdio: 'inherit' });

		await symlink(join(workspaceRoot, 'node_modules/convex'), join(root, 'node_modules/convex'));
		const generatedPath = join(root, 'apps/api/convex/plugins/components.generated.ts');
		const generated = await readFile(generatedPath, 'utf8');
		for (const { packageName, namespace } of fixtureComponents) {
			if (!generated.includes(`${packageName}/convex/convex.config`)) {
				throw new Error(`Generated installer did not import ${packageName}`);
			}
			if (!generated.includes(`name: "${namespace}"`)) {
				throw new Error(`Generated installer did not register ${namespace}`);
			}
		}

		const configPath = join(root, 'apps/api/convex/convex.config.ts');
		await writeFile(
			configPath,
			"import { defineApp } from 'convex/server';\nimport { installBundledPluginComponents } from './plugins/components.generated';\nconst app = defineApp();\ninstallBundledPluginComponents(app);\nexport default app;\n"
		);
		await writeFile(
			join(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ESNext',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: true,
					skipLibCheck: true,
					noEmit: true,
				},
				files: [
					'apps/api/convex/convex.config.ts',
					'apps/api/convex/plugins/components.generated.ts',
					...fixtureComponents.flatMap(({ packageName }) => [
						`node_modules/${packageName}/convex/convex.config.ts`,
						`node_modules/${packageName}/convex/schema.ts`,
						`node_modules/${packageName}/convex/records.ts`,
					]),
				],
			})
		);
		execFileSync(join(workspaceRoot, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], {
			cwd: root,
			stdio: 'inherit',
		});

		const result = await convexBuild(root, configPath);
		const inputs = Object.keys(result.metafile.inputs);
		for (const { packageName } of fixtureComponents) {
			if (!inputs.some((input) => input.includes(`${packageName}/convex/convex.config.ts`))) {
				throw new Error(`Convex-compatible bundle omitted ${packageName}'s real component`);
			}
		}
		const output = result.outputFiles.map((file) => file.text).join('\n');
		if (!output.includes('plugin_fixture_alpha') || !output.includes('plugin_fixture_beta')) {
			throw new Error('Convex-compatible bundle omitted generated component namespaces');
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function materializeFixtureWorkspace(root: string): Promise<void> {
	const dependencies = Object.fromEntries(
		fixtureComponents.map(({ packageName }) => [packageName, '1.0.0'])
	);
	await mkdir(join(root, 'packages/plugin-codegen'), { recursive: true });
	await mkdir(join(root, 'node_modules'), { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies }));
	await writeFile(
		join(root, 'bun.lock'),
		JSON.stringify({
			workspaces: { '': { dependencies } },
			packages: Object.fromEntries(
				fixtureComponents.map(({ packageName }, index) => [
					packageName,
					[
						`${packageName}@1.0.0`,
						'',
						{},
						`sha512-${Buffer.alloc(64, 0xa5 + index).toString('base64')}`,
					],
				])
			),
		})
	);
	await writeFile(
		join(root, 'plugins.config.ts'),
		`export default { bundledPluginPackages: ${JSON.stringify(fixtureComponents.map(({ packageName }) => packageName))} };\n`
	);

	const fixture = join(
		workspaceRoot,
		'packages/plugin-codegen/src/__tests__/fixtures/tier1Component'
	);
	for (const { packageName, pluginId } of fixtureComponents) {
		const packageRoot = join(root, 'node_modules', packageName);
		await mkdir(packageRoot, { recursive: true });
		await cp(fixture, join(packageRoot, 'convex'), { recursive: true });
		await writeFile(
			join(packageRoot, 'package.json'),
			JSON.stringify({
				name: packageName,
				version: '1.0.0',
				type: 'module',
				exports: {
					'.': './index.js',
					'./convex/convex.config': './convex/convex.config.ts',
				},
			})
		);
		await writeFile(
			join(packageRoot, 'index.js'),
			`export default { id: ${JSON.stringify(pluginId)}, version: '1.0.0', capabilities: [], component: { exportPath: './convex/convex.config' } };\n`
		);
	}
}

// Convex 1.36's component-definition bundler uses this esbuild runtime,
// platform, format, target, and condition set before making a network request.
async function convexBuild(root: string, entryPoint: string) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: [entryPoint],
		bundle: true,
		platform: 'browser',
		format: 'esm',
		target: 'esnext',
		conditions: ['convex', 'module'],
		write: false,
		outdir: join(tmpdir(), 'owlat-convex-plugin-bundle'),
		metafile: true,
	});
	if (result.outputFiles.length === 0) {
		throw new Error('Convex-compatible bundler did not emit an application definition');
	}
	return result;
}
