import ts from 'typescript';
import { parsePluginPackageName, type PluginPackageName } from '@owlat/plugin-host';
import { PluginCodegenError } from './errors';

export const MAX_PLUGIN_CONFIG_BYTES = 64 * 1024;
const MAX_BUNDLED_PLUGINS = 128;

export interface PluginsConfig {
	readonly bundledPluginPackages: readonly string[];
}

export interface ParsedPluginsConfig {
	readonly bundledPluginPackages: readonly PluginPackageName[];
}

/** Parse the checked-in config as data, without evaluating arbitrary TypeScript. */
export function parsePluginsConfig(
	source: string,
	fileName = 'plugins.config.ts'
): ParsedPluginsConfig {
	if (Buffer.byteLength(source, 'utf8') > MAX_PLUGIN_CONFIG_BYTES) {
		throw configError(`must be no larger than ${MAX_PLUGIN_CONFIG_BYTES} bytes`);
	}

	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	const [parseDiagnostic] =
		(sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
			.parseDiagnostics ?? [];
	if (parseDiagnostic) {
		const location = sourceFile.getLineAndCharacterOfPosition(parseDiagnostic.start ?? 0);
		const detail = ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, ' ');
		throw configError(
			`contains invalid TypeScript syntax at ${location.line + 1}:${location.character + 1}: ${detail}`
		);
	}
	let exportExpression: ts.Expression | undefined;
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
		if (ts.isExportAssignment(statement) && !statement.isExportEquals && !exportExpression) {
			exportExpression = statement.expression;
			continue;
		}
		throw configError('may contain only type imports and one default data export');
	}

	if (!exportExpression) throw configError('must have one default export');
	const configObject = unwrapTypeOnlyExpressions(exportExpression);
	if (!ts.isObjectLiteralExpression(configObject) || configObject.properties.length !== 1) {
		throw configError('default export must be an object containing only bundledPluginPackages');
	}

	const property = configObject.properties[0];
	if (
		!property ||
		!ts.isPropertyAssignment(property) ||
		!isIdentifierNamed(property.name, 'bundledPluginPackages')
	) {
		throw configError('default export must define bundledPluginPackages as a data property');
	}

	const packageArray = unwrapTypeOnlyExpressions(property.initializer);
	if (!ts.isArrayLiteralExpression(packageArray)) {
		throw configError('bundledPluginPackages must be an array of package-name string literals');
	}
	if (packageArray.elements.length > MAX_BUNDLED_PLUGINS) {
		throw configError(`bundledPluginPackages may contain at most ${MAX_BUNDLED_PLUGINS} entries`);
	}

	const packages: PluginPackageName[] = [];
	const seenPackages = new Set<string>();
	for (const [index, element] of packageArray.elements.entries()) {
		if (!ts.isStringLiteral(element)) {
			throw configError(`bundledPluginPackages[${index}] must be a string literal`);
		}
		let packageName: PluginPackageName;
		try {
			packageName = parsePluginPackageName(element.text);
		} catch {
			throw configError(
				`bundledPluginPackages[${index}] must be a lowercase npm package name without a subpath`
			);
		}
		if (seenPackages.has(packageName)) {
			throw configError(`bundledPluginPackages[${index}] duplicates ${packageName}`);
		}
		seenPackages.add(packageName);
		packages.push(packageName);
	}

	return Object.freeze({ bundledPluginPackages: Object.freeze(packages) });
}

function unwrapTypeOnlyExpressions(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function isIdentifierNamed(name: ts.PropertyName, expected: string): boolean {
	return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === expected;
}

function configError(message: string): PluginCodegenError {
	return new PluginCodegenError('config_invalid', `Invalid plugins.config.ts: ${message}`);
}
