import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { PluginCodegenError } from './errors';
import {
	readRepositoryModuleAliases,
	specifierTargetsConfiguredPackage,
	type RepositoryModuleAlias,
} from './repositoryAliases';

const SOURCE_EXTENSIONS = new Set([
	'.cjs',
	'.cts',
	'.js',
	'.jsx',
	'.mjs',
	'.mts',
	'.ts',
	'.tsx',
	'.vue',
]);
const SKIPPED_SOURCE_DIRECTORIES = new Set([
	'.nuxt',
	'.output',
	'.turbo',
	'coverage',
	'dist',
	'node_modules',
	'target',
]);
const GENERATED_COMPOSITION_FILES = new Set([
	'apps/api/convex/plugins/plugins.generated.ts',
	'apps/web/app/plugins/plugin-composition.generated.ts',
]);

export interface DirectPluginImport {
	readonly file: string;
	readonly packageSpecifier: string;
}

export function isPluginBoundarySourceFile(file: string): boolean {
	return SOURCE_EXTENSIONS.has(extname(file));
}

export async function checkDirectPluginImports(
	workspaceRoot: string,
	packageNames: readonly string[]
): Promise<void> {
	if (packageNames.length === 0) return;
	const [files, aliases] = await Promise.all([
		listSourceFiles(workspaceRoot),
		readRepositoryModuleAliases(workspaceRoot),
	]);
	const findings: DirectPluginImport[] = [];
	for (const file of files) {
		const relativeFile = normalizePath(relative(workspaceRoot, file));
		if (GENERATED_COMPOSITION_FILES.has(relativeFile)) continue;
		const source = await readFile(file, 'utf8');
		findings.push(...findDirectPluginImports(source, relativeFile, packageNames, aliases));
	}

	if (findings.length > 0) {
		const details = findings
			.map((finding) => `${finding.file}: imports ${finding.packageSpecifier}`)
			.sort();
		throw new PluginCodegenError(
			'direct_plugin_import',
			'Core modules must consume bundled plugins through the generated composition point',
			details
		);
	}
}

export function findDirectPluginImports(
	source: string,
	file: string,
	packageNames: readonly string[],
	aliases: readonly RepositoryModuleAlias[] = []
): readonly DirectPluginImport[] {
	const scriptSources = extname(file) === '.vue' ? extractVueScripts(source) : [source];
	const findings: DirectPluginImport[] = [];
	for (const scriptSource of scriptSources) {
		const sourceFile = ts.createSourceFile(file, scriptSource, ts.ScriptTarget.Latest, true);
		const moduleLoaders = findModuleLoaderBindings(sourceFile);
		const visit = (node: ts.Node): void => {
			const packageSpecifier = readModuleSpecifier(node, moduleLoaders);
			if (
				packageSpecifier &&
				specifierTargetsConfiguredPackage(packageSpecifier, packageNames, aliases)
			) {
				findings.push({ file, packageSpecifier });
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return findings;
}

interface ModuleLoaderBindings {
	readonly createRequireFactories: ReadonlySet<string>;
	readonly moduleNamespaces: ReadonlySet<string>;
	readonly requireFunctions: ReadonlySet<string>;
}

function readModuleSpecifier(
	node: ts.Node,
	moduleLoaders: ModuleLoaderBindings
): string | undefined {
	if (
		(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
		node.moduleSpecifier &&
		ts.isStringLiteral(node.moduleSpecifier)
	) {
		return node.moduleSpecifier.text;
	}
	if (
		ts.isImportEqualsDeclaration(node) &&
		ts.isExternalModuleReference(node.moduleReference) &&
		node.moduleReference.expression
	) {
		return readStaticString(node.moduleReference.expression);
	}
	if (ts.isCallExpression(node) && node.arguments.length > 0) {
		const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
		const isRequire = isModuleLoaderCall(node.expression, moduleLoaders);
		const argument = node.arguments[0];
		if ((isDynamicImport || isRequire) && argument) {
			return readStaticString(argument);
		}
	}
	if (
		ts.isImportTypeNode(node) &&
		ts.isLiteralTypeNode(node.argument) &&
		ts.isStringLiteral(node.argument.literal)
	) {
		return node.argument.literal.text;
	}
	return undefined;
}

function findModuleLoaderBindings(sourceFile: ts.SourceFile): ModuleLoaderBindings {
	const createRequireFactories = new Set<string>();
	const moduleNamespaces = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !isNodeModuleSpecifier(statement.moduleSpecifier)) {
			continue;
		}
		const imports = statement.importClause;
		if (!imports) continue;
		if (imports.name) moduleNamespaces.add(imports.name.text);
		if (imports.namedBindings && ts.isNamespaceImport(imports.namedBindings)) {
			moduleNamespaces.add(imports.namedBindings.name.text);
		}
		if (imports.namedBindings && ts.isNamedImports(imports.namedBindings)) {
			for (const element of imports.namedBindings.elements) {
				if ((element.propertyName ?? element.name).text === 'createRequire') {
					createRequireFactories.add(element.name.text);
				}
			}
		}
	}

	const requireFunctions = new Set(['require']);
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			isCreateRequireCall(node.initializer, createRequireFactories, moduleNamespaces)
		) {
			requireFunctions.add(node.name.text);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left) &&
			isCreateRequireCall(node.right, createRequireFactories, moduleNamespaces)
		) {
			requireFunctions.add(node.left.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	return { createRequireFactories, moduleNamespaces, requireFunctions };
}

function isModuleLoaderCall(
	expression: ts.LeftHandSideExpression,
	bindings: ModuleLoaderBindings
): boolean {
	if (ts.isIdentifier(expression) && bindings.requireFunctions.has(expression.text)) return true;
	if (
		ts.isPropertyAccessExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === 'Bun' &&
		expression.name.text === 'require'
	) {
		return true;
	}
	if (
		ts.isElementAccessExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === 'Bun' &&
		expression.argumentExpression &&
		readStaticString(expression.argumentExpression) === 'require'
	) {
		return true;
	}
	return isCreateRequireCall(
		expression,
		bindings.createRequireFactories,
		bindings.moduleNamespaces
	);
}

function isCreateRequireCall(
	expression: ts.Expression,
	createRequireFactories: ReadonlySet<string>,
	moduleNamespaces: ReadonlySet<string>
): expression is ts.CallExpression {
	if (!ts.isCallExpression(expression)) return false;
	const factory = expression.expression;
	if (ts.isIdentifier(factory)) return createRequireFactories.has(factory.text);
	return (
		ts.isPropertyAccessExpression(factory) &&
		ts.isIdentifier(factory.expression) &&
		moduleNamespaces.has(factory.expression.text) &&
		factory.name.text === 'createRequire'
	);
}

function isNodeModuleSpecifier(expression: ts.Expression): boolean {
	return (
		ts.isStringLiteral(expression) &&
		(expression.text === 'node:module' || expression.text === 'module')
	);
}

function readStaticString(expression: ts.Expression): string | undefined {
	return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
		? expression.text
		: undefined;
}

function extractVueScripts(source: string): readonly string[] {
	const scripts: string[] = [];
	const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
	for (const match of source.matchAll(scriptPattern)) {
		if (match[1]) scripts.push(match[1]);
	}
	return scripts;
}

async function listSourceFiles(workspaceRoot: string): Promise<readonly string[]> {
	try {
		const output = execFileSync(
			'git',
			['-C', workspaceRoot, 'ls-files', '-z', '--', 'apps', 'packages'],
			{
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
			}
		);
		return output
			.split('\0')
			.filter((file) => file.length > 0 && isPluginBoundarySourceFile(file))
			.map((file) => resolve(workspaceRoot, ...file.split('/')));
	} catch {
		return listSourceFilesWithoutGit(workspaceRoot);
	}
}

async function listSourceFilesWithoutGit(workspaceRoot: string): Promise<readonly string[]> {
	const files: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_SOURCE_DIRECTORIES.has(entry.name)) await visit(path);
			} else if (entry.isFile() && isPluginBoundarySourceFile(entry.name)) {
				files.push(path);
			}
		}
	};
	for (const root of ['apps', 'packages']) {
		try {
			await visit(resolve(workspaceRoot, root));
		} catch (cause) {
			if (!isMissingDirectoryError(cause)) throw cause;
		}
	}
	return files;
}

function isMissingDirectoryError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function normalizePath(path: string): string {
	return sep === '/' ? path : path.split(sep).join('/');
}
