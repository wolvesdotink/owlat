import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { PluginCodegenError } from './errors';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx', '.vue']);
const GENERATED_COMPOSITION_FILES = new Set([
	'apps/api/convex/plugins/plugins.generated.ts',
	'apps/web/app/plugins/plugin-composition.generated.ts',
]);

export interface DirectPluginImport {
	readonly file: string;
	readonly packageSpecifier: string;
}

export async function checkDirectPluginImports(
	workspaceRoot: string,
	packageNames: readonly string[]
): Promise<void> {
	if (packageNames.length === 0) return;
	const files = listTrackedSourceFiles(workspaceRoot);
	const findings: DirectPluginImport[] = [];
	for (const file of files) {
		const relativeFile = normalizePath(relative(workspaceRoot, file));
		if (GENERATED_COMPOSITION_FILES.has(relativeFile)) continue;
		const source = await readFile(file, 'utf8');
		findings.push(...findDirectPluginImports(source, relativeFile, packageNames));
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
	packageNames: readonly string[]
): readonly DirectPluginImport[] {
	const scriptSources = extname(file) === '.vue' ? extractVueScripts(source) : [source];
	const findings: DirectPluginImport[] = [];
	for (const scriptSource of scriptSources) {
		const sourceFile = ts.createSourceFile(file, scriptSource, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			const packageSpecifier = readModuleSpecifier(node);
			if (
				packageSpecifier &&
				packageNames.some(
					(packageName) =>
						packageSpecifier === packageName || packageSpecifier.startsWith(`${packageName}/`)
				)
			) {
				findings.push({ file, packageSpecifier });
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return findings;
}

function readModuleSpecifier(node: ts.Node): string | undefined {
	if (
		(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
		node.moduleSpecifier &&
		ts.isStringLiteral(node.moduleSpecifier)
	) {
		return node.moduleSpecifier.text;
	}
	if (ts.isCallExpression(node) && node.arguments.length === 1) {
		const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
		const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
		const argument = node.arguments[0];
		if ((isDynamicImport || isRequire) && argument && ts.isStringLiteral(argument)) {
			return argument.text;
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

function extractVueScripts(source: string): readonly string[] {
	const scripts: string[] = [];
	const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
	for (const match of source.matchAll(scriptPattern)) {
		if (match[1]) scripts.push(match[1]);
	}
	return scripts;
}

function listTrackedSourceFiles(workspaceRoot: string): readonly string[] {
	const output = execFileSync(
		'git',
		['-C', workspaceRoot, 'ls-files', '-z', '--', 'apps', 'packages'],
		{
			encoding: 'utf8',
		}
	);
	return output
		.split('\0')
		.filter((file) => file.length > 0 && SOURCE_EXTENSIONS.has(extname(file)))
		.map((file) => resolve(workspaceRoot, ...file.split('/')));
}

function normalizePath(path: string): string {
	return sep === '/' ? path : path.split(sep).join('/');
}
