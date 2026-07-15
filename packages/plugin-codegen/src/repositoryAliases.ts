import { basename, dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { readBoundedRepositoryUtf8File, Utf8ByteBudget } from './boundedRepository';
import { PluginCodegenError } from './errors';

export interface RepositoryModuleAlias {
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

export function specifierTargetsConfiguredPackage(
	specifier: string,
	packageNames: readonly string[],
	aliases: readonly RepositoryModuleAlias[]
): boolean {
	const pending = [specifier];
	const visited = new Set<string>();
	let matcherWork = 0;
	while (pending.length > 0) {
		const candidate = pending.pop();
		if (!candidate || visited.has(candidate)) continue;
		if (visited.size >= MAX_ALIAS_CHAIN_CANDIDATES) {
			throw aliasMatcherLimitExceeded();
		}
		visited.add(candidate);
		if (packageNames.some((packageName) => targetReferencesPackage(candidate, packageName))) {
			return true;
		}
		for (const alias of aliases) {
			matcherWork += 1;
			if (matcherWork > MAX_ALIAS_MATCHER_WORK) throw aliasMatcherLimitExceeded();
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
				addAlias(aliases, { specifierPattern, targetPattern });
			}
		}
	}
	for (const dependencyField of ['dependencies', 'optionalDependencies'] as const) {
		const dependencies = value[dependencyField];
		if (!isRecord(dependencies)) continue;
		for (const [specifierPattern, target] of Object.entries(dependencies)) {
			if (typeof target === 'string' && target.startsWith('npm:')) {
				addAlias(aliases, {
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
				addAlias(aliases, { specifierPattern, targetPattern });
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

interface FrameworkStaticValues {
	readonly configDirectory: string;
	readonly constants: ReadonlyMap<string, ts.Expression>;
	readonly pathResolveBindings: ReadonlySet<string>;
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
			addAlias(aliases, { specifierPattern, targetPattern });
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
		const specifierPattern = readFrameworkAliasFind(properties.find.initializer, staticValues);
		const targetPattern = readFrameworkStaticString(
			properties.replacement.initializer,
			staticValues
		);
		addAlias(aliases, { specifierPattern, targetPattern });
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

function readFrameworkAliasFind(value: ts.Expression, staticValues: FrameworkStaticValues): string {
	if (!ts.isRegularExpressionLiteral(value)) {
		return readFrameworkStaticString(value, staticValues);
	}
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

function readFrameworkStaticValues(sourceFile: ts.SourceFile): FrameworkStaticValues {
	const bindingCounts = new Map<string, number>();
	const constants = new Map<string, ts.Expression>();
	const pathResolveCandidates = new Set<string>();
	const countBinding = (name: string): void => {
		bindingCounts.set(name, (bindingCounts.get(name) ?? 0) + 1);
	};
	const countBindingName = (name: ts.BindingName): void => {
		if (ts.isIdentifier(name)) {
			countBinding(name.text);
			return;
		}
		for (const element of name.elements) {
			if (!ts.isOmittedExpression(element)) countBindingName(element.name);
		}
	};

	const visitBindings = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node)) countBindingName(node.name);
		else if (ts.isParameter(node)) countBindingName(node.name);
		else if (
			(ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node) ||
				ts.isEnumDeclaration(node)) &&
			node.name
		) {
			countBinding(node.name.text);
		} else if (ts.isImportClause(node)) {
			if (node.name) countBinding(node.name.text);
		} else if (ts.isNamespaceImport(node)) {
			countBinding(node.name.text);
		} else if (ts.isImportSpecifier(node)) {
			countBinding(node.name.text);
		}
		ts.forEachChild(node, visitBindings);
	};
	visitBindings(sourceFile);

	for (const statement of sourceFile.statements) {
		if (
			ts.isVariableStatement(statement) &&
			(statement.declarationList.flags & ts.NodeFlags.Const) !== 0
		) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.initializer) {
					constants.set(declaration.name.text, declaration.initializer);
				}
			}
		}
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			['node:path', 'path'].includes(statement.moduleSpecifier.text) &&
			statement.importClause?.namedBindings &&
			ts.isNamedImports(statement.importClause.namedBindings)
		) {
			for (const element of statement.importClause.namedBindings.elements) {
				if ((element.propertyName ?? element.name).text === 'resolve') {
					pathResolveCandidates.add(element.name.text);
				}
			}
		}
	}

	return {
		configDirectory: dirname(sourceFile.fileName),
		constants: new Map([...constants].filter(([name]) => bindingCounts.get(name) === 1)),
		pathResolveBindings: new Set(
			[...pathResolveCandidates].filter((name) => bindingCounts.get(name) === 1)
		),
	};
}

function readFrameworkStaticString(
	value: ts.Expression,
	staticValues: FrameworkStaticValues,
	resolving = new Set<string>()
): string {
	const expression = unwrapTypeOnlyExpression(value);
	const literal = readStaticString(expression);
	if (literal !== undefined) return literal;
	if (ts.isIdentifier(expression)) {
		const initializer = staticValues.constants.get(expression.text);
		if (!initializer || resolving.has(expression.text)) {
			throw new Error('Framework alias values must be statically resolvable constants');
		}
		const nextResolving = new Set(resolving).add(expression.text);
		return readFrameworkStaticString(initializer, staticValues, nextResolving);
	}
	if (
		ts.isCallExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		staticValues.pathResolveBindings.has(expression.expression.text) &&
		expression.arguments.length >= 1 &&
		ts.isIdentifier(unwrapTypeOnlyExpression(expression.arguments[0]!)) &&
		unwrapTypeOnlyExpression(expression.arguments[0]!).getText() === '__dirname'
	) {
		const parts = expression.arguments
			.slice(1)
			.map((argument) => readFrameworkStaticString(argument, staticValues, resolving));
		return resolve(staticValues.configDirectory, ...parts);
	}
	throw new Error('Framework alias values must be static strings or safe path.resolve calls');
}

function unwrapTypeOnlyExpression(value: ts.Expression): ts.Expression {
	let expression = value;
	while (
		ts.isParenthesizedExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	) {
		expression = expression.expression;
	}
	return expression;
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

function addAlias(aliases: RepositoryModuleAlias[], alias: RepositoryModuleAlias): void {
	if (aliases.length >= MAX_ALIASES) {
		throw new Error(`Repository alias discovery exceeds the ${MAX_ALIASES}-alias safety limit`);
	}
	aliases.push(alias);
}

function aliasMatcherLimitExceeded(): PluginCodegenError {
	return new PluginCodegenError(
		'repository_config_invalid',
		`Repository alias matching exceeds its ${MAX_ALIAS_MATCHER_WORK}-comparison or ${MAX_ALIAS_CHAIN_CANDIDATES}-candidate safety limit`
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
