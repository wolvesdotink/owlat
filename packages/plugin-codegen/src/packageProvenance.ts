import { open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PluginPackageName } from '@owlat/plugin-host';
import ts from 'typescript';
import { PluginCodegenError } from './errors';

const MAX_BUN_LOCK_BYTES = 8 * 1024 * 1024;

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
	await verifyRegistryLock(workspaceRoot, packageName, packageJson.version, dependencySpec);

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
	version: string,
	dependencySpec: string
): Promise<void> {
	const lockPath = join(workspaceRoot, 'bun.lock');
	let lockSource: string;
	try {
		lockSource = await readBoundedUtf8File(lockPath, MAX_BUN_LOCK_BYTES);
	} catch (cause) {
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName} must have a readable, bounded bun.lock resolution`,
			[],
			{ cause }
		);
	}

	try {
		const lock = parseLockObject(lockPath, lockSource);
		verifyRootLockResolution(lock, packageName, dependencySpec);
		verifyPackageArtifact(lock, packageName, version);
	} catch (cause) {
		if (cause instanceof PluginCodegenError) throw cause;
		throw new PluginCodegenError(
			'dependency_provenance',
			`Bundled plugin ${packageName}@${version} is not structurally pinned to a registry artifact in bun.lock`,
			[],
			{ cause }
		);
	}
}

function verifyRootLockResolution(
	lock: ts.ObjectLiteralExpression,
	packageName: PluginPackageName,
	dependencySpec: string
): void {
	const workspaces = requireObjectProperty(lock, 'workspaces');
	const rootWorkspace = requireObjectProperty(workspaces, '');
	const dependencyValues = ['dependencies', 'optionalDependencies'].flatMap((field) => {
		const collection = readUniqueProperty(rootWorkspace, field);
		if (!collection) return [];
		if (!ts.isObjectLiteralExpression(collection.initializer)) throw invalidLockStructure();
		const dependency = readUniqueProperty(collection.initializer, packageName);
		return dependency ? [readStringInitializer(dependency)] : [];
	});
	if (dependencyValues.length !== 1 || dependencyValues[0] !== dependencySpec) {
		throw invalidLockStructure();
	}
}

function verifyPackageArtifact(
	lock: ts.ObjectLiteralExpression,
	packageName: PluginPackageName,
	version: string
): void {
	const packages = requireObjectProperty(lock, 'packages');
	const entry = readUniqueProperty(packages, packageName);
	if (!entry || !ts.isArrayLiteralExpression(entry.initializer)) throw invalidLockStructure();
	const elements = entry.initializer.elements;
	if (
		elements.length !== 4 ||
		!ts.isStringLiteral(elements[0]!) ||
		elements[0].text !== `${packageName}@${version}` ||
		!ts.isStringLiteral(elements[1]!) ||
		!ts.isObjectLiteralExpression(elements[2]!) ||
		!ts.isStringLiteral(elements[3]!) ||
		!isCanonicalSha512Integrity(elements[3].text)
	) {
		throw invalidLockStructure();
	}
}

function parseLockObject(path: string, source: string): ts.ObjectLiteralExpression {
	const sourceFile = ts.parseJsonText(path, source);
	const diagnostics =
		(sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
			.parseDiagnostics ?? [];
	const statement = sourceFile.statements[0];
	if (
		diagnostics.length > 0 ||
		sourceFile.statements.length !== 1 ||
		!statement ||
		!ts.isExpressionStatement(statement) ||
		!ts.isObjectLiteralExpression(statement.expression)
	) {
		throw invalidLockStructure();
	}
	return statement.expression;
}

function requireObjectProperty(
	object: ts.ObjectLiteralExpression,
	name: string
): ts.ObjectLiteralExpression {
	const property = readUniqueProperty(object, name);
	if (!property || !ts.isObjectLiteralExpression(property.initializer)) {
		throw invalidLockStructure();
	}
	return property.initializer;
}

function readUniqueProperty(
	object: ts.ObjectLiteralExpression,
	name: string
): ts.PropertyAssignment | undefined {
	const matches = object.properties.filter(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) && readPropertyName(property.name) === name
	);
	if (matches.length > 1) throw invalidLockStructure();
	return matches[0];
}

function readPropertyName(name: ts.PropertyName): string | undefined {
	return ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isIdentifier(name)
		? name.text
		: undefined;
}

function readStringInitializer(property: ts.PropertyAssignment): string | undefined {
	return ts.isStringLiteral(property.initializer) ? property.initializer.text : undefined;
}

function isCanonicalSha512Integrity(integrity: string): boolean {
	if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) return false;
	const encoded = integrity.slice('sha512-'.length);
	const digest = Buffer.from(encoded, 'base64');
	return digest.length === 64 && digest.toString('base64') === encoded;
}

function invalidLockStructure(): PluginCodegenError {
	return new PluginCodegenError(
		'dependency_provenance',
		'bun.lock does not contain one exact root registry resolution and verified package artifact'
	);
}

async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
	const file = await open(path, 'r');
	try {
		const initialSize = (await file.stat()).size;
		if (initialSize > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
		const buffer = Buffer.allocUnsafe(Math.min(initialSize + 1, maxBytes + 1));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
		return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
	} finally {
		await file.close();
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
