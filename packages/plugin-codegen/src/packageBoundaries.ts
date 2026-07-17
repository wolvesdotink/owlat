import { extname, relative, sep } from 'node:path';
import { parse as parseVueSfc } from '@vue/compiler-sfc';
import ts from 'typescript';
import {
	listRepositoryFiles,
	readBoundedRepositoryUtf8File,
	Utf8ByteBudget,
} from './boundedRepository';
import { PluginCodegenError } from './errors';
import {
	createRepositoryPackageMatcher,
	readRepositoryModuleAliases,
	type RepositoryModuleAlias,
	type RepositoryPackageMatcher,
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
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const GENERATED_COMPOSITION_FILES = new Set([
	'apps/api/convex/plugins/plugins.generated.ts',
	'apps/api/convex/plugins/components.generated.ts',
	'apps/web/app/plugins/plugin-composition.generated.ts',
	'apps/api/convex/plugins/sendTransportCatalog.generated.ts',
	'apps/api/convex/plugins/sendTransportModules.generated.ts',
	'apps/api/convex/plugins/agentStepCatalog.generated.ts',
	'apps/api/convex/plugins/agentStepModules.generated.ts',
	'apps/api/convex/plugins/draftStrategyCatalog.generated.ts',
	'apps/api/convex/plugins/draftStrategyModules.generated.ts',
	'apps/api/convex/plugins/autonomyGateCatalog.generated.ts',
	'apps/api/convex/plugins/autonomyGateModules.generated.ts',
	'apps/api/convex/plugins/automationTriggerCatalog.generated.ts',
	'apps/api/convex/plugins/automationTriggerModules.generated.ts',
	'apps/api/convex/plugins/automationStepCatalog.generated.ts',
	'apps/api/convex/plugins/automationStepModules.generated.ts',
	'apps/api/convex/plugins/automationConditionCatalog.generated.ts',
	'apps/api/convex/plugins/automationConditionModules.generated.ts',
	'apps/api/convex/plugins/cronCatalog.generated.ts',
	'apps/api/convex/plugins/cronModules.generated.ts',
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
	const repositoryFiles = await listRepositoryFiles(workspaceRoot);
	const aliases = await readRepositoryModuleAliases(workspaceRoot, repositoryFiles);
	const scan = createBoundaryScan(packageNames, aliases);
	const files = repositoryFiles.filter((file) => {
		const relativeFile = normalizePath(relative(workspaceRoot, file));
		return (
			(relativeFile.startsWith('apps/') || relativeFile.startsWith('packages/')) &&
			isPluginBoundarySourceFile(file)
		);
	});
	const findings: DirectPluginImport[] = [];
	const sourceBudget = new Utf8ByteBudget(MAX_TOTAL_SOURCE_BYTES);
	for (const file of files) {
		const relativeFile = normalizePath(relative(workspaceRoot, file));
		if (GENERATED_COMPOSITION_FILES.has(relativeFile)) continue;
		let source: string;
		try {
			source = await readBoundedRepositoryUtf8File(workspaceRoot, file, MAX_SOURCE_BYTES);
		} catch (cause) {
			throw sourceInvalid(relativeFile, cause);
		}
		if (!sourceBudget.consume(source)) {
			throw new PluginCodegenError(
				'repository_inventory_invalid',
				`Repository source scan exceeds the ${MAX_TOTAL_SOURCE_BYTES}-byte safety limit`
			);
		}
		findings.push(...findDirectPluginImportsWithScan(source, relativeFile, scan));
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
	return findDirectPluginImportsWithScan(source, file, createBoundaryScan(packageNames, aliases));
}

const MAX_BOUNDARY_FINDINGS = 1024;

interface BoundaryScan {
	readonly packageMatcher: RepositoryPackageMatcher;
	findingCount: number;
}

function createBoundaryScan(
	packageNames: readonly string[],
	aliases: readonly RepositoryModuleAlias[]
): BoundaryScan {
	return {
		packageMatcher: createRepositoryPackageMatcher(packageNames, aliases),
		findingCount: 0,
	};
}

function findDirectPluginImportsWithScan(
	source: string,
	file: string,
	scan: BoundaryScan
): readonly DirectPluginImport[] {
	const extracted =
		extname(file) === '.vue'
			? extractVueDependencies(source, file)
			: { scripts: [source], externalSpecifiers: [] };
	const findings: DirectPluginImport[] = [];
	for (const packageSpecifier of extracted.externalSpecifiers) {
		if (scan.packageMatcher(packageSpecifier, file))
			addFinding(scan, findings, file, packageSpecifier);
	}
	for (const scriptSource of extracted.scripts) {
		const sourceFile = ts.createSourceFile(file, scriptSource, ts.ScriptTarget.Latest, true);
		const diagnostics = readParseDiagnostics(sourceFile);
		if (diagnostics.length > 0) throw sourceInvalid(file);
		const moduleLoaders = findModuleLoaderBindings(sourceFile);
		const visit = (node: ts.Node): void => {
			const packageSpecifier = readModuleSpecifier(node, moduleLoaders);
			if (packageSpecifier && scan.packageMatcher(packageSpecifier, file)) {
				addFinding(scan, findings, file, packageSpecifier);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return findings;
}

function addFinding(
	scan: BoundaryScan,
	findings: DirectPluginImport[],
	file: string,
	packageSpecifier: string
): void {
	if (scan.findingCount >= MAX_BOUNDARY_FINDINGS) {
		throw new PluginCodegenError(
			'repository_inventory_invalid',
			`Plugin boundary scan exceeds the ${MAX_BOUNDARY_FINDINGS}-finding safety limit`,
			[file]
		);
	}
	scan.findingCount += 1;
	findings.push({ file, packageSpecifier });
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
	const collectCommonJsBindings = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			if (isNodeModuleLoadCall(node.initializer)) {
				if (ts.isIdentifier(node.name)) moduleNamespaces.add(node.name.text);
				if (ts.isObjectBindingPattern(node.name)) {
					for (const element of node.name.elements) {
						if (
							ts.isIdentifier(element.name) &&
							readPropertyName(element.propertyName ?? element.name) === 'createRequire'
						) {
							createRequireFactories.add(element.name.text);
						}
					}
				}
			}
			if (
				ts.isIdentifier(node.name) &&
				isCreateRequireFactoryReference(node.initializer, moduleNamespaces)
			) {
				createRequireFactories.add(node.name.text);
			}
		}
		ts.forEachChild(node, collectCommonJsBindings);
	};
	collectCommonJsBindings(sourceFile);

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
	if (isCommonJsModuleRequire(expression)) return true;
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
	return isCreateRequireFactoryReference(factory, moduleNamespaces);
}

function isCreateRequireFactoryReference(
	expression: ts.Expression,
	moduleNamespaces: ReadonlySet<string>
): boolean {
	if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'createRequire') {
		return (
			(ts.isIdentifier(expression.expression) &&
				moduleNamespaces.has(expression.expression.text)) ||
			isNodeModuleLoadCall(expression.expression)
		);
	}
	return (
		ts.isElementAccessExpression(expression) &&
		expression.argumentExpression !== undefined &&
		readStaticString(expression.argumentExpression) === 'createRequire' &&
		((ts.isIdentifier(expression.expression) && moduleNamespaces.has(expression.expression.text)) ||
			isNodeModuleLoadCall(expression.expression))
	);
}

function isNodeModuleLoadCall(expression: ts.Expression): boolean {
	return (
		ts.isCallExpression(expression) &&
		(isDirectRequire(expression.expression) || isCommonJsModuleRequire(expression.expression)) &&
		expression.arguments.length === 1 &&
		isNodeModuleSpecifier(expression.arguments[0]!)
	);
}

function isDirectRequire(expression: ts.Expression): boolean {
	return ts.isIdentifier(expression) && expression.text === 'require';
}

function isCommonJsModuleRequire(expression: ts.Expression): boolean {
	if (
		ts.isPropertyAccessExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === 'module' &&
		expression.name.text === 'require'
	) {
		return true;
	}
	return (
		ts.isElementAccessExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === 'module' &&
		expression.argumentExpression !== undefined &&
		readStaticString(expression.argumentExpression) === 'require'
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

function readPropertyName(name: ts.PropertyName | ts.BindingName): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
		? name.text
		: undefined;
}

function extractVueDependencies(
	source: string,
	file: string
): { readonly scripts: readonly string[]; readonly externalSpecifiers: readonly string[] } {
	const { descriptor, errors } = parseVueSfc(source, { filename: file });
	if (errors.length > 0) throw sourceInvalid(file);
	return {
		scripts: [descriptor.script?.content, descriptor.scriptSetup?.content].filter(
			(script): script is string => script !== undefined
		),
		externalSpecifiers: [descriptor.script?.src, descriptor.scriptSetup?.src].filter(
			(specifier): specifier is string => specifier !== undefined
		),
	};
}

function readParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
	return (
		(sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
			.parseDiagnostics ?? []
	);
}

function sourceInvalid(file: string, cause?: unknown): PluginCodegenError {
	return new PluginCodegenError(
		'source_invalid',
		`Cannot safely scan repository source ${file}`,
		[file],
		cause === undefined ? undefined : { cause }
	);
}

function normalizePath(path: string): string {
	return sep === '/' ? path : path.split(sep).join('/');
}
