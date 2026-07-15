import { basename, relative, sep } from 'node:path';
import ts from 'typescript';
import { readBoundedRepositoryUtf8File } from './boundedRepository';
import { PluginCodegenError } from './errors';

export interface RepositoryModuleAlias {
	readonly specifierPattern: string;
	readonly targetPattern: string;
}

const MAX_CONFIG_FILES = 512;
const MAX_CONFIG_BYTES = 1024 * 1024;

export async function readRepositoryModuleAliases(
	workspaceRoot: string,
	repositoryFiles: readonly string[]
): Promise<readonly RepositoryModuleAlias[]> {
	const aliases: RepositoryModuleAlias[] = [];
	const configFiles = findConfigFiles(workspaceRoot, repositoryFiles);
	for (const path of configFiles) {
		let source: string;
		try {
			source = await readBoundedRepositoryUtf8File(workspaceRoot, path, MAX_CONFIG_BYTES);
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
		const targetPattern = replacement && readStaticString(replacement.initializer);
		if (targetPattern === undefined) continue;
		const specifierPattern = find && readFrameworkAliasFind(find.initializer);
		if (specifierPattern !== undefined) {
			aliases.push({ specifierPattern, targetPattern });
		}
	}
}

function readFrameworkAliasFind(value: ts.Expression): string | undefined {
	const staticString = readStaticString(value);
	if (staticString !== undefined) return staticString;
	if (!ts.isRegularExpressionLiteral(value)) return undefined;
	const match = /^\/(.*)\/([a-z]*)$/.exec(value.text);
	if (!match || match[2] !== '') {
		throw new Error('Framework RegExp aliases must be exact and case-sensitive');
	}
	const body = match[1]!;
	if (!body.startsWith('^') || !body.endsWith('$')) {
		throw new Error('Framework RegExp aliases must anchor one exact module specifier');
	}
	return decodeExactRegExpLiteral(body.slice(1, -1));
}

function decodeExactRegExpLiteral(source: string): string {
	let literal = '';
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (character === '\\') {
			const escaped = source[++index];
			if (!escaped || !/[\\/\-.$^*+?()[\]{}|]/.test(escaped)) {
				throw new Error('Framework RegExp alias contains a non-literal escape');
			}
			literal += escaped;
		} else {
			if (/[.$^*+?()[\]{}|]/.test(character)) {
				throw new Error('Framework RegExp alias must not contain pattern operators');
			}
			literal += character;
		}
	}
	return literal;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
