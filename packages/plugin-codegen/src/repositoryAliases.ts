import { basename, relative, sep } from 'node:path';
import ts from 'typescript';
import { readBoundedRepositoryUtf8File, Utf8ByteBudget } from './boundedRepository';
import { PluginCodegenError } from './errors';
import {
	readFrameworkAliasFind,
	readFrameworkStaticString,
	readFrameworkStaticValues,
	type FrameworkStaticValues,
} from './frameworkAliasEvaluator';

export interface RepositoryModuleAlias {
	readonly matchKind: 'exact' | 'prefix' | 'wildcard';
	readonly specifierPattern: string;
	readonly targetPattern: string;
}

const MAX_CONFIG_FILES = 512;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOTAL_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_ALIASES = 1024;
const MAX_ALIAS_MATCHER_WORK = 8 * MAX_ALIASES;
const MAX_ALIAS_CHAIN_CANDIDATES = 64;

export async function readRepositoryModuleAliases(
	workspaceRoot: string,
	repositoryFiles: readonly string[]
): Promise<readonly RepositoryModuleAlias[]> {
	const aliases: RepositoryModuleAlias[] = [];
	const configBudget = new Utf8ByteBudget(MAX_TOTAL_CONFIG_BYTES);
	const configFiles = findConfigFiles(workspaceRoot, repositoryFiles);
	for (const path of configFiles) {
		let source: string;
		try {
			source = await readBoundedRepositoryUtf8File(workspaceRoot, path, MAX_CONFIG_BYTES);
			if (!configBudget.consume(source)) {
				throw new Error(
					`Repository alias configuration exceeds ${MAX_TOTAL_CONFIG_BYTES} aggregate bytes`
				);
			}
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

export type RepositoryPackageMatcher = (specifier: string, sourceFile?: string) => boolean;

export function createRepositoryPackageMatcher(
	packageNames: readonly string[],
	aliases: readonly RepositoryModuleAlias[]
): RepositoryPackageMatcher {
	let matcherWork = 0;
	return (specifier: string, sourceFile?: string): boolean => {
		const pending = [specifier];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const candidate = pending.pop();
			if (!candidate || visited.has(candidate)) continue;
			if (visited.size >= MAX_ALIAS_CHAIN_CANDIDATES) {
				throw aliasMatcherLimitExceeded(sourceFile);
			}
			visited.add(candidate);
			if (packageNames.some((packageName) => targetReferencesPackage(candidate, packageName))) {
				return true;
			}
			for (const alias of aliases) {
				matcherWork += 1;
				if (matcherWork > MAX_ALIAS_MATCHER_WORK) {
					throw aliasMatcherLimitExceeded(sourceFile);
				}
				const target = resolveAlias(alias, candidate);
				if (target !== undefined) pending.push(target);
			}
		}
		return false;
	};
}

function findConfigFiles(
	workspaceRoot: string,
	repositoryFiles: readonly string[]
): readonly string[] {
	const files = repositoryFiles.filter((path) => isRelevantAliasConfig(workspaceRoot, path));
	if (files.length > MAX_CONFIG_FILES) {
		throw new PluginCodegenError(
			'repository_config_invalid',
			`Repository alias discovery exceeds the ${MAX_CONFIG_FILES}-file safety limit`
		);
	}
	return files.sort();
}

function isRelevantAliasConfig(workspaceRoot: string, path: string): boolean {
	const filename = basename(path);
	const isConfig =
		filename === 'package.json' ||
		/^tsconfig(?:\.[^.]+)?\.json$/.test(filename) ||
		/^(?:nuxt|vite|vitest)\.config\.(?:cjs|cts|js|mjs|mts|ts)$/.test(filename);
	if (!isConfig) return false;
	const parts = relative(workspaceRoot, path).split(sep);
	return parts.length === 1 || (parts.length === 3 && ['apps', 'packages'].includes(parts[0]!));
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
			visitStringLeaves(target, (targetPattern) =>
				addAlias(aliases, {
					matchKind: specifierPattern.includes('*') ? 'wildcard' : 'exact',
					specifierPattern,
					targetPattern,
				})
			);
		}
	}
	for (const dependencyField of ['dependencies', 'optionalDependencies'] as const) {
		const dependencies = value[dependencyField];
		if (!isRecord(dependencies)) continue;
		for (const [specifierPattern, target] of Object.entries(dependencies)) {
			if (typeof target === 'string' && target.startsWith('npm:')) {
				addAlias(aliases, {
					matchKind: 'prefix',
					specifierPattern,
					targetPattern: target.slice('npm:'.length),
				});
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
			if (typeof targetPattern === 'string') {
				addAlias(aliases, {
					matchKind: specifierPattern.includes('*') ? 'wildcard' : 'exact',
					specifierPattern,
					targetPattern,
				});
			}
		}
	}
}

function collectFrameworkAliases(
	sourceFile: ts.SourceFile,
	aliases: RepositoryModuleAlias[]
): void {
	const staticValues = readFrameworkStaticValues(sourceFile);
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAssignment(node) && readPropertyName(node.name) === 'alias') {
			collectFrameworkAliasValue(node.initializer, aliases, staticValues);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

function collectFrameworkAliasValue(
	value: ts.Expression,
	aliases: RepositoryModuleAlias[],
	staticValues: FrameworkStaticValues
): void {
	if (ts.isObjectLiteralExpression(value)) {
		for (const property of value.properties) {
			if (!ts.isPropertyAssignment(property)) {
				throw new Error('Framework object aliases must contain only data properties');
			}
			const specifierPattern = readPropertyName(property.name);
			if (specifierPattern === undefined) {
				throw new Error('Framework object alias names must be static property names');
			}
			const targetPattern = readFrameworkStaticString(property.initializer, staticValues);
			addAlias(aliases, { matchKind: 'prefix', specifierPattern, targetPattern });
		}
		return;
	}
	if (!ts.isArrayLiteralExpression(value)) {
		throw new Error('Framework aliases must be an object or an array of alias rules');
	}
	for (const element of value.elements) {
		if (!ts.isObjectLiteralExpression(element)) {
			throw new Error('Framework alias arrays must contain only object rules');
		}
		const properties = readFrameworkAliasRule(element);
		const find = readFrameworkAliasFind(properties.find.initializer, staticValues);
		const targetPattern = readFrameworkStaticString(
			properties.replacement.initializer,
			staticValues
		);
		addAlias(aliases, { ...find, targetPattern });
	}
}

function readFrameworkAliasRule(object: ts.ObjectLiteralExpression): {
	readonly find: ts.PropertyAssignment;
	readonly replacement: ts.PropertyAssignment;
} {
	let find: ts.PropertyAssignment | undefined;
	let replacement: ts.PropertyAssignment | undefined;
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) {
			throw new Error('Framework alias rules must contain only data properties');
		}
		const name = readPropertyName(property.name);
		if (name !== 'find' && name !== 'replacement') {
			throw new Error('Framework alias rules may contain only find and replacement');
		}
		if (name === 'find') {
			if (find) throw new Error('Framework alias rules must define find exactly once');
			find = property;
		} else {
			if (replacement) {
				throw new Error('Framework alias rules must define replacement exactly once');
			}
			replacement = property;
		}
	}
	if (!find || !replacement) {
		throw new Error('Framework alias rules require one find and one replacement');
	}
	return { find, replacement };
}

function readPropertyName(name: ts.PropertyName): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
		? name.text
		: undefined;
}

function visitStringLeaves(value: unknown, visit: (value: string) => void): void {
	const pending = [value];
	while (pending.length > 0) {
		const candidate = pending.pop();
		if (typeof candidate === 'string') visit(candidate);
		else if (Array.isArray(candidate)) pending.push(...candidate);
		else if (isRecord(candidate)) pending.push(...Object.values(candidate));
	}
}

function resolveAlias(alias: RepositoryModuleAlias, specifier: string): string | undefined {
	const { specifierPattern: pattern, targetPattern } = alias;
	if (alias.matchKind === 'exact') return pattern === specifier ? targetPattern : undefined;
	if (alias.matchKind === 'prefix') {
		if (pattern === specifier) return targetPattern;
		const subpathStart = pattern.endsWith('/') ? pattern : `${pattern}/`;
		return specifier.startsWith(subpathStart)
			? `${targetPattern}${specifier.slice(pattern.length)}`
			: undefined;
	}
	const wildcardIndex = pattern.indexOf('*');
	const prefix = pattern.slice(0, wildcardIndex);
	const suffix = pattern.slice(wildcardIndex + 1);
	if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
	const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
	return targetPattern.replaceAll('*', wildcard);
}

function addAlias(aliases: RepositoryModuleAlias[], alias: RepositoryModuleAlias): void {
	if (aliases.length >= MAX_ALIASES) {
		throw new Error(`Repository alias discovery exceeds the ${MAX_ALIASES}-alias safety limit`);
	}
	if (alias.matchKind === 'wildcard' && alias.specifierPattern.split('*').length - 1 !== 1) {
		throw new Error('Repository wildcard aliases must contain exactly one wildcard');
	}
	aliases.push(alias);
}

function aliasMatcherLimitExceeded(sourceFile?: string): PluginCodegenError {
	return new PluginCodegenError(
		'repository_config_invalid',
		`Repository alias scan exceeds its ${MAX_ALIAS_MATCHER_WORK}-comparison or ${MAX_ALIAS_CHAIN_CANDIDATES}-candidate safety limit`,
		sourceFile ? [sourceFile] : []
	);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
