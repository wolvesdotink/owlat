/**
 * Throwaway-deployment harness.
 *
 * The conformance suites do not fake the plugin pipeline: they build a real,
 * disposable Owlat-shaped workspace on disk — a root `package.json`, a `bun.lock`
 * with canonical registry artifacts, an installed `node_modules` copy of each
 * reference plugin, and the generated-output directories — and then run the
 * SHIPPED `@owlat/plugin-codegen` and `@owlat/plugin-cli` against it.
 *
 * That matters because the codegen loader refuses anything it cannot vouch for:
 * a bundled plugin must be a root dependency with a registry version spec, must
 * be resolvable inside the workspace `node_modules`, must match its lockfile
 * entry (including a canonical sha512 integrity), and must expose its manifest
 * and every contribution module through condition-independent export strings.
 * Building the fixture correctly IS the install contract; a harness that cut a
 * corner here would not load at all.
 *
 * Note that a workspace-linked example can never be bundled in the repository
 * itself: `plugins.config.ts` accepts only registry-published packages, which is
 * exactly why the gallery installs published-shaped copies of the real manifests
 * into a temporary root instead of adding them to the checked-in config.
 *
 * Because the fixture is a copy, on its own it would prove the install contract
 * only for a rewritten package. `gallery.test.ts` ("published package shape")
 * closes that gap: it reads each reference's real `package.json` and asserts it
 * declares the shape this harness synthesizes — a string root export plus a
 * string export for every contribution module its manifest names.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parsePluginsConfig } from '@owlat/plugin-codegen';
import type { PluginManifest } from '@owlat/plugin-kit';
import { contributionExportPaths, type GalleryEntry } from './gallery';

/** Directories the generated composition is written into. */
const GENERATED_PARENTS = ['apps/api/convex/plugins', 'apps/web/app/plugins'];

const temporaryRoots: string[] = [];

export interface InstalledPlugin {
	readonly packageName: string;
	readonly manifest: PluginManifest;
	/** Overrides the version written to package.json + bun.lock (upgrade scenarios). */
	readonly version?: string;
}

export interface DeploymentSpec {
	/** Packages installed into node_modules and pinned in bun.lock. */
	readonly installed: readonly InstalledPlugin[];
	/** Packages listed in plugins.config.ts (defaults to none — a clean install). */
	readonly bundled?: readonly string[];
}

/** A canonical, structurally valid sha512 integrity for a deterministic input. */
function integrityOf(source: string): string {
	return `sha512-${createHash('sha512').update(source).digest('base64')}`;
}

function manifestVersion(plugin: InstalledPlugin): string {
	return plugin.version ?? plugin.manifest.version;
}

/** The canonical plugins.config.ts an operator would have on disk. */
export function pluginsConfigSource(packages: readonly string[]): string {
	const list = packages.length === 0 ? '[]' : `[${packages.map((name) => `'${name}'`).join(', ')}]`;
	return [
		"import type { PluginsConfig } from '@owlat/plugin-codegen';",
		'',
		'export default {',
		`\tbundledPluginPackages: ${list},`,
		'} satisfies PluginsConfig;',
		'',
	].join('\n');
}

/**
 * Materialize one disposable deployment. The manifest is serialized to JSON and
 * re-exported as the installed package's default export, which is exactly what a
 * published plugin ships: data the host can read without executing plugin logic.
 */
export async function createDeployment(spec: DeploymentSpec): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-plugin-conformance-'));
	temporaryRoots.push(root);

	const dependencies: Record<string, string> = {};
	for (const plugin of spec.installed) dependencies[plugin.packageName] = manifestVersion(plugin);

	await writeFile(
		join(root, 'package.json'),
		`${JSON.stringify({ name: 'owlat-conformance-deployment', type: 'module', dependencies }, null, '\t')}\n`
	);
	for (const parent of GENERATED_PARENTS) await mkdir(join(root, parent), { recursive: true });
	await mkdir(join(root, 'node_modules'), { recursive: true });

	const lockPackages: Record<string, unknown> = {};
	for (const plugin of spec.installed) {
		const version = manifestVersion(plugin);
		const packageRoot = join(root, 'node_modules', ...plugin.packageName.split('/'));
		await mkdir(packageRoot, { recursive: true });

		const manifestSource = `export default ${JSON.stringify(plugin.manifest, null, '\t')};\n`;
		const exports: Record<string, string> = { '.': './index.js' };
		for (const exportPath of contributionExportPaths(plugin.manifest)) {
			exports[exportPath] = `${exportPath}.js`;
		}
		await writeFile(
			join(packageRoot, 'package.json'),
			`${JSON.stringify({ name: plugin.packageName, version, type: 'module', exports }, null, '\t')}\n`
		);
		await writeFile(join(packageRoot, 'index.js'), manifestSource);
		for (const [exportPath, target] of Object.entries(exports)) {
			if (exportPath === '.') continue;
			const file = join(packageRoot, target);
			await mkdir(dirname(file), { recursive: true });
			// The loader only proves the contribution module EXISTS and is contained
			// in the package; it never imports it at codegen time.
			await writeFile(file, `export default {};\n`);
		}

		lockPackages[plugin.packageName] = [
			`${plugin.packageName}@${version}`,
			'',
			{},
			integrityOf(`${plugin.packageName}@${version}`),
		];
	}

	await writeFile(
		join(root, 'bun.lock'),
		`${JSON.stringify({ workspaces: { '': { dependencies } }, packages: lockPackages }, null, '\t')}\n`
	);
	await writeFile(join(root, 'plugins.config.ts'), pluginsConfigSource(spec.bundled ?? []));
	return root;
}

/** Install every gallery reference; bundle the subset named by `bundled`. */
export async function createGalleryDeployment(
	gallery: readonly GalleryEntry[],
	bundled: readonly string[] = []
): Promise<string> {
	return createDeployment({
		installed: gallery.map((entry) => ({
			packageName: entry.packageName,
			manifest: entry.manifest,
		})),
		bundled,
	});
}

export async function readWorkspaceFile(root: string, path: string): Promise<string> {
	return readFile(join(root, path), 'utf8');
}

/**
 * Read the bundled set back through the SHIPPED static config parser, so a test
 * that asserts "the CLI wrote this" is reading the file the same way codegen
 * will — a hand-rolled regex here could accept a config the real parser rejects.
 */
export async function readBundledPackages(root: string): Promise<readonly string[]> {
	const source = await readWorkspaceFile(root, 'plugins.config.ts');
	return parsePluginsConfig(source, 'plugins.config.ts').bundledPluginPackages;
}

export async function fileExists(root: string, path: string): Promise<boolean> {
	try {
		await readWorkspaceFile(root, path);
		return true;
	} catch {
		return false;
	}
}

export async function cleanupDeployments(): Promise<void> {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
}
