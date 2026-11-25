/**
 * Install a REAL package directory into a disposable deployment the way a
 * registry install leaves it: a copy under `node_modules`, an exact root
 * dependency, and a `bun.lock` entry with the integrity of the installed bytes.
 *
 * `createDeployment` installs a stub that re-exports a manifest as JSON, which
 * is what the lifecycle suites need to vary manifests and versions freely. A stub
 * cannot show that a package's own `src/index.ts` exports the manifest the way
 * codegen imports it, so the suites that make that claim install the package
 * itself through this module instead.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseJsonRecord, readJsonRecord, recordField, stringField, stringMap } from './jsonFiles';

export interface PackedPackage {
	readonly name: string;
	readonly version: string;
	/** POSIX path inside the package → file content. */
	readonly files: ReadonlyMap<string, string>;
}

/** The sha512 a registry records for an artifact, over a canonical file listing. */
export function packedIntegrity(packed: PackedPackage): string {
	const hash = createHash('sha512');
	for (const path of [...packed.files.keys()].sort()) {
		hash.update(`${path}\0${packed.files.get(path)}\0`);
	}
	return `sha512-${hash.digest('base64')}`;
}

/**
 * Write `packed` into `root/node_modules` and pin it at the root as
 * `bun add --exact <name>@<version>` would.
 */
export async function installFromRegistry(root: string, packed: PackedPackage): Promise<void> {
	const packageRoot = join(root, 'node_modules', ...packed.name.split('/'));
	for (const [path, content] of packed.files) {
		const target = join(packageRoot, ...path.split('/'));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}

	const packageJsonPath = join(root, 'package.json');
	const packageJson = await readJsonRecord(packageJsonPath);
	packageJson['dependencies'] = {
		...stringMap(packageJson, 'dependencies', 'package.json'),
		[packed.name]: packed.version,
	};
	await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, '\t')}\n`);

	const lockPath = join(root, 'bun.lock');
	const lock = await readJsonRecord(lockPath);
	const rootWorkspace = recordField(recordField(lock, 'workspaces', 'bun.lock'), '', 'workspaces');
	rootWorkspace['dependencies'] = {
		...stringMap(rootWorkspace, 'dependencies', 'workspaces[""]'),
		[packed.name]: packed.version,
	};
	recordField(lock, 'packages', 'bun.lock')[packed.name] = [
		`${packed.name}@${packed.version}`,
		'',
		{},
		packedIntegrity(packed),
	];
	await writeFile(lockPath, `${JSON.stringify(lock, null, '\t')}\n`);
}

/**
 * Read a workspace package directory as the artifact it would publish: its
 * `package.json` and every file under `src/`, unchanged.
 */
export async function packDirectory(directory: string): Promise<PackedPackage> {
	const packageJsonSource = await readFile(join(directory, 'package.json'), 'utf8');
	const manifest = parseJsonRecord(packageJsonSource, directory);
	const files = new Map<string, string>([['package.json', packageJsonSource]]);
	await collect(directory, 'src', files);
	return {
		name: stringField(manifest, 'name', directory),
		version: stringField(manifest, 'version', directory),
		files,
	};
}

async function collect(root: string, relative: string, files: Map<string, string>): Promise<void> {
	for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
		const child = `${relative}/${entry.name}`;
		if (entry.isDirectory()) await collect(root, child, files);
		else if (entry.isFile()) files.set(child, await readFile(join(root, child), 'utf8'));
	}
}
