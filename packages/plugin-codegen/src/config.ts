import ts from 'typescript';
import { PluginCodegenError } from './errors';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_BUNDLED_PLUGINS = 128;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export interface PluginsConfig {
	readonly bundledPluginPackages: readonly string[];
}

/** Parse the checked-in config as data, without evaluating arbitrary TypeScript. */
export function parsePluginsConfig(source: string, fileName = 'plugins.config.ts'): PluginsConfig {
	if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
		throw configError(`must be no larger than ${MAX_CONFIG_BYTES} bytes`);
	}

	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
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

	const packages: string[] = [];
	const seenPackages = new Set<string>();
	for (const [index, element] of packageArray.elements.entries()) {
		if (!ts.isStringLiteral(element)) {
			throw configError(`bundledPluginPackages[${index}] must be a string literal`);
		}
		const packageName = element.text;
		if (!isSafePackageName(packageName)) {
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

export function isSafePackageName(packageName: string): boolean {
	return (
		packageName.length <= 214 &&
		packageName !== '.' &&
		packageName !== '..' &&
		PACKAGE_NAME.test(packageName)
	);
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
