import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PluginPackageName } from '@owlat/plugin-host';
import { PluginCodegenError } from './errors';

interface WorkspacePackageJson {
	readonly dependencies?: Record<string, unknown>;
	readonly optionalDependencies?: Record<string, unknown>;
}

interface InstalledPackageJson {
	readonly name?: unknown;
	readonly version?: unknown;
	readonly exports?: unknown;
}

export async function resolveVerifiedPluginEntry(
	workspaceRoot: string,
	packageName: PluginPackageName
): Promise<string> {
	const workspacePackageJson = await readJsonFile<WorkspacePackageJson>(
		join(workspaceRoot, 'package.json'),
		'Cannot read the workspace package.json'
	);
	const dependencySpec = readProductionDependencySpec(workspacePackageJson, packageName);
	if (!dependencySpec) {
		throw new PluginCodegenError(
			'dependency_missing',
			`Bundled plugin ${packageName} must be installed as a root dependency or optionalDependency`
		);
	}
	if (!isRegistryDependencySpec(dependencySpec)) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} must use a registry version or dist-tag, not an alias, URL, git, file, or workspace source`
		);
	}

	const realWorkspaceRoot = await realpath(workspaceRoot);
	const nodeModulesRoot = await resolveRequiredPath(
		join(workspaceRoot, 'node_modules'),
		packageName
	);
	if (!isPathInside(realWorkspaceRoot, nodeModulesRoot)) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} cannot use a node_modules tree outside the workspace`
		);
	}
	const packageJsonPath = await resolveRequiredPath(
		join(workspaceRoot, 'node_modules', ...packageName.split('/'), 'package.json'),
		packageName
	);
	const packageRoot = dirname(packageJsonPath);
	if (!isPathInside(nodeModulesRoot, packageRoot)) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} resolves outside the workspace node_modules tree`
		);
	}

	const packageJson = await readJsonFile<InstalledPackageJson>(
		packageJsonPath,
		`Bundled plugin ${packageName} has unreadable package metadata`,
		'dependency_provenance'
	);
	if (packageJson.name !== packageName) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} resolves to package metadata with a different name`
		);
	}
	if (
		typeof packageJson.version !== 'string' ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
			packageJson.version
		)
	) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} must declare an installed package version`
		);
	}
	await verifyRegistryLock(workspaceRoot, packageName, packageJson.version);

	const exportPath = readConditionIndependentRootExport(packageJson.exports, packageName);
	const declaredEntryPath = resolve(packageRoot, exportPath);
	if (!isPathInside(packageRoot, declaredEntryPath)) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} has a root export outside its package directory`
		);
	}
	const entryPath = await resolveRequiredPath(declaredEntryPath, packageName);
	if (!isPathInside(packageRoot, entryPath)) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} has a root export outside its package directory`
		);
	}
	const entryStat = await stat(entryPath);
	if (!entryStat.isFile()) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} root export must resolve to a regular file`
		);
	}
	return entryPath;
}

function readProductionDependencySpec(
	packageJson: WorkspacePackageJson,
	packageName: PluginPackageName
): string | undefined {
	const value = Object.hasOwn(packageJson.dependencies ?? {}, packageName)
		? packageJson.dependencies?.[packageName]
		: packageJson.optionalDependencies?.[packageName];
	return typeof value === 'string' ? value : undefined;
}

function isRegistryDependencySpec(spec: string): boolean {
	return (
		spec.length > 0 &&
		spec.length <= 256 &&
		spec.trim() === spec &&
		!spec.startsWith('.') &&
		!spec.includes(':') &&
		!spec.includes('/') &&
		!spec.includes('\\') &&
		!spec.includes('#') &&
		!spec.includes('@') &&
		/^[0-9A-Za-z*<>=~^|.+ -]+$/.test(spec)
	);
}

function readConditionIndependentRootExport(
	exportsField: unknown,
	packageName: PluginPackageName
): string {
	const rootExport =
		typeof exportsField === 'string'
			? exportsField
			: isRecord(exportsField) && Object.hasOwn(exportsField, '.')
				? exportsField['.']
				: undefined;
	if (typeof rootExport !== 'string' || !rootExport.startsWith('./') || rootExport.includes('\0')) {
		throw new PluginCodegenError(
			'conditional_manifest_export',
			`Bundled plugin ${packageName} must expose its default manifest through one condition-independent root export string`
		);
	}
	return rootExport;
}

async function verifyRegistryLock(
	workspaceRoot: string,
	packageName: PluginPackageName,
	version: string
): Promise<void> {
	let lockSource: string;
	try {
		lockSource = await readFile(join(workspaceRoot, 'bun.lock'), 'utf8');
	} catch (cause) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} must have a frozen bun.lock resolution`,
			[],
			{ cause }
		);
	}
	const lockedPackage = `${JSON.stringify(packageName)}: [${JSON.stringify(`${packageName}@${version}`)},`;
	const entryStart = lockSource.indexOf(lockedPackage);
	const entryEnd = entryStart < 0 ? -1 : lockSource.indexOf('\n', entryStart);
	const lockEntry =
		entryStart < 0 ? '' : lockSource.slice(entryStart, entryEnd < 0 ? undefined : entryEnd);
	if (!lockEntry.includes('"sha512-')) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName}@${version} is not pinned to a registry artifact in bun.lock`
		);
	}
}

async function resolveRequiredPath(path: string, packageName: PluginPackageName): Promise<string> {
	try {
		return await realpath(path);
	} catch (cause) {
		throw new PluginCodegenError(
			'dependency_missing',
			`Bundled plugin ${packageName} is declared but not installed`,
			[],
			{ cause }
		);
	}
}

function isPathInside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function readJsonFile<T>(
	path: string,
	message: string,
	code: 'dependency_provenance' | 'workspace_not_found' = 'workspace_not_found'
): Promise<T> {
	try {
		const source = await readFile(path, 'utf8');
		const value: unknown = JSON.parse(source);
		if (!isRecord(value)) throw new Error('JSON root must be an object');
		return value as T;
	} catch (cause) {
		throw new PluginCodegenError(code, message, [], { cause });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
