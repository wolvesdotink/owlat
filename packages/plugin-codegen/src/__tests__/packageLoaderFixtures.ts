import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const temporaryRoots: string[] = [];
export const TEST_INTEGRITY = `sha512-${Buffer.alloc(64, 0xa5).toString('base64')}`;

interface TestPackage {
	readonly source?: string;
	readonly packageJson?: Record<string, unknown>;
	readonly files?: Readonly<Record<string, string>>;
}

export async function createPackageLoaderWorkspace(
	dependencies: Record<string, string>,
	modules: Record<string, string | TestPackage> = {},
	lockedPackages: readonly string[] = Object.keys(modules)
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-plugin-codegen-'));
	registerTemporaryRoot(root);
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
		JSON.stringify({ workspaces: { '': { dependencies } }, packages: lockEntries })
	);
	return root;
}

export function registerTemporaryRoot(root: string): void {
	temporaryRoots.push(root);
}

export async function cleanupPackageLoaderWorkspaces(): Promise<void> {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
}
