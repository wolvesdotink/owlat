import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginPackageName } from '@owlat/plugin-host';
import { serializePluginsConfig } from '../config';
import type { CliIo } from '../io';

// A canonical, well-formed sha512 integrity string the codegen provenance check
// accepts; the exact bytes are irrelevant to these tests, only its structure.
const TEST_INTEGRITY = `sha512-${Buffer.alloc(64, 0xa5).toString('base64')}`;

const temporaryRoots: string[] = [];

export interface TestModule {
	readonly source?: string;
	readonly packageJson?: Record<string, unknown>;
}

export interface WorkspaceSpec {
	/** Packages written into plugins.config.ts (default: none). */
	readonly configPackages?: readonly string[];
	/** Root package.json dependency specs (default: derived from `modules`). */
	readonly dependencies?: Record<string, string>;
	/** Installed node_modules packages, by name. */
	readonly modules?: Record<string, string | TestModule>;
	/** Packages present in bun.lock (default: every installed module). */
	readonly lockedPackages?: readonly string[];
}

/**
 * Build a throwaway Owlat workspace: the findWorkspaceRoot markers, a canonical
 * plugins.config.ts, and any installed + lockfile-pinned bundled plugin
 * packages. Mirrors the codegen package-loader fixtures so the CLI exercises the
 * real verified loader (provenance, lockfile, dynamic manifest import).
 */
export async function createCliWorkspace(spec: WorkspaceSpec = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-plugin-cli-'));
	temporaryRoots.push(root);
	await mkdir(join(root, 'packages', 'plugin-codegen'), { recursive: true });
	await mkdir(join(root, 'node_modules'), { recursive: true });

	const modules = spec.modules ?? {};
	const dependencies =
		spec.dependencies ?? Object.fromEntries(Object.keys(modules).map((name) => [name, '1.0.0']));

	await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies }));

	for (const [name, definition] of Object.entries(modules)) {
		const module = typeof definition === 'string' ? { source: definition } : definition;
		const packageRoot = join(root, 'node_modules', ...name.split('/'));
		await mkdir(packageRoot, { recursive: true });
		await writeFile(
			join(packageRoot, 'package.json'),
			JSON.stringify({
				name,
				version: '1.0.0',
				type: 'module',
				exports: './index.js',
				...module.packageJson,
			})
		);
		await writeFile(join(packageRoot, 'index.js'), module.source ?? 'export default {};');
	}

	const locked = spec.lockedPackages ?? Object.keys(modules);
	const lockedEntries = Object.fromEntries(
		locked.map((name) => [name, [`${name}@1.0.0`, '', {}, TEST_INTEGRITY]])
	);
	await writeFile(
		join(root, 'bun.lock'),
		JSON.stringify({ workspaces: { '': { dependencies } }, packages: lockedEntries })
	);

	await writeFile(
		join(root, 'plugins.config.ts'),
		serializePluginsConfig((spec.configPackages ?? []) as readonly PluginPackageName[])
	);
	return root;
}

export async function cleanupCliWorkspaces(): Promise<void> {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
}

export async function readConfigSource(root: string): Promise<string> {
	return readFile(join(root, 'plugins.config.ts'), 'utf8');
}

/** A minimal valid manifest module for an installed test package. */
export function manifestModule(manifest: Record<string, unknown>): string {
	return `export default ${JSON.stringify(manifest)};\n`;
}

export interface CapturedIo {
	readonly io: CliIo;
	readonly lines: string[];
	readonly errors: string[];
	text(): string;
}

export function captureIo(): CapturedIo {
	const lines: string[] = [];
	const errors: string[] = [];
	return {
		io: { log: (message) => lines.push(message), error: (message) => errors.push(message) },
		lines,
		errors,
		text() {
			return lines.join('\n');
		},
	};
}
