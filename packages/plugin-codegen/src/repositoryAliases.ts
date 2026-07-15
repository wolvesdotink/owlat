import { execFileSync } from 'node:child_process';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { PluginCodegenError } from './errors';

export interface RepositoryModuleAlias {
	readonly specifierPattern: string;
	readonly targetPattern: string;
}

const MAX_CONFIG_FILES = 512;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_DIRECTORIES = 256;

export async function readRepositoryModuleAliases(
	workspaceRoot: string
): Promise<readonly RepositoryModuleAlias[]> {
	const aliases: RepositoryModuleAlias[] = [];
	const configFiles = await findConfigFiles(workspaceRoot);
	for (const path of configFiles) {
		let source: string;
		try {
			source = await readBoundedUtf8File(path, MAX_CONFIG_BYTES);
			const filename = basename(path);
			if (filename === 'package.json') {
				collectPackageAliases(parseJsonConfig(path, source), aliases);
			} else if (/^tsconfig(?:\.[^.]+)?\.json$/.test(filename)) {
				collectTypeScriptAliases(parseJsonConfig(path, source), aliases);
			} else {
				collectFrameworkAliases(parseSourceConfig(path, source), aliases);
			}
		} catch (cause) {
			if (cause instanceof PluginCodegenError) throw cause;
			throw new PluginCodegenError(
				'repository_config_invalid',
				`Cannot safely read repository alias configuration ${relative(workspaceRoot, path)}`,
				[relative(workspaceRoot, path)],
				{ cause }
			);
		}
	}
	return Object.freeze(aliases);
}

export function specifierTargetsConfiguredPackage(
	specifier: string,
	packageNames: readonly string[],
	aliases: readonly RepositoryModuleAlias[]
): boolean {
	const pending = [specifier];
	const visited = new Set<string>();
	while (pending.length > 0 && visited.size <= 64) {
		const candidate = pending.pop();
		if (!candidate || visited.has(candidate)) continue;
		visited.add(candidate);
		if (packageNames.some((packageName) => targetReferencesPackage(candidate, packageName))) {
			return true;
		}
		for (const alias of aliases) {
			const wildcard = matchAlias(alias.specifierPattern, candidate);
			if (wildcard !== undefined) {
				pending.push(alias.targetPattern.replaceAll('*', wildcard));
			}
		}
	}
	return false;
}

async function findConfigFiles(workspaceRoot: string): Promise<readonly string[]> {
	const tracked = await readTrackedConfigFiles(workspaceRoot);
	const files = tracked ?? (await readWorkspaceConfigFilesWithoutGit(workspaceRoot));
	if (files.length > MAX_CONFIG_FILES) {
		throw new PluginCodegenError(
			'repository_config_invalid',
			`Repository alias discovery exceeds the ${MAX_CONFIG_FILES}-file safety limit`
		);
	}
	return files.sort();
}

async function readTrackedConfigFiles(workspaceRoot: string): Promise<string[] | undefined> {
	try {
		await lstat(join(workspaceRoot, '.git'));
	} catch (cause) {
		if (isFileSystemError(cause, 'ENOENT')) return undefined;
		throw cause;
	}

	let output: string;
	try {
		output = execFileSync(
			'git',
			[
				'-C',
				workspaceRoot,
				'ls-files',
				'-z',
				'--',
				'package.json',
				'tsconfig*.json',
				'apps',
				'packages',
			],
			{
				encoding: 'utf8',
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				stdio: ['ignore', 'pipe', 'ignore'],
			}
		);
	} catch (cause) {
		throw new PluginCodegenError(
			'repository_config_invalid',
			'Cannot build a bounded tracked repository configuration inventory',
			[],
			{ cause }
		);
	}
	return output
		.split('\0')
		.filter((path) => path.length > 0 && isAliasConfig(path))
		.map((path) => resolve(workspaceRoot, ...path.split('/')));
}

async function readWorkspaceConfigFilesWithoutGit(workspaceRoot: string): Promise<string[]> {
	const workspaceDirectories = [workspaceRoot];
	for (const group of ['apps', 'packages']) {
		let entries;
		try {
			entries = await readdir(join(workspaceRoot, group), { withFileTypes: true });
		} catch (cause) {
			if (isFileSystemError(cause, 'ENOENT')) continue;
			throw cause;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) workspaceDirectories.push(join(workspaceRoot, group, entry.name));
		}
	}
	if (workspaceDirectories.length > MAX_WORKSPACE_DIRECTORIES) {
		throw new PluginCodegenError(
			'repository_config_invalid',
			`Repository contains more than ${MAX_WORKSPACE_DIRECTORIES} workspace directories`
		);
	}

	const files: string[] = [];
	for (const directory of workspaceDirectories) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isFile() && isAliasConfig(entry.name)) files.push(join(directory, entry.name));
		}
	}
	return files;
}

function isAliasConfig(path: string): boolean {
	const filename = basename(path);
	return (
		filename === 'package.json' ||
		/^tsconfig(?:\.[^.]+)?\.json$/.test(filename) ||
		/^(?:nuxt|vite|vitest)\.config\.(?:cjs|cts|js|mjs|mts|ts)$/.test(filename)
	);
}

function parseJsonConfig(path: string, source: string): unknown {
	const parsed = ts.parseConfigFileTextToJson(path, source);
	if (parsed.error)
		throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
	return parsed.config as unknown;
}

function parseSourceConfig(path: string, source: string): ts.SourceFile {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const diagnostics =
		(sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
			.parseDiagnostics ?? [];
	if (diagnostics.length > 0) {
		throw new Error(ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, '\n'));
	}
	return sourceFile;
}

function collectPackageAliases(value: unknown, aliases: RepositoryModuleAlias[]): void {
	if (!isRecord(value)) throw new Error('package.json root must be an object');
	if (isRecord(value['imports'])) {
		for (const [specifierPattern, target] of Object.entries(value['imports'])) {
			for (const targetPattern of collectStringLeaves(target)) {
				aliases.push({ specifierPattern, targetPattern });
			}
		}
	}
	for (const dependencyField of ['dependencies', 'optionalDependencies'] as const) {
		const dependencies = value[dependencyField];
		if (!isRecord(dependencies)) continue;
		for (const [specifierPattern, target] of Object.entries(dependencies)) {
			if (typeof target === 'string' && target.startsWith('npm:')) {
				aliases.push({ specifierPattern, targetPattern: target.slice('npm:'.length) });
			}
		}
	}
}

function collectTypeScriptAliases(value: unknown, aliases: RepositoryModuleAlias[]): void {
	if (!isRecord(value) || !isRecord(value['compilerOptions'])) return;
	const paths = value['compilerOptions']['paths'];
	if (!isRecord(paths)) return;
	for (const [specifierPattern, targets] of Object.entries(paths)) {
		if (!Array.isArray(targets)) continue;
		for (const targetPattern of targets) {
			if (typeof targetPattern === 'string') aliases.push({ specifierPattern, targetPattern });
		}
	}
}

function collectFrameworkAliases(
	sourceFile: ts.SourceFile,
	aliases: RepositoryModuleAlias[]
): void {
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAssignment(node) && readPropertyName(node.name) === 'alias') {
			collectFrameworkAliasValue(node.initializer, aliases);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

function collectFrameworkAliasValue(value: ts.Expression, aliases: RepositoryModuleAlias[]): void {
	if (ts.isObjectLiteralExpression(value)) {
		for (const property of value.properties) {
			if (!ts.isPropertyAssignment(property)) continue;
			const specifierPattern = readPropertyName(property.name);
			const targetPattern = readStaticString(property.initializer);
			if (specifierPattern !== undefined && targetPattern !== undefined) {
				aliases.push({ specifierPattern, targetPattern });
			}
		}
		return;
	}
	if (!ts.isArrayLiteralExpression(value)) return;
	for (const element of value.elements) {
		if (!ts.isObjectLiteralExpression(element)) continue;
		const find = readUniqueObjectProperty(element, 'find');
		const replacement = readUniqueObjectProperty(element, 'replacement');
		const specifierPattern = find && readStaticString(find.initializer);
		const targetPattern = replacement && readStaticString(replacement.initializer);
		if (specifierPattern !== undefined && targetPattern !== undefined) {
			aliases.push({ specifierPattern, targetPattern });
		}
	}
}

function readUniqueObjectProperty(
	object: ts.ObjectLiteralExpression,
	name: string
): ts.PropertyAssignment | undefined {
	const properties = object.properties.filter(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) && readPropertyName(property.name) === name
	);
	return properties.length === 1 ? properties[0] : undefined;
}

function readPropertyName(name: ts.PropertyName): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
		? name.text
		: undefined;
}

function readStaticString(value: ts.Expression): string | undefined {
	return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
		? value.text
		: undefined;
}

function collectStringLeaves(value: unknown): readonly string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
	if (isRecord(value)) return Object.values(value).flatMap(collectStringLeaves);
	return [];
}

function matchAlias(pattern: string, specifier: string): string | undefined {
	const wildcardIndex = pattern.indexOf('*');
	if (wildcardIndex < 0) return pattern === specifier ? '' : undefined;
	const prefix = pattern.slice(0, wildcardIndex);
	const suffix = pattern.slice(wildcardIndex + 1);
	return specifier.startsWith(prefix) && specifier.endsWith(suffix)
		? specifier.slice(prefix.length, specifier.length - suffix.length)
		: undefined;
}

function targetReferencesPackage(target: string, packageName: string): boolean {
	const normalized = target.replaceAll('\\', '/');
	return (
		normalized === packageName ||
		normalized.startsWith(`${packageName}/`) ||
		normalized.startsWith(`${packageName}@`) ||
		normalized.includes(`/node_modules/${packageName}/`) ||
		normalized.endsWith(`/node_modules/${packageName}`)
	);
}

async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
	const file = await open(path, 'r');
	try {
		const size = (await file.stat()).size;
		if (size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
		const buffer = Buffer.allocUnsafe(Math.min(size + 1, maxBytes + 1));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
		return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
	} finally {
		await file.close();
	}
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
